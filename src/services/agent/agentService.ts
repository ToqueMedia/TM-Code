import ToolExecutor, { OpenAIToolDefinition } from './toolExecutor'
import DiffService from './diffService'
import { devServerManager } from '../devServerManager'
import FirebaseAuthService from '../auth/firebaseAuth'
import { ServiceError } from '../../utils/errors'
import { parseSSEStream, createThinkingDetector } from './streamParser'
import { createDiffApprovalPromise, resolveAllPendingDiffApprovals, useChatStore } from '../../stores/chatStore'
import { useBillingStore } from '../../stores/billingStore'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '../../utils/logger'
import { getQueryGuard } from './queryGuard'
import { contentAsText } from './promptValueHelpers'
import {
  hasCommandsInQueue,
  dequeueAllMatching,
  isSlashCommand,
  joinPromptValues,
} from './messageQueue'
import type { PromptValue } from '../../types/messageQueueTypes'
import { StreamingSafeToolPool } from './safeToolPool'
import type { PoolToolResult } from './safeToolPool'
import type { ContentPart } from '../../types/chat'
import type { StreamEvent } from './streamParser'

// === Types ===

/**
 * OpenAI / OpenAI-compatible content parts for multimodal user messages.
 * Re-exported from types/chat.ts as `OpenAIContentPart` for the existing
 * external import paths in usePromptBar / promptValueHelpers.
 *
 * Defined in types/chat.ts so the chatStore layer can construct content
 * parts without importing from a service.
 */
export type OpenAIContentPart = ContentPart

// ── Anthropic Messages API types ──────────────────────────────────────────
// Canonical types live in types/chat.ts (AnthropicContentBlock) to avoid
// duplication between agentService, chatStore, and other consumers.

import type { AnthropicContentBlock } from '../../types/chat'

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

// === Config ===

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'
const MAX_OUTPUT_TOKENS = 32768
// Max auto-continuations when model hits token limit mid-response
const MAX_CONTINUATIONS = 3

// Context compression: percentage-based threshold (like Claude Code's ~83.5%).
// Model context windows vary (128K, 200K, 1M) — percentage adapts automatically.
const COMPRESSION_THRESHOLD_PCT = 0.835 // 83.5% of context window
const DEFAULT_CONTEXT_WINDOW = 131_072  // Conservative fallback (128K)

// Context window is reported by the backend via X-Model-Context-Window header.
// This map is ONLY used as a static fallback if the header is missing (e.g., backend not updated).
// The backend's MODEL_CONTEXT_WINDOWS in proxy.ts is the source of truth.
const MODEL_CONTEXT_WINDOWS_FALLBACK: Record<string, number> = {
  'openrouter/hunter-alpha': 1_000_000,
  'qwen3-coder-plus': 256_000,
  'gpt-4o': 128_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  'gemini-2.5-flash': 1_048_576,
  'deepseek-chat': 131_072,
}
// Minimum recent turns to preserve in full (not compressed).
// Actual value is adaptive: scales with conversation length (min 4, max 12).
const MIN_KEEP_RECENT_TURNS = 4
const MAX_KEEP_RECENT_TURNS = 12

// Layer 1: Microcompaction — keep last N tool results in full, compact older ones.
// A typical turn has 1-3 tool calls; 8 means ~3-4 recent turns have full results.
const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 8
// Maximum files to re-read after compaction for context recovery.
const POST_COMPACTION_REREAD_FILES = 5
// Max chars per re-read file (prevents re-blowing context).
const POST_COMPACTION_FILE_MAX_CHARS = 8000

// === Callbacks ===

export interface AgentCallbacks {
  // Streaming text (token by token)
  onTextDelta: (text: string) => void

  // Streaming reasoning (token by token, collapsible in UI)
  onReasoningDelta: (text: string) => void

  // Tool call detected but still accumulating args
  onToolCallPending: (toolId: string, toolName: string) => void

  // Tool call complete, being executed
  onToolCallStart: (toolId: string, toolName: string, args: Record<string, unknown>) => void

  // Tool executed, result available
  onToolResult: (toolId: string, toolName: string, result: string, isError: boolean) => void

  // Turn completed
  onTurnComplete: (turnNumber: number) => void

  // Loop finished
  onDone: (finalText: string) => void

  // Error
  onError: (error: Error) => void

  // Usage
  onUsageUpdate: (inputTokens: number, outputTokens: number) => void

  // Context was compressed to fit within model limits (optional)
  onContextCompression?: (estimatedTokens: number, compressedTokens: number) => void
}

// === Turn result ===

interface TurnResult {
  textContent: string
  reasoningContent: string
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  finishReason: string
  usage: { promptTokens: number; completionTokens: number } | null
}

// === Service ===

/** Options for creating a lightweight sub-agent. */
export interface LightweightAgentOptions {
  /** Custom tool definitions (subset of tools). If omitted, uses all tools. */
  tools?: OpenAIToolDefinition[]
  /** Maximum turns before stopping. Default: 50. */
  maxTurns?: number
  /** If true, skip diff approval — tool results go directly to LLM. */
  readOnly?: boolean
  /** Parent's abort controller — sub-agent aborts when parent does. */
  abortController?: AbortController
}

class AgentService {
  private static instance: AgentService
  private abortController: AbortController | null = null
  private isRunning = false
  private toolExecutor: ToolExecutor
  private tools: OpenAIToolDefinition[]
  private systemPrompt: string = ''
  /** Request type header — e.g. 'plan' for /plan command to use reasoning model.
   *  Only sent on the FIRST API call of the loop, then auto-cleared.
   *  Subsequent turns (tool results, follow-ups) use the normal model. */
  private requestType: string | null = null
  /** Real prompt token count from the last API response (from usage event). */
  private lastPromptTokens = 0
  /** Context window size (tokens) — updated from API usage if available. */
  private contextWindowSize = DEFAULT_CONTEXT_WINDOW
  /** Files accessed during the current agent session, ordered by recency. */
  private fileAccessLog: Array<{ path: string; action: 'read' | 'modified'; timestamp: number }> = []
  /** Circuit breaker: consecutive LLM summarization failures. After 3, skip LLM and go straight to mechanical. */
  private summarizationFailures = 0
  /** Options for lightweight sub-agents (null for the main singleton). */
  private lightweightOptions: LightweightAgentOptions | null = null
  /** Tracks unique files edited in the current session (for verify enforcement). */
  private filesEditedThisSession: Set<string> = new Set()
  /** Timestamp of the last approved file change — used to filter dev server errors in COMPLETION_BLOCKED. */
  private lastFileChangeTimestamp = 0
  /** Cumulative count of times the pool blocked a tool from starting due to
   *  an in-flight non-concurrency-safe sibling. The "would-have-been-a-race"
   *  metric, surfaced in Settings → Experimental telemetry. Reset per session. */
  private poolConcurrencyConflictsAvoided = 0

  private constructor(options?: LightweightAgentOptions) {
    this.toolExecutor = ToolExecutor.getInstance()
    if (options) {
      this.lightweightOptions = options
      this.tools = options.tools || this.toolExecutor.getToolDefinitions()
      if (options.abortController) {
        this.abortController = options.abortController
      }
    } else {
      this.tools = this.toolExecutor.getToolDefinitions()
    }
  }

  static getInstance(): AgentService {
    if (!AgentService.instance) {
      AgentService.instance = new AgentService()
    }
    return AgentService.instance
  }

  /**
   * Creates a lightweight sub-agent for parallel research tasks.
   * Not a singleton — each call creates a new instance.
   */
  static createLightweight(options: LightweightAgentOptions): AgentService {
    return new AgentService(options)
  }

  setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt
  }

  setRequestType(type: string | null) {
    this.requestType = type
  }

  /**
   * Refreshes the tool definitions (call after MCP tools are registered/changed).
   */
  refreshTools(): void {
    this.tools = this.toolExecutor.getToolDefinitions()
  }

  /**
   * Set the context window size explicitly (e.g., from backend API response).
   * If not called, the service infers from MODEL_CONTEXT_WINDOWS or uses DEFAULT_CONTEXT_WINDOW.
   */
  setContextWindowSize(tokens: number) {
    this.contextWindowSize = tokens
  }

  /**
   * Static fallback: infer context window from model name when backend doesn't report it.
   * The primary mechanism is the X-Model-Context-Window header read in callAPI().
   */
  setContextWindowFromModel(modelName: string) {
    const entries = Object.entries(MODEL_CONTEXT_WINDOWS_FALLBACK)
      .sort((a, b) => b[0].length - a[0].length)

    for (const [prefix, windowSize] of entries) {
      if (modelName.startsWith(prefix)) {
        this.contextWindowSize = windowSize
        return
      }
    }
    this.contextWindowSize = DEFAULT_CONTEXT_WINDOW
  }

  // thinkingEnabledForLoop and currentTurnInLoop removed — thinking is now
  // user-controlled via useSettingsStore.thinkingEnabled, not agent-controlled.
  /** Whether reasoning_content should be preserved in conversation history between turns.
   *  Set per-loop from the model profile. Default: false (strip reasoning). */
  private preserveReasoningBetweenTurns = false

  // enableThinkingForLoop removed — thinking is user-controlled via Settings.


  /**
   * Build the JSON request body for the chat completion API,
   * including model-specific sampling and thinking parameters.
   */
  /**
   * Build the Anthropic Messages API request body.
   *
   * Format: { system, messages, tools, max_tokens, stream, temperature, ... }
   * The system prompt is a top-level field (not in the messages array).
   * Tools use { name, description, input_schema } (not OpenAI's function wrapper).
   * The backend converts this to OpenAI format for DashScope internally.
   */
  private async buildRequestBody(messages: AnthropicMessage[]): Promise<Record<string, unknown>> {
    try {
      const { getProfileForPlan, buildSamplingParams, buildThinkingParam } = await import('./modelProfiles')
      const { useBillingStore } = await import('../../stores/billingStore')
      const { useSettingsStore } = await import('../../stores/settingsStore')
      const plan = useBillingStore.getState().plan
      const profile = getProfileForPlan(plan)

      // Thinking is controlled by the user in Settings — not by the agent.
      // Qwen3 has thinking ON by default (official docs). The user can
      // toggle it off for faster, more direct responses.
      const isThinking = useSettingsStore.getState().thinkingEnabled

      // Filter tools based on model capabilities.
      // web_search is only supported natively on DashScope Qwen models
      // (via enable_search:true injected by the backend). Other models
      // (GLM-5.1, DeepSeek, Kimi, etc.) cannot execute this tool.
      const filteredTools = this.tools.filter(t => {
        if (t.function.name === 'web_search') {
          return profile.supportsSearch
        }
        return true
      })

      // Convert tools to Anthropic format
      const anthropicTools = filteredTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))

      // Anthropic Messages API body — system is top-level, not in messages
      const body: Record<string, unknown> = {
        system: this.systemPrompt,
        messages,
        tools: anthropicTools,
        max_tokens: MAX_OUTPUT_TOKENS,  // Default; overwritten by buildSamplingParams for main agent
        stream: true,
      }

      // Lightweight sub-agents — no thinking, no sampling config
      if (this.lightweightOptions) {
        return body
      }

      this.contextWindowSize = profile.contextWindow

      // Sampling params: temperature and top_p vary by model and thinking mode.
      // GLM-5.1 (official z.ai benchmarks): temp=1.0 for both, top_p=0.95 (thinking) vs 1.0 (non-thinking).
      // Qwen3: temp=0.6 (thinking) vs 0.7 (non-thinking), top_p=0.95 vs 0.8.
      const sampling = buildSamplingParams(profile, isThinking)
      Object.assign(body, sampling)

      const thinking = buildThinkingParam(profile, isThinking)
      if (thinking) {
        Object.assign(body, thinking)
      }

      return body
    } catch {
      const filteredTools = this.tools.filter(t => t.function.name !== 'web_search')
      const body: Record<string, unknown> = {
        system: this.systemPrompt,
        messages,
        tools: filteredTools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        })),
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
      }
      return body
    }
  }

  async runAgentLoop(
    userMessage: string | ContentPart[],
    conversationHistory: Array<{ role: string; content: string | AnthropicContentBlock[] | null }>,
    callbacks: AgentCallbacks
  ): Promise<void> {
    if (this.isRunning && !this.lightweightOptions) {
      this.cancelLoop()
    }
    this.isRunning = true
    let myGeneration: number | null = null
    if (!this.lightweightOptions) {
      this.abortController = new AbortController()
      // Atomically transition the QueryGuard to running. tryStart() returns
      // a generation number we capture for end() so a stale finally from a
      // cancelled query (whose generation was bumped by forceEnd) is skipped.
      // If tryStart returns null, another runAgentLoop is already running —
      // refuse to enter to avoid leaving the guard pinned in 'running' forever.
      myGeneration = getQueryGuard().tryStart()
      if (myGeneration === null) {
        logger.warn('agent', 'tryStart() returned null — concurrent runAgentLoop detected, aborting')
        this.isRunning = false
        return
      }
    } else if (!this.abortController) {
      this.abortController = new AbortController()
    }

    // Reset per-message tracking (files edited and verify status are per user message, not per session)
    this.filesEditedThisSession.clear()
    this.lastFileChangeTimestamp = 0
    // Clear agent tasks from previous message
    try {
      const { useAgentStore } = await import('../../stores/agentStore')
      useAgentStore.getState().clearTasks()
    } catch { /* non-critical */ }

    // Reset stale compression state for fresh conversations (new session).
    // Sub-agents always pass conversationHistory=[] (createLightweight
    // callsites in toolExecutor.ts), but they do NOT represent a "new
    // session" semantically — they're nested calls inside the parent
    // agent's session. Combine the gates so the UI counter only resets
    // when the MAIN agent starts a new chat.
    const isMainAgentNewSession = !this.lightweightOptions && conversationHistory.length === 0
    if (conversationHistory.length === 0) {
      this.lastPromptTokens = 0
      this.fileAccessLog = []
      this.summarizationFailures = 0
      this.poolConcurrencyConflictsAvoided = 0
      this.toolExecutor.resetSessionState()
    }
    if (isMainAgentNewSession) {
      // Reset the UI mirror counter so the Experimental tab shows a fresh
      // count for the new session.
      try {
        const { useAgentStore } = await import('../../stores/agentStore')
        useAgentStore.getState().resetPoolConflictsAvoided()
      } catch { /* non-critical */ }
    }

    // Initialize context window from plan's model profile BEFORE the turn
    // loop so compression threshold is correct from the first turn.
    if (!this.lightweightOptions) {
      try {
        const { getProfileForPlan } = await import('./modelProfiles')
        const { useBillingStore } = await import('../../stores/billingStore')
        const plan = useBillingStore.getState().plan
        const profile = getProfileForPlan(plan)
        this.contextWindowSize = profile.contextWindow
        // Currently false for all active models:
        //   Qwen3 official: "store only final output, not thinking, in history"
        //   DeepSeek: rejects reasoning_content with 400
        // The field + checks remain for potential future models that require it.
        this.preserveReasoningBetweenTurns = profile.preserveReasoning
      } catch { /* keep default */ }

    } else {
      // Sub-agents: no special init needed
    }

    // Build Anthropic messages array. System prompt is NOT in the messages
    // array — it goes as a top-level `system` field in buildRequestBody().
    // Conversation history arrives already in Anthropic format from chatStore.
    const messages: AnthropicMessage[] = [
      ...conversationHistory.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as string | AnthropicContentBlock[],
      })),
    ]

    // Anthropic requires strictly alternating user/assistant. The conversation
    // history may end with a user message (tool_results from the previous turn).
    // If so, we must NOT push another user message directly — instead insert
    // a dummy assistant turn to maintain alternation.
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'user') {
      messages.push({ role: 'assistant', content: 'Understood. What would you like me to do next?' })
    }
    messages.push({ role: 'user', content: userMessage as string })

    let turnCount = 0
    let continuationCount = 0
    let enforcementRetries = 0
    const MAX_ENFORCEMENT_RETRIES = 3

    try {
      const maxTurns = this.lightweightOptions?.maxTurns ?? Infinity
      while (turnCount < maxTurns) {
        if (this.abortController?.signal.aborted) return

        turnCount++
        // turnCount tracked for telemetry and max-turns enforcement

        // Layer 2: Compress context if approaching token limit (percentage-based)
        const compressionThreshold = Math.floor(this.contextWindowSize * COMPRESSION_THRESHOLD_PCT)
        if (this.lastPromptTokens > compressionThreshold) {
          const before = this.lastPromptTokens
          callbacks.onContextCompression?.(before, 0) // signal start
          try {
            const compressedMessages = await this.compressContext(messages)
            messages.length = 0
            messages.push(...compressedMessages)

            // Layer 2b: Re-read recent files to recover file content knowledge
            await this.injectFileReReadings(messages)
          } catch (compErr) {
            // Compression failed — continue with existing messages rather than stopping
            logger.error('agent', 'Context compression failed, continuing with uncompressed context:', compErr)
          }

          this.lastPromptTokens = 0 // reset — next API call will report the real new count
          callbacks.onContextCompression?.(before, -1) // signal done
        }

        // Layer 1: Microcompact old tool results before sending to API.
        // Creates a lightweight copy — original messages retain full content
        // for future LLM summarization (which needs full detail).
        const apiMessages = this.microcompactToolResults(messages)

        // Telemetry: log microcompaction savings (only when compaction actually ran).
        // contentAsText handles both string and ContentPart[] shapes; for
        // multimodal messages this counts the text length of the parts
        // (image_url URLs are excluded — they're huge data URIs that
        // would distort the metric).
        if (apiMessages !== messages) {
          const originalSize = messages.reduce((s: number, m: any) => s + contentAsText(m.content).length, 0)
          const compactedSize = apiMessages.reduce((s: number, m: any) => s + contentAsText(m.content).length, 0)
          logger.info('agent', `Microcompaction: ${originalSize - compactedSize} chars saved (${originalSize} → ${compactedSize})`)
        }

        // Diagnostic: dump messages state before each API call so we can verify
        // tool_results are in the conversation. Remove after debugging.
        logger.info('agent', `[TURN ${turnCount}] messages=${apiMessages.length} roles=[${apiMessages.map((m: any) => {
          const role = m.role
          if (Array.isArray(m.content)) {
            const types = m.content.map((b: any) => b.type).join(',')
            return `${role}(${types})`
          }
          return role
        }).join(' → ')}]`)

        // Get streaming response
        const response = await this.callAPI(apiMessages)

        // Phase D: create streaming pool BEFORE processing the stream.
        // processStreamedTurn calls pool.addTool() on each content_block_stop
        // so tools start executing DURING streaming, not after.
        const streamingPool = new StreamingSafeToolPool(
          this.toolExecutor,
          this.abortController?.signal,
          (tc, raw, isError) => {
            callbacks.onToolResult(tc.id, tc.name, raw, isError)
          },
        )

        // Process the stream (text deltas + tool dispatch emitted during this call)
        const turnResult = await this.processStreamedTurn(response, callbacks, streamingPool)

        // Seal the pool — no more tools will be added after the stream ends
        streamingPool.seal()

        if (this.abortController?.signal.aborted) return

        // Report usage and track prompt tokens for compression decisions
        if (turnResult.usage) {
          this.lastPromptTokens = turnResult.usage.promptTokens
          callbacks.onUsageUpdate(turnResult.usage.promptTokens, turnResult.usage.completionTokens)
        }

        // Handle token limit: auto-continue the response.
        // When the model hits max_tokens mid-response, finish_reason is "length".
        // We add the partial response to history and ask the model to continue,
        // seamlessly appending text to the same streaming message in the UI.
        if (turnResult.finishReason === 'length' && continuationCount < MAX_CONTINUATIONS) {
          continuationCount++
          // Add partial assistant response in Anthropic format
          const partialBlocks: AnthropicContentBlock[] = []
          if (this.preserveReasoningBetweenTurns && turnResult.reasoningContent) {
            partialBlocks.push({ type: 'thinking', thinking: turnResult.reasoningContent })
          }
          if (turnResult.textContent) {
            partialBlocks.push({ type: 'text', text: turnResult.textContent })
          }
          messages.push({
            role: 'assistant',
            content: partialBlocks.length > 0 ? partialBlocks : turnResult.textContent || '',
          })
          messages.push({
            role: 'user',
            content: 'Continue from where you left off. Do not repeat what you already said.',
          })
          callbacks.onTurnComplete(turnCount)
          continue
        }

        // Add assistant message to history in Anthropic content blocks format.
        // Anthropic: tool_calls → tool_use blocks inside the content array.
        // Thinking → thinking blocks. Text → text blocks.
        const assistantBlocks: AnthropicContentBlock[] = []
        if (this.preserveReasoningBetweenTurns && turnResult.reasoningContent) {
          assistantBlocks.push({ type: 'thinking', thinking: turnResult.reasoningContent })
        }
        if (turnResult.textContent) {
          assistantBlocks.push({ type: 'text', text: turnResult.textContent })
        }
        for (const tc of turnResult.toolCalls) {
          assistantBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args,
          })
        }
        messages.push({
          role: 'assistant',
          content: assistantBlocks.length > 0 ? assistantBlocks : turnResult.textContent || '',
        })

        // Tool execution: concurrency-safety-aware pool.
        //
        // Read tools (read_file, glob, search_files, web_fetch, etc.) run in
        // parallel up to MAX_PARALLEL=10. Write tools (write_file, edit_file,
        // execute_command, etc.) run serially — no two mutating tools overlap.
        // Writes are fast (compute diff JSON only, no disk write) so serial
        // execution adds <60ms total even for 3 writes.
        //
        // After all tools' execute() returns, diff approvals are batched via
        // Promise.all so the user sees multiple InlineDiffs together and can
        // decide as a batch.

        // Phase D: drain results from the streaming pool. Tools may have
        // started executing DURING the stream (via addTool in processStreamedTurn).
        // Now we collect their results and handle diff approval.
        // onToolResult callbacks were already fired by the pool during execution.
        const poolResults: PoolToolResult[] = []
        for await (const result of streamingPool.getRemainingResults()) {
          poolResults.push(result)
        }

        // Telemetry
        const telemetry = streamingPool.getTelemetry()
        logger.info('agent', `tool_pool_turn_done: tools=${turnResult.toolCalls.length} duration=${telemetry.totalDurationMs}ms conflictsAvoided=${telemetry.concurrencyConflictsAvoided}`)
        this.poolConcurrencyConflictsAvoided += telemetry.concurrencyConflictsAvoided
        if (turnResult.toolCalls.length > 1) {
          import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('tool_pool_turn', {
              total_tools: turnResult.toolCalls.length,
              duration_ms: telemetry.totalDurationMs,
              conflicts_avoided: telemetry.concurrencyConflictsAvoided,
            })
          }).catch(() => {})
        }
        if (telemetry.concurrencyConflictsAvoided > 0) {
          try {
            const { useAgentStore } = await import('../../stores/agentStore')
            useAgentStore.getState().bumpPoolConflictsAvoided(telemetry.concurrencyConflictsAvoided)
          } catch { /* non-critical */ }
        }

        // Approval phase (batched): all diff approvals run concurrently
        type DrainEntry = { toolCall: { id: string; name: string; args: Record<string, unknown> }; content: string; isError: boolean }
        const toolResults: (DrainEntry | null)[] = await Promise.all(
          poolResults.map(async (entry): Promise<DrainEntry | null> => {
            if (!entry) return null
            if (this.abortController?.signal.aborted) return null

            const { toolCall, rawResult, isError, parsedDiff } = entry

            if (isError) {
              return { toolCall, content: `Error: ${rawResult}`, isError: true }
            }

            if (parsedDiff && !this.lightweightOptions?.readOnly) {
              const approved = await createDiffApprovalPromise(toolCall.id)
              if (this.abortController?.signal.aborted) return null
              if (approved) {
                if (!this.lightweightOptions) {
                  this.filesEditedThisSession.add(parsedDiff.path)
                  this.lastFileChangeTimestamp = Date.now()
                }
                if (parsedDiff.newContent !== undefined) {
                  this.toolExecutor.updateReadStateAfterWrite(parsedDiff.path, parsedDiff.newContent)
                }
                return {
                  toolCall,
                  content: `File ${parsedDiff.isNewFile ? 'created' : 'updated'}: ${parsedDiff.path}`,
                  isError: false,
                }
              }
              return {
                toolCall,
                content: `User rejected the file change: ${parsedDiff.path}. Ask the user what they want instead.`,
                isError: false,
              }
            }

            if (parsedDiff) {
              return {
                toolCall,
                content: `File ${parsedDiff.isNewFile ? 'created' : 'updated'}: ${parsedDiff.path}`,
                isError: false,
              }
            }

            return { toolCall, content: rawResult, isError: false }
          }),
        )

        // Track file access for post-compaction re-reading
        for (const entry of toolResults) {
          if (entry && !entry.isError) {
            this.trackFileAccess(entry.toolCall.name, entry.toolCall.args)
          }
        }

        // Add all tool results to messages in Anthropic format.
        // Anthropic uses role:'user' with tool_result content blocks (NOT role:'tool').
        // Multiple tool_results from the same turn are merged into ONE user message.
        // Dev server feedback is also merged here to avoid creating consecutive
        // user messages (Anthropic requires strictly alternating user/assistant).
        const toolResultBlocks: AnthropicContentBlock[] = []
        for (const entry of toolResults) {
          if (!entry) continue
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: entry.toolCall.id,
            content: `[TOOL_RESULT:${entry.toolCall.name}]\n${entry.content}\n[/TOOL_RESULT]`,
          })
        }

        // Closed-loop feedback: auto-inject dev server errors INSIDE the same
        // user message as tool_results. Merging prevents consecutive user messages
        // which Anthropic rejects.
        if (!this.lightweightOptions) {
          const hasFileChanges = toolResults.some(r =>
            r && !r.isError && ['write_file', 'edit_file', 'create_file'].includes(r.toolCall.name)
          )
          if (hasFileChanges && devServerManager.isActive()) {
            await new Promise(r => setTimeout(r, 1500))
            if (!this.abortController?.signal.aborted) {
              const devErrors = await this.getRecentDevServerErrors()
              if (devErrors) {
                toolResultBlocks.push({
                  type: 'text',
                  text: `[DEV_SERVER_FEEDBACK]\nThe dev server detected errors after your file changes:\n\n${devErrors}\n\nFix these errors before continuing. Use read_dev_server_logs for full output if needed.\n[/DEV_SERVER_FEEDBACK]`,
                } as AnthropicContentBlock)
              }
            }
          }
        }

        // ── Mid-turn drain: inject queued messages into the tool_results user msg
        // Ported from Claude Code (query.ts:1556). Queued user messages are appended
        // as text blocks to the SAME user message that carries tool results. This
        // avoids consecutive user messages (Anthropic requires strict alternation)
        // and gives the model the new input alongside the tool results.
        //
        // Only fires when there were actual tool calls — if the model replied with
        // pure text, it already made a "stop" decision.
        if (
          !this.lightweightOptions &&
          turnResult.toolCalls.length > 0 &&
          turnResult.finishReason === 'tool_use' &&
          hasCommandsInQueue()
        ) {
          const queuedPromptCommands = dequeueAllMatching(
            cmd => !isSlashCommand(cmd) && cmd.mode === 'prompt',
          )

          if (queuedPromptCommands.length > 0) {
            const mergedValue: PromptValue =
              queuedPromptCommands.length > 1
                ? joinPromptValues(queuedPromptCommands.map(c => c.value))
                : queuedPromptCommands[0]!.value

            // Extract display text for UI visibility
            const displayText = typeof mergedValue === 'string'
              ? mergedValue
              : mergedValue
                  .filter(b => b.type === 'text')
                  .map(b => b.text)
                  .join(' ')
            const displayAttachments = typeof mergedValue === 'string'
              ? []
              : mergedValue
                  .filter(b => b.type === 'attachment')
                  .map(b => b.attachment)

            // Extract promptBlocks to preserve interleaved text↔image structure
            // for vision-capable models in follow-up turns
            const promptBlocksList = typeof mergedValue === 'string'
              ? undefined
              : mergedValue

            // Add to chat so the user sees the message — INSERT before the
            // streaming assistant message to keep visual order correct:
            //   user_msg → queued_user_msg → assistant_response
            //   (NOT: user_msg → assistant_response → queued_user_msg)
            try {
              const { useChatStore: chatStoreImport } = await import('../../stores/chatStore')
              chatStoreImport.getState().insertUserMessageBeforeAssistant(
                displayText,
                displayAttachments,
                promptBlocksList,
              )
            } catch { /* non-critical */ }

            // Append to the tool_results user message (avoids consecutive user msgs)
            toolResultBlocks.push({
              type: 'text',
              text: `[USER_MESSAGE]\n${displayText}\n[/USER_MESSAGE]`,
            })

            logger.info(
              'agent',
              `[MID-TURN DRAIN] Appended ${queuedPromptCommands.length} queued message(s) to tool_results: "${displayText.slice(0, 80)}${displayText.length > 80 ? '...' : ''}"`,
            )
          }
        }
        // ── End mid-turn drain ───────────────────────────────────────────

        if (toolResultBlocks.length > 0) {
          messages.push({
            role: 'user',
            content: toolResultBlocks,
          })
        }

        // If no tool calls, the model wants to stop. But first, enforce completion checks.
        // Anthropic stop_reason: 'tool_use' = has tools, 'end_turn' = done, 'max_tokens' = overflow
        if (
          turnResult.toolCalls.length === 0 ||
          turnResult.finishReason !== 'tool_use'
        ) {
          // Completion enforcement — only for the main agent, not sub-agents
          if (!this.lightweightOptions) {
            const enforcements: string[] = []

            // Enforcement: never done with errors — check dev server logs.
            // Only check errors that appeared AFTER the last file change to avoid
            // false-blocking on stale errors that were already fixed by hot-reload.
            if (devServerManager.isActive() && this.lastFileChangeTimestamp > 0) {
              try {
                const { useLayoutStore } = await import('../../stores/layoutStore')
                const logs = useLayoutStore.getState().devServerLogs
                const errorsAfterLastChange = logs.filter(l =>
                  l.level === 'error' && l.timestamp > this.lastFileChangeTimestamp
                )
                if (errorsAfterLastChange.length > 0) {
                  const errorText = errorsAfterLastChange.slice(-5).map(e => e.text).join('\n')
                  enforcements.push(`The dev server is showing errors after your changes:\n${errorText}\n\nFix these errors before reporting completion.`)
                }
              } catch { /* non-critical */ }
            }

            // If any enforcement triggered, push the model back into the loop.
            // assistantMsg is already in messages (pushed above) — only add the enforcement.
            // Limited retries prevent infinite loops from persistent server errors.
            if (enforcements.length > 0 && enforcementRetries < MAX_ENFORCEMENT_RETRIES) {
              enforcementRetries++
              messages.push({
                role: 'user',
                content: `[COMPLETION_BLOCKED]\n${enforcements.join('\n\n')}\n[/COMPLETION_BLOCKED]`,
              })
              callbacks.onTurnComplete(turnCount)
              continue // Back to loop — model must address the issues
            }
          }

          callbacks.onDone(turnResult.textContent || '')
          return
        }

        // Pre-exit drain: if the model wants to stop but there are queued messages,
        // inject them before exiting. Without this, queued messages would be left
        // behind and a new loop would start without the tool results context.
        if (
          !this.lightweightOptions &&
          hasCommandsInQueue()
        ) {
          const queuedPromptCommands = dequeueAllMatching(
            cmd => !isSlashCommand(cmd) && cmd.mode === 'prompt',
          )

          if (queuedPromptCommands.length > 0) {
            const mergedValue: PromptValue =
              queuedPromptCommands.length > 1
                ? joinPromptValues(queuedPromptCommands.map(c => c.value))
                : queuedPromptCommands[0]!.value

            const displayText = typeof mergedValue === 'string'
              ? mergedValue
              : mergedValue
                  .filter(b => b.type === 'text')
                  .map(b => b.text)
                  .join(' ')
            const displayAttachments = typeof mergedValue === 'string'
              ? []
              : mergedValue
                  .filter(b => b.type === 'attachment')
                  .map(b => b.attachment)

            try {
              const { useChatStore: chatStoreImport } = await import('../../stores/chatStore')
              chatStoreImport.getState().insertUserMessageBeforeAssistant(displayText, displayAttachments)
            } catch { /* non-critical */ }

            messages.push({
              role: 'user',
              content: `[USER_MESSAGE]\n${displayText}\n[/USER_MESSAGE]`,
            })

            logger.info(
              'agent',
              `[PRE-EXIT DRAIN] Injected ${queuedPromptCommands.length} queued message(s) before exit: "${displayText.slice(0, 80)}${displayText.length > 80 ? '...' : ''}"`,
            )

            // Continue the loop — do NOT call onTurnComplete here since
            // no actual turn completed yet (the model was about to stop).
            // The next loop iteration will call onTurnComplete after the API responds.
            continue
          }
        }

        if (this.abortController?.signal.aborted) return

        callbacks.onTurnComplete(turnCount)
      }

      callbacks.onError(new Error(`Agent exceeded maximum turns (${maxTurns})`))
    } catch (error) {
      // Clean exit on abort — don't treat as error
      if (this.abortController?.signal.aborted) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      // Pool telemetry: log + analytics for the entire agent loop.
      if (!this.lightweightOptions) {
        logger.info('agent', `tool_pool_loop_done: conflictsAvoided=${this.poolConcurrencyConflictsAvoided}`)
        if (this.poolConcurrencyConflictsAvoided > 0) {
          import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('tool_pool_loop_done', {
              conflicts_avoided: this.poolConcurrencyConflictsAvoided,
            })
          }).catch(() => {})
        }
      }
      this.isRunning = false
      // Signal that the main agent is idle (triggers queue processing).
      // end(myGeneration) is a no-op if forceEnd() bumped the generation
      // (i.e. cancelLoop ran) — in that case the cancel path already moved
      // the guard to idle and a fresh runAgentLoop may already have started,
      // so the QueryGuard contract guarantees we won't disturb it.
      if (!this.lightweightOptions && myGeneration !== null) {
        getQueryGuard().end(myGeneration)
      }
    }
  }

  // === Context Compression (LLM-based summarization) ===

  /**
   * Compresses the conversation by sending old messages to the LLM for summarization.
   *
   * Strategy:
   * 1. Split messages into: system prompt | old turns | recent turns (last N)
   * 2. Serialize old turns into readable text
   * 3. Call the API to produce structured bullet-point summary (~85-90% fidelity)
   * 4. Replace old turns with a single summary message
   * 5. Return [system, summary, ...recentTurns]
   */
  private async compressContext(messages: AnthropicMessage[]): Promise<AnthropicMessage[]> {
    const systemMsg = messages[0]
    const rest = messages.slice(1)

    // Find turn boundaries (each turn starts with an assistant message)
    const turnStarts: number[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].role === 'assistant') {
        turnStarts.push(i)
      }
    }

    // Adaptive: keep more recent turns for longer conversations
    // Short (< 14 turns): keep 4 | Medium (14-40): ~30% | Long (40+): keep 12
    const adaptiveKeep = Math.min(
      Math.max(MIN_KEEP_RECENT_TURNS, Math.ceil(turnStarts.length * 0.3)),
      MAX_KEEP_RECENT_TURNS,
    )
    const keepFrom = turnStarts.length > adaptiveKeep
      ? turnStarts[turnStarts.length - adaptiveKeep]
      : 0

    const oldMessages = rest.slice(0, keepFrom)
    const recentMessages = rest.slice(keepFrom)

    if (oldMessages.length === 0) return messages // nothing old to compress

    // Summarize via LLM (with circuit breaker: skip after 3 consecutive failures)
    let summary: string
    if (this.summarizationFailures >= 3) {
      logger.warn('agent', `Summarization circuit breaker open (${this.summarizationFailures} failures) — using mechanical fallback`)
      summary = this.mechanicalFallback(oldMessages)
    } else {
      try {
        summary = await this.callSummarizationAPI(oldMessages)
        this.summarizationFailures = 0 // reset on success
      } catch {
        this.summarizationFailures++
        logger.warn('agent', `Summarization failed (${this.summarizationFailures}/3) — using mechanical fallback`)
        summary = this.mechanicalFallback(oldMessages)
      }
    }

    return [
      systemMsg,
      {
        role: 'user' as const,
        content: `[Compressed context — earlier conversation summary]\n\n${summary}\n\n[End of summary — the messages below are the most recent and are in full.]`,
      },
      ...recentMessages,
    ]
  }

  /**
   * Serializes messages into a human-readable format for the summarizer.
   * Preserves ALL content — tool arguments, results, narration, errors.
   */
  /**
   * Serialize Anthropic messages to readable text for the LLM summarizer.
   * Iterates content blocks to extract text, tool_use, tool_result, thinking.
   */
  private serializeMessagesForSummary(messages: AnthropicMessage[]): string {
    return messages.map((msg: any) => {
      const content = msg.content

      // Simple string content
      if (typeof content === 'string') {
        return `[${msg.role.toUpperCase()}]\n${content}`
      }

      // Array of Anthropic content blocks
      if (Array.isArray(content)) {
        const parts: string[] = []
        for (const block of content) {
          switch (block.type) {
            case 'text':
              parts.push(block.text)
              break
            case 'thinking':
              parts.push(`[THINKING]\n${block.thinking}`)
              break
            case 'tool_use':
              parts.push(`[TOOL CALL: ${block.name}]\n${JSON.stringify(block.input)}`)
              break
            case 'tool_result':
              parts.push(`[TOOL RESULT (${block.tool_use_id})]\n${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`)
              break
            case 'image_url':
              parts.push('[image]')
              break
            default:
              parts.push(JSON.stringify(block))
          }
        }
        return `[${msg.role.toUpperCase()}]\n${parts.join('\n')}`
      }

      return `[${msg.role.toUpperCase()}]\n${String(content || '')}`
    }).join('\n\n---\n\n')
  }

  /**
   * Calls the dedicated /v1/summarize endpoint on the worker.
   * This endpoint: no streaming, no thinking (enable_thinking off), JSON response.
   */
  private async callSummarizationAPI(messages: AnthropicMessage[]): Promise<string> {
    const serialized = this.serializeMessagesForSummary(messages)

    const summaryPrompt = `You are a context compressor for a coding agent. Summarize the conversation below into structured bullet points that a coding agent can use to continue its work without the full history.

Capture with high fidelity:
- **User requests**: what the user asked for, in order
- **Files read**: file paths + key content discovered (structures, patterns, bugs, important code sections)
- **Changes made**: file paths + what was changed and why (include function/variable names)
- **Commands run**: what was executed, output summary, exit codes
- **Errors encountered**: what failed, exact error messages, how it was resolved or not
- **Decisions made**: choices the agent took and reasoning
- **Current state**: what is done, what remains incomplete

Be specific — include file paths, function names, error messages, and key code patterns.
Respond in the same language the conversation uses.
Do NOT omit technical details. The agent will only see this summary, not the original messages.
Target length: 2000–4000 words. Shorter conversations may produce shorter summaries, but never sacrifice detail to save space.

<example>
<input>A conversation where the user asked to add authentication to a Next.js app. The agent read several files, installed next-auth, created API routes, and encountered a TypeScript error that was fixed.</input>
<output>
## User Requests
- Add authentication to the Next.js app using NextAuth.js with Google and GitHub providers

## Files Read
- \`src/app/layout.tsx\`: Root layout wrapping children in \`<html>\` + \`<body>\`, no providers
- \`package.json\`: Next.js 14.1, React 18, no auth dependencies
- \`src/app/page.tsx\`: Landing page with static content, no auth-aware UI

## Changes Made
- \`package.json\`: Added \`next-auth@4.24.5\` dependency
- \`src/app/api/auth/[...nextauth]/route.ts\`: Created NextAuth route handler with GoogleProvider and GitHubProvider, using env vars \`GOOGLE_CLIENT_ID\`, \`GOOGLE_CLIENT_SECRET\`, \`GITHUB_ID\`, \`GITHUB_SECRET\`
- \`src/app/layout.tsx\`: Wrapped children in \`<SessionProvider>\` from next-auth/react
- \`src/components/AuthButton.tsx\`: Created sign-in/sign-out button using \`useSession()\`
- \`src/app/page.tsx\`: Added \`<AuthButton />\` to header

## Commands Run
- \`npm install next-auth\`: exit 0, installed next-auth@4.24.5
- \`npx tsc --noEmit\`: exit 1 — error TS2345 in layout.tsx: SessionProvider requires \`"use client"\` directive

## Errors Encountered
- TypeScript error TS2345 in \`layout.tsx\`: SessionProvider is a client component but layout.tsx was a server component. Fixed by extracting provider wrapper into \`src/components/Providers.tsx\` with \`"use client"\` directive.

## Current State
- Authentication is fully implemented and compiles. User has not yet tested in browser. Environment variables (.env.local) need to be set by the developer.
</output>
</example>`

    const url = `${WORKER_URL}/v1/summarize`
    const firebaseToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!firebaseToken) throw new Error('Auth expired during compression')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${firebaseToken}`,
      },
      body: JSON.stringify({
        max_tokens: 16384,
        messages: [
          { role: 'system', content: summaryPrompt },
          { role: 'user', content: serialized },
        ],
      }),
      signal: this.abortController?.signal,
    })

    if (!response.ok) {
      throw new Error(`Summarization API failed: ${response.status}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }

    const content = data.choices[0]?.message?.content || ''
    if (content.length < 100) {
      throw new Error('Summary too short or empty — falling back to mechanical extraction')
    }
    return content
  }

  /**
   * Fallback if the LLM summarization call fails.
   * Extracts basic facts mechanically — lower fidelity but always works.
   */
  private mechanicalFallback(messages: AnthropicMessage[]): string {
    const filesRead = new Set<string>()
    const filesModified = new Set<string>()
    const commandsRun: string[] = []
    const errors: string[] = []
    const userRequests: string[] = []
    const assistantNarration: string[] = []
    const toolResults: string[] = []

    for (const msg of messages) {
      // Capture user requests
      if (msg.role === 'user' && msg.content) {
        const text = contentAsText(msg.content).slice(0, 300)
        if (!text.startsWith('[Compressed context')) {
          userRequests.push(text)
        }
      }

      // Capture assistant narration (first 200 chars per message)
      if (msg.role === 'assistant' && msg.content) {
        assistantNarration.push(contentAsText(msg.content).slice(0, 200))
      }

      // Extract tool call details from Anthropic content blocks
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type: string; name?: string; input?: Record<string, unknown>; id?: string }>) {
          if (block.type === 'tool_use' && block.name && block.input) {
            try {
              const args = block.input
              const path = (args.path as string) || ''
              switch (block.name) {
                case 'read_file': filesRead.add(path); break
                case 'write_file': case 'create_file': case 'edit_file':
                  filesModified.add(path); break
                case 'execute_command':
                  commandsRun.push((args.command as string)?.slice(0, 150) || ''); break
                case 'search_files':
                  toolResults.push(`Searched for "${args.query}" in ${args.directory || 'project'}`); break
                case 'start_dev_server':
                  toolResults.push(`Started dev server: ${args.command || ''}`); break
              }
            } catch { /* skip */ }
          }
        }
      }

      // Capture tool results from Anthropic user messages with tool_result blocks
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type: string; content?: string }>) {
          if (block.type === 'tool_result' && block.content) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
            if (text.startsWith('Error:')) {
              errors.push(text.slice(0, 300))
            } else if (text.length < 300) {
              toolResults.push(text)
            }
          }
        }
      }
    }

    const sections: string[] = ['(LLM summarization failed — mechanical fallback)\n']

    if (userRequests.length) {
      sections.push(`## User Requests\n${userRequests.map((r, i) => `${i + 1}. ${r}`).join('\n')}`)
    }
    if (assistantNarration.length) {
      sections.push(`## Agent Actions\n${assistantNarration.map(n => `- ${n}`).join('\n')}`)
    }
    if (filesRead.size) sections.push(`## Files Read\n${[...filesRead].join('\n')}`)
    if (filesModified.size) sections.push(`## Files Modified\n${[...filesModified].join('\n')}`)
    if (commandsRun.length) sections.push(`## Commands Run\n${commandsRun.map(c => `- ${c}`).join('\n')}`)
    if (toolResults.length) sections.push(`## Other Actions\n${toolResults.map(r => `- ${r}`).join('\n')}`)
    if (errors.length) sections.push(`## Errors\n${errors.map(e => `- ${e}`).join('\n')}`)

    return sections.join('\n\n')
  }

  // === Layer 1: Microcompaction ===

  /**
   * Replaces old tool results with one-line summaries.
   * Keeps only the last N tool results in full — older ones get compacted.
   * Returns a COPY — the original messages array is not modified.
   */
  /**
   * Microcompact old tool results in Anthropic message format.
   *
   * In Anthropic format, tool_results are content blocks inside role:'user'
   * messages (not separate role:'tool' messages). This method finds user
   * messages that contain tool_result blocks, counts them, and replaces
   * old ones (beyond the last N) with one-line summaries.
   */
  private microcompactToolResults(messages: AnthropicMessage[]): AnthropicMessage[] {
    // Collect indices of user messages that contain tool_result blocks
    const toolResultMsgIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some((b: any) => b.type === 'tool_result')
        if (hasToolResult) toolResultMsgIndices.push(i)
      }
    }

    if (toolResultMsgIndices.length <= MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS) {
      return messages
    }

    const compactUpTo = toolResultMsgIndices.length - MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS
    const indicesToCompact = new Set(toolResultMsgIndices.slice(0, compactUpTo))

    return messages.map((msg, idx) => {
      if (!indicesToCompact.has(idx)) return msg
      if (!Array.isArray(msg.content)) return msg

      // Replace each tool_result block's content with a one-line summary
      const compactedContent = msg.content.map((block: any) => {
        if (block.type !== 'tool_result') return block
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (content.length < 200) return block
        // Find matching tool_use in preceding assistant message to get tool name
        const toolName = this.findToolNameForResult(block.tool_use_id, idx, messages)
        const summary = toolName
          ? this.buildToolSummaryLine(toolName, '{}', content)
          : content.slice(0, 150) + ' [... compacted]'
        return { ...block, content: summary }
      })

      return { ...msg, content: compactedContent }
    })
  }

  /**
   * Find the tool name for a given tool_use_id by searching backwards through
   * assistant messages for a matching tool_use content block.
   */
  private findToolNameForResult(toolUseId: string, fromIndex: number, messages: AnthropicMessage[]): string | null {
    for (let i = fromIndex - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id === toolUseId) {
            return block.name
          }
        }
      }
    }
    return null
  }

  // summarizeToolResult removed — replaced by inline compaction in
  // microcompactToolResults using findToolNameForResult for Anthropic format.

  /**
   * Builds a contextual one-line summary based on the tool type.
   */
  private buildToolSummaryLine(toolName: string, argsJson: string, result: string): string {
    try {
      const args = JSON.parse(argsJson)
      const lineCount = result.split('\n').length

      switch (toolName) {
        case 'read_file':
          return `[File read: ${args.path} (${lineCount} lines)]`
        case 'search_files':
          return `[Search "${args.query}" in ${args.directory || 'project'}: ${lineCount} result lines]`
        case 'list_directory':
          return `[Directory listing: ${args.path} (${lineCount} entries)]`
        case 'glob':
          return `[Glob "${args.pattern}": ${lineCount} matches]`
        case 'execute_command': {
          const firstLine = result.split('\n')[0]?.slice(0, 100) || ''
          return `[Command "${(args.command as string)?.slice(0, 80)}": ${firstLine}]`
        }
        case 'web_fetch':
          return `[Fetched: ${args.url} (${result.length} chars)]`
        case 'get_diagnostics':
          return `[Diagnostics: ${args.path} — ${result.split('\n')[0] || 'no issues'}]`
        default:
          return result.length > 200 ? result.slice(0, 150) + ' [... compacted]' : result
      }
    } catch {
      return result.length > 200 ? result.slice(0, 150) + ' [... compacted]' : result
    }
  }

  // === Closed-Loop Feedback (dev server error detection) ===

  /**
   * Returns recent error-level dev server logs (last 5 seconds).
   * Used by the auto-injection in runAgentLoop to push build errors,
   * type errors, and crashes back to the model after file modifications.
   */
  private async getRecentDevServerErrors(): Promise<string | null> {
    try {
      const { useLayoutStore } = await import('../../stores/layoutStore')
      const logs = useLayoutStore.getState().devServerLogs
      const now = Date.now()
      const recentErrors = logs.filter(l =>
        l.level === 'error' && now - l.timestamp < 5000
      )
      if (recentErrors.length === 0) return null
      return recentErrors.map(e => e.text).join('\n')
    } catch {
      return null
    }
  }

  // === File Access Tracking (for post-compaction re-reading) ===

  /**
   * Records a file access event. Maintains a deduplicated list ordered by recency.
   */
  private trackFileAccess(toolName: string, args: Record<string, unknown>) {
    const path = (args.path as string) || ''
    if (!path) return

    let action: 'read' | 'modified' | null = null
    switch (toolName) {
      case 'read_file': action = 'read'; break
      case 'write_file': case 'create_file': case 'edit_file':
        action = 'modified'; break
      default: return
    }

    // Preserve 'modified' as the strongest action — a file that was modified
    // then re-read should still be prioritized as 'modified' in post-compaction re-reading.
    const existing = this.fileAccessLog.find(e => e.path === path)
    const resolvedAction = (existing?.action === 'modified' && action === 'read')
      ? 'modified'
      : action

    this.fileAccessLog = this.fileAccessLog.filter(e => e.path !== path)
    this.fileAccessLog.push({ path, action: resolvedAction, timestamp: Date.now() })
    // Prevent unbounded growth — keep only the most recent entries
    if (this.fileAccessLog.length > 200) {
      this.fileAccessLog = this.fileAccessLog.slice(-200)
    }
  }

  /**
   * Returns the most recently accessed/modified files for re-reading.
   * Prioritizes modified files over read-only files.
   */
  private getRecentFiles(limit: number = POST_COMPACTION_REREAD_FILES): string[] {
    const sorted = [...this.fileAccessLog].sort((a, b) => {
      if (a.action === 'modified' && b.action !== 'modified') return -1
      if (b.action === 'modified' && a.action !== 'modified') return 1
      return b.timestamp - a.timestamp
    })
    return sorted.slice(0, limit).map(e => e.path)
  }

  /**
   * Layer 2b: After LLM compaction, re-reads recently accessed files
   * and injects their content so the model recovers file-level knowledge.
   */
  private async injectFileReReadings(messages: AnthropicMessage[]): Promise<void> {
    const recentFiles = this.getRecentFiles()
    if (recentFiles.length === 0) return

    const diffService = DiffService.getInstance()
    const pendingDiffs = diffService.getPendingDiffs()
    // Index pending diffs by path for O(1) lookup
    const pendingByPath = new Map(pendingDiffs.map(d => [d.filePath, d]))

    const fileContents: string[] = []

    for (const filePath of recentFiles) {
      try {
        // Use pending diff content if the file has an unapproved write,
        // otherwise read the actual file from disk.
        const pending = pendingByPath.get(filePath)
        const content = pending
          ? pending.newContent
          : await invoke<string>('read_file', { path: filePath })

        const truncated = content.length > POST_COMPACTION_FILE_MAX_CHARS
          ? content.slice(0, POST_COMPACTION_FILE_MAX_CHARS) + '\n[... truncated for context recovery]'
          : content
        const label = pending ? `${filePath} (pending approval)` : filePath
        fileContents.push(`### ${label}\n\`\`\`\n${truncated}\n\`\`\``)
      } catch {
        // File may have been deleted — skip
      }
    }

    // Include dev server status if one is running
    let devServerNote = ''
    if (devServerManager.isRunning()) {
      devServerNote = `\n\nNote: A dev server is currently running at ${devServerManager.getUrl() || 'unknown URL'}. Do not start another one.`
    }

    if (fileContents.length === 0 && !devServerNote) return

    const parts = []
    if (fileContents.length > 0) {
      parts.push(`[Context recovery — current content of recently accessed files]\n\n${fileContents.join('\n\n')}`)
    }
    if (devServerNote) {
      parts.push(devServerNote)
    }
    parts.push('\n[Continue from where you left off without asking the user any further questions.]')

    // Anthropic requires strictly alternating user/assistant messages.
    // If the last message is already user (e.g., tool_results from the
    // turn that triggered compaction), we must insert a dummy assistant
    // message before adding another user message.
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'user') {
      messages.push({
        role: 'assistant',
        content: 'Understood. I\'ll continue working with the recovered context.',
      })
    }

    messages.push({
      role: 'user',
      content: parts.join('\n'),
    })
  }

  /** Returns the current abort controller (for sub-agent abort propagation). */
  getAbortController(): AbortController | null {
    return this.abortController
  }

  cancelLoop(): void {
    if (this.abortController) {
      this.abortController.abort()
      // DON'T null out — signal.aborted checks still need to work
      // A new AbortController is created in the next runAgentLoop call
    }
    // Unblock any pending diff approval waits
    resolveAllPendingDiffApprovals(false)
    // Reset auto-approve diffs so next session requires manual approval
    import('../../stores/permissionStore').then(m => m.usePermissionStore.getState().resetAutoApprove()).catch(() => {})
    this.isRunning = false
    // forceEnd() bumps the QueryGuard's generation so the cancelled loop's
    // finally block sees a stale generation and skips its end() call.
    // This allows queue processing (or a fresh runAgentLoop) to start
    // without racing the cancelled loop's late finally.
    if (!this.lightweightOptions) {
      getQueryGuard().forceEnd()
    }
  }

  private async callAPI(messages: AnthropicMessage[]): Promise<Response> {
    const MAX_RETRIES = 3
    const RETRY_DELAYS = [3000, 5000, 10000] // default backoff for network errors

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.abortController?.signal.aborted) throw new DOMException('Aborted', 'AbortError')

      try {
        const response = await this.callAPIOnce(messages)
        return response
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err

        const isRetryable = err instanceof ServiceError && err.retryable
        const isLastAttempt = attempt === MAX_RETRIES

        if (!isRetryable || isLastAttempt) throw err

        // Wait before retrying — 20s for rate limits, normal backoff for others
        const isRateLimit = err instanceof ServiceError && err.code === 'RATE_LIMIT'
        const delay = isRateLimit ? 20000 : (RETRY_DELAYS[attempt] || 10000)
        logger.warn('agent', `API call failed (${(err as ServiceError).code}), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          this.abortController?.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }
    }

    // Unreachable, but TypeScript needs it
    throw new ServiceError('Max retries exceeded', 'NETWORK_ERROR', false)
  }

  private async callAPIOnce(messages: AnthropicMessage[]): Promise<Response> {
    // Anthropic Messages API endpoint — the worker converts to OpenAI
    // format internally for DashScope, and converts the response back
    // to Anthropic SSE with content_block_stop events for Phase D.
    const url = `${WORKER_URL}/v1/messages`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Clear stale noCredits before each request (may have been resolved server-side)
    useBillingStore.getState().clearNoCredits()

    const firebaseToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!firebaseToken) {
      throw new ServiceError(
        'Sessão expirada. Faz login novamente.',
        'AUTH_EXPIRED',
        false
      )
    }
    headers['Authorization'] = `Bearer ${firebaseToken}`

    // Include session ID for billing conversation tracking
    const activeSession = useChatStore.getState().getActiveSession?.()
    if (activeSession?.id) {
      headers['X-Conversation-Id'] = activeSession.id
    }

    // Request type override (e.g. 'plan' for /plan command → reasoning model).
    // Sent only on the first call — auto-cleared so subsequent turns
    // (tool results, follow-ups) use the normal plan model.
    if (this.requestType) {
      headers['X-Request-Type'] = this.requestType
      this.requestType = null
    }

    // Cache request body to reuse on 401 retry (avoids re-encoding which could differ)
    const requestBody = JSON.stringify(await this.buildRequestBody(messages))

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: this.abortController?.signal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }
      throw new ServiceError(
        'Sem conexão. Verifica a internet.',
        'NETWORK_ERROR',
        true
      )
    }

    if (!response.ok) {
      if (response.status === 401) {
        // Try force-refreshing the token once before giving up
        const refreshedToken = await FirebaseAuthService.getInstance().getIdToken(true)
        if (refreshedToken) {
          const retryResponse = await fetch(url, {
            method: 'POST',
            headers: { ...headers, Authorization: `Bearer ${refreshedToken}` },
            body: requestBody,
            signal: this.abortController?.signal,
          })
          if (retryResponse.ok) return retryResponse
        }
        throw new ServiceError(
          'Sessão expirada. Faz login novamente.',
          'AUTH_EXPIRED',
          false
        )
      }
      if (response.status === 402) {
        useBillingStore.getState().setNoCredits()
        throw new ServiceError(
          'Sem créditos disponíveis. Aguarda a renovação ou faz upgrade do plano.',
          'NO_CREDITS',
          false
        )
      }
      if (response.status === 429) {
        // Parse cost-budget headers so UI can show post-rejection state
        useBillingStore.getState().updateFromHeaders(response.headers)

        const budgetStatus = response.headers.get('X-Budget-Status')

        if (budgetStatus === 'rejected') {
          // Cycle budget exhausted AND no overage credits. Trigger a fresh
          // /v1/me fetch in the background so the store fully syncs (the
          // headers give the immediate post-rejection view but /v1/me has
          // the canonical state including any concurrent purchases).
          import('../auth/firebaseAuth').then(m => {
            m.default.getInstance().fetchBillingInfo().catch(() => {})
          })
          throw new ServiceError(
            'Sem créditos disponíveis. Aguarda o reset do ciclo ou compra créditos extra.',
            'BUDGET_EXHAUSTED',
            false  // No retry — user must wait for cycle reset or buy credits
          )
        }

        throw new ServiceError(
          'Limite de requests atingido. Tenta daqui a pouco.',
          'RATE_LIMIT',
          true  // Frontend retries — backend does NOT retry rate limits
        )
      }
      if (response.status >= 500) {
        throw new ServiceError(
          'Erro no servidor. Tenta novamente.',
          'SERVER_ERROR',
          false  // Backend already retries network errors (11 attempts) — no frontend retry to avoid cascade
        )
      }

      // Log full error for debugging but show sanitized message to user
      const errorBody = await response.text().catch(() => '')
      logger.error('agent', `API error ${response.status}: ${errorBody.slice(0, 500)}`)
      throw new ServiceError(
        `Erro na API (${response.status}). Tenta novamente.`,
        'API_ERROR',
        false
      )
    }

    if (!response.body) {
      throw new ServiceError('Response body is null', 'API_ERROR', false)
    }

    // Read model metadata from backend response headers
    const contextWindow = response.headers.get('X-Model-Context-Window')
    if (contextWindow) {
      const parsed = parseInt(contextWindow, 10)
      if (parsed > 0) this.contextWindowSize = parsed
    }

    // Read billing info from response headers
    useBillingStore.getState().updateFromHeaders(response.headers)

    return response
  }

  /**
   * Process a streaming Anthropic SSE response.
   *
   * Anthropic events: message_start → content_block_start → content_block_delta
   *   → content_block_stop → message_delta → message_stop.
   *
   * Phase D: each content_block_stop for a tool_use block immediately fires
   * onToolCallPending + onToolCallStart so the pool can dispatch the tool
   * during the stream (before all tools are known).
   */
  private async processStreamedTurn(
    response: Response,
    callbacks: AgentCallbacks,
    streamingPool?: StreamingSafeToolPool,
  ): Promise<TurnResult> {
    let textContent = ''
    let reasoningContent = ''
    let finishReason = ''
    let usage: { promptTokens: number; completionTokens: number } | null = null

    // Per-block accumulator — keyed by Anthropic content block index
    const blocks = new Map<number, {
      type: 'text' | 'tool_use' | 'thinking'
      text: string           // for text blocks
      toolId: string         // for tool_use blocks
      toolName: string
      argsJson: string       // accumulated partial JSON for tool_use
    }>()

    // Completed tool calls (sealed by content_block_stop)
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []

    // Detector for <think> blocks embedded in text (DashScope reasoning via text_delta)
    const thinkingDetector = createThinkingDetector()

    await parseSSEStream(response, {
      onEvent: (event: StreamEvent) => {
        switch (event.type) {
          case 'content_block_start': {
            blocks.set(event.index, {
              type: event.blockType,
              text: '',
              toolId: event.toolId || '',
              toolName: event.toolName || '',
              argsJson: '',
            })
            break
          }

          case 'text_delta': {
            // Text may contain <think>...</think> tags from DashScope reasoning
            const { reasoning, content } = thinkingDetector.process(event.content)
            if (reasoning) {
              reasoningContent += reasoning
              callbacks.onReasoningDelta(reasoning)
            }
            if (content) {
              textContent += content
              callbacks.onTextDelta(content)
            }
            break
          }

          case 'reasoning_delta': {
            reasoningContent += event.content
            callbacks.onReasoningDelta(event.content)
            break
          }

          case 'tool_input_delta': {
            const block = blocks.get(event.index)
            if (block) {
              block.argsJson += event.partialJson
            }
            break
          }

          case 'content_block_stop': {
            // Phase D: authoritative signal that a content block is complete.
            // For tool_use blocks, parse args, fire UI callbacks, and dispatch
            // to the streaming pool IMMEDIATELY — during the stream.
            const completed = blocks.get(event.index)
            if (completed?.type === 'tool_use') {
              let args: Record<string, unknown> = {}
              try {
                args = JSON.parse(completed.argsJson)
              } catch {
                args = { _raw: completed.argsJson, _parseError: true }
              }
              const toolCall = { id: completed.toolId, name: completed.toolName, args }
              toolCalls.push(toolCall)
              // Fire UI callbacks
              callbacks.onToolCallPending(completed.toolId, completed.toolName)
              callbacks.onToolCallStart(completed.toolId, completed.toolName, args)
              // Phase D: dispatch to pool DURING stream — tool starts
              // executing immediately if concurrency conditions allow.
              if (streamingPool) {
                streamingPool.addTool(toolCall)
              }
            }
            break
          }

          case 'message_delta': {
            finishReason = event.stopReason
            break
          }

          case 'usage': {
            // Accumulate — message_start has input_tokens, message_delta has output_tokens
            // Use ?? (nullish coalescing) to handle the case where promptTokens or
            // completionTokens are legitimately 0 (|| would treat 0 as falsy and fall through)
            usage = {
              promptTokens: event.promptTokens ?? usage?.promptTokens ?? 0,
              completionTokens: event.completionTokens ?? usage?.completionTokens ?? 0,
            }
            break
          }

          case 'billing': {
            useBillingStore.getState().updateFromSSE({
              type: 'billing',
              consumed_pct: event.consumedPct,
              status: event.status,
              tokens_used: event.tokensUsed,
              tokens_consumed: event.tokensConsumed,
              cycle_end: event.cycleEnd,
              tms_remaining: event.tmsRemaining,
              plan: event.plan,
              used_overage: event.usedOverage,
            })
            break
          }

          case 'error': {
            callbacks.onError(new Error(event.message))
            break
          }

          case 'done':
          case 'message_start':
          case 'message_stop':
            break
        }
      },
    }, this.abortController?.signal)

    return {
      textContent,
      reasoningContent,
      toolCalls,
      finishReason,
      usage,
    }
  }
}

export default AgentService
