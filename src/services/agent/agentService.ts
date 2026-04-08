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

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Plain string for text-only messages, array of parts for multimodal user messages. */
  content?: string | ContentPart[] | null
  reasoning_content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}


interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
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

  /** Whether thinking was enabled for the current agent loop (activated by model via request_thinking tool). */
  private thinkingEnabledForLoop = false
  /** Current turn number in the active loop — used by buildRequestBody for Turn 1 thinking. */
  private currentTurnInLoop = 0
  /** Whether reasoning_content should be preserved in conversation history between turns.
   *  Set per-loop from the model profile. Default: false (strip reasoning). */
  private preserveReasoningBetweenTurns = false

  /** Called by request_thinking tool — enables thinking for remaining turns in this loop. */
  enableThinkingForLoop(): void {
    this.thinkingEnabledForLoop = true
    logger.info('agent', 'Thinking mode activated by model for this loop')
  }


  /**
   * Build the JSON request body for the chat completion API,
   * including model-specific sampling and thinking parameters.
   */
  private async buildRequestBody(messages: OpenAIMessage[]): Promise<Record<string, unknown>> {
    try {
      const { getModelProfile, buildSamplingParams, buildThinkingParam } = await import('./modelProfiles')
      const { useSettingsStore } = await import('../../stores/settingsStore')
      const modelId = useSettingsStore.getState().agentModel || 'deepseek-v3.2'
      const profile = getModelProfile(modelId)

      // Filter request_thinking tool: only show for toggleable models
      const tools = profile.thinkingMode === 'toggleable'
        ? this.tools
        : this.tools.filter(t => t.function.name !== 'request_thinking')

      const body: Record<string, unknown> = {
        messages,
        tools,
        stream: true,
        stream_options: { include_usage: true },
        model: profile.modelId,
      }

      // Lightweight sub-agents — no thinking, no sampling config
      if (this.lightweightOptions) {
        body.max_tokens = MAX_OUTPUT_TOKENS
        return body
      }

      this.contextWindowSize = profile.contextWindow

      // Thinking decision based on model category:
      // - 'toggleable': Turn 1 ON (model reasons about whether to keep it), Turn 2+ per model decision
      // - 'mandatory': always ON
      // - 'none': always OFF
      const isThinking = profile.thinkingMode === 'mandatory'
        ? true
        : profile.thinkingMode === 'toggleable'
          ? (this.currentTurnInLoop <= 1 || this.thinkingEnabledForLoop)
          : false

      const sampling = buildSamplingParams(profile, isThinking)
      Object.assign(body, sampling)

      const thinking = buildThinkingParam(profile, isThinking)
      if (thinking) {
        Object.assign(body, thinking)
      }

      return body
    } catch {
      const body: Record<string, unknown> = {
        messages,
        tools: this.tools,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: MAX_OUTPUT_TOKENS,
      }
      return body
    }
  }

  async runAgentLoop(
    userMessage: string | ContentPart[],
    conversationHistory: Array<{ role: string; content: string | ContentPart[] | null; tool_calls?: OpenAIToolCall[]; tool_call_id?: string }>,
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

    // Reset stale compression state for fresh conversations (new session)
    if (conversationHistory.length === 0) {
      this.lastPromptTokens = 0
      this.fileAccessLog = []
      this.summarizationFailures = 0
      this.toolExecutor.resetSessionState()
    }

    // Initialize context window from model profile BEFORE the turn loop
    // so compression threshold is correct from the first turn.
    if (!this.lightweightOptions) {
      try {
        const { getModelProfile } = await import('./modelProfiles')
        const { useSettingsStore } = await import('../../stores/settingsStore')
        const modelId = useSettingsStore.getState().agentModel || 'deepseek-v3.2'
        const profile = getModelProfile(modelId)
        this.contextWindowSize = profile.contextWindow
        this.preserveReasoningBetweenTurns = profile.preserveReasoning
      } catch { /* keep default */ }

      // Thinking starts OFF — the model activates it via request_thinking if needed.
      // Turn 1 always has thinking ON so the model can reason about the decision.
      this.thinkingEnabledForLoop = false
      this.currentTurnInLoop = 0
    } else {
      this.thinkingEnabledForLoop = false
      this.currentTurnInLoop = 0
    }

    const messages: OpenAIMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...conversationHistory.map(m => {
        const msg: OpenAIMessage = {
          role: m.role as OpenAIMessage['role'],
          content: m.content
        }
        if (m.tool_calls) msg.tool_calls = m.tool_calls
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
        return msg
      }),
      { role: 'user', content: userMessage }
    ]

    let turnCount = 0
    let continuationCount = 0
    let enforcementRetries = 0
    const MAX_ENFORCEMENT_RETRIES = 3

    try {
      const maxTurns = this.lightweightOptions?.maxTurns ?? Infinity
      while (turnCount < maxTurns) {
        if (this.abortController?.signal.aborted) return

        turnCount++
        this.currentTurnInLoop = turnCount

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
          const originalSize = messages.reduce((s, m) => s + contentAsText(m.content).length, 0)
          const compactedSize = apiMessages.reduce((s, m) => s + contentAsText(m.content).length, 0)
          logger.info('agent', `Microcompaction: ${originalSize - compactedSize} chars saved (${originalSize} → ${compactedSize})`)
        }

        // Get streaming response
        const response = await this.callAPI(apiMessages)

        // Process the stream (text deltas are emitted during this call)
        const turnResult = await this.processStreamedTurn(response, callbacks)

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
          // Add partial assistant response (without any incomplete tool calls)
          messages.push({
            role: 'assistant',
            content: turnResult.textContent || null,
            ...(this.preserveReasoningBetweenTurns && turnResult.reasoningContent && { reasoning_content: turnResult.reasoningContent }),
          })
          // Prompt continuation — the model will resume from where it stopped
          messages.push({
            role: 'user',
            content: 'Continue from where you left off. Do not repeat what you already said.',
          })
          callbacks.onTurnComplete(turnCount)
          continue
        }

        // Add assistant message to history (preserve reasoning only for models that document it)
        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: turnResult.textContent || null,
          ...(this.preserveReasoningBetweenTurns && turnResult.reasoningContent && { reasoning_content: turnResult.reasoningContent }),
        }
        if (turnResult.toolCalls.length > 0) {
          assistantMsg.tool_calls = turnResult.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }))
        }
        messages.push(assistantMsg)

        // If no tool calls, the model wants to stop. But first, enforce completion checks.
        if (
          turnResult.toolCalls.length === 0 ||
          (turnResult.finishReason !== 'tool_calls' && turnResult.finishReason !== 'function_call')
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

        // Execute ALL tool calls in parallel (like Claude Code).
        // Each tool gets its own toolCallId for checkpoint tracking and progress.
        // Diff approvals are per-tool — multiple InlineDiffs can appear simultaneously.

        // Show all tool calls as pending simultaneously
        for (const tc of turnResult.toolCalls) {
          callbacks.onToolCallPending(tc.id, tc.name)
          callbacks.onToolCallStart(tc.id, tc.name, tc.args)
        }

        // Execute all in parallel
        const toolResults = await Promise.all(turnResult.toolCalls.map(async (toolCall) => {
          if (this.abortController?.signal.aborted) return null

          try {
            const TOOL_TIMEOUT = 300_000 // 5 minutes max per tool execution
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined
            const result = await Promise.race([
              this.toolExecutor.execute(toolCall.name, toolCall.args, toolCall.id),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error(`Tool "${toolCall.name}" timed out after 5 minutes`)), TOOL_TIMEOUT)
              }),
            ]).finally(() => clearTimeout(timeoutHandle))
            if (this.abortController?.signal.aborted) return null

            // Check if the result is a diff (from write_file / edit_file / create_file)
            let parsedDiff: { type: string; path: string; isNewFile: boolean } | null = null
            try {
              const parsed = JSON.parse(result)
              if (parsed.type === 'diff') parsedDiff = parsed
            } catch {
              // Not JSON
            }

            // Notify UI (renders InlineDiff for diffs)
            callbacks.onToolResult(toolCall.id, toolCall.name, result, false)

            let llmResult: string
            if (parsedDiff && !this.lightweightOptions?.readOnly) {
              // Wait for user to approve/reject the file change
              const approved = await createDiffApprovalPromise(toolCall.id)
              if (this.abortController?.signal.aborted) return null
              if (approved) {
                llmResult = `File ${parsedDiff.isNewFile ? 'created' : 'updated'}: ${parsedDiff.path}`
                // Track approved file edit for verify enforcement (only count approved writes)
                if (!this.lightweightOptions) {
                  this.filesEditedThisSession.add(parsedDiff.path)
                  this.lastFileChangeTimestamp = Date.now()
                }
                // Update read state so the model can edit this file again without re-reading.
                // The file now has newContent on disk — sync the hash.
                try {
                  const parsed = JSON.parse(result)
                  if (parsed.newContent !== undefined) {
                    this.toolExecutor.updateReadStateAfterWrite(parsed.path, parsed.newContent)
                  }
                } catch { /* non-critical — model just needs to re-read */ }
              } else {
                llmResult = `User rejected the file change: ${parsedDiff.path}. Ask the user what they want instead.`
              }
            } else if (parsedDiff) {
              llmResult = `File ${parsedDiff.isNewFile ? 'created' : 'updated'}: ${parsedDiff.path}`
            } else {
              llmResult = result
            }

            // Track file access for post-compaction re-reading
            this.trackFileAccess(toolCall.name, toolCall.args)

            return { toolCall, content: llmResult, isError: false }
          } catch (error) {
            if (this.abortController?.signal.aborted) return null
            const errorMsg = error instanceof Error ? error.message : String(error)
            callbacks.onToolResult(toolCall.id, toolCall.name, errorMsg, true)
            return { toolCall, content: `Error: ${errorMsg}`, isError: true }
          }
        }))

        // Add all results to messages (order doesn't matter — API matches by tool_call_id)
        // Wrap content with boundary markers to prevent tool result injection
        for (const entry of toolResults) {
          if (!entry) continue
          messages.push({
            role: 'tool',
            tool_call_id: entry.toolCall.id,
            content: `[TOOL_RESULT:${entry.toolCall.name}]\n${entry.content}\n[/TOOL_RESULT]`,
          })

          // Track verify calls for completion enforcement (tool-level, not approval-dependent)
          if (!this.lightweightOptions && entry.toolCall.name === 'verify') {
          }
        }

        // Closed-loop feedback: auto-inject dev server errors after file modifications.
        // The brain (model) must see what the body (IDE) observed — build errors,
        // type errors, crashes — even if the model forgot to call read_dev_server_logs.
        if (!this.lightweightOptions) {
          const hasFileChanges = toolResults.some(r =>
            r && !r.isError && ['write_file', 'edit_file', 'create_file'].includes(r.toolCall.name)
          )
          if (hasFileChanges && devServerManager.isActive()) {
            // Wait for hot-reload + component mount + runtime execution.
            // 800ms was too short — runtime errors (e.g., bad API call in useEffect)
            // only appear after React mounts the component (~500-1000ms after HMR).
            // 1500ms catches both build errors AND runtime errors reliably.
            await new Promise(r => setTimeout(r, 1500))
            if (!this.abortController?.signal.aborted) {
              const devErrors = await this.getRecentDevServerErrors()
              if (devErrors) {
                messages.push({
                  role: 'user',
                  content: `[DEV_SERVER_FEEDBACK]\nThe dev server detected errors after your file changes:\n\n${devErrors}\n\nFix these errors before continuing. Use read_dev_server_logs for full output if needed.\n[/DEV_SERVER_FEEDBACK]`,
                })
              }
            }
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
  private async compressContext(messages: OpenAIMessage[]): Promise<OpenAIMessage[]> {
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
  private serializeMessagesForSummary(messages: OpenAIMessage[]): string {
    return messages.map(msg => {
      // Flatten content to text — multimodal user messages have
      // ContentPart[] which would otherwise stringify as "[object Object]".
      // Image parts become `[image]` markers in the summary.
      const text = contentAsText(msg.content)

      if (msg.role === 'user') {
        return `[USER]\n${text}`
      }

      if (msg.role === 'assistant') {
        const parts: string[] = []
        if (text) parts.push(`[ASSISTANT]\n${text}`)
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            parts.push(`[TOOL CALL: ${tc.function.name}]\n${tc.function.arguments}`)
          }
        }
        return parts.join('\n')
      }

      if (msg.role === 'tool') {
        return `[TOOL RESULT${msg.tool_call_id ? ` (${msg.tool_call_id})` : ''}]\n${text}`
      }

      return `[${msg.role}]\n${text}`
    }).join('\n\n---\n\n')
  }

  /**
   * Calls the dedicated /v1/summarize endpoint on the worker.
   * This endpoint: no streaming, no thinking (enable_thinking off), JSON response.
   */
  private async callSummarizationAPI(messages: OpenAIMessage[]): Promise<string> {
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
  private mechanicalFallback(messages: OpenAIMessage[]): string {
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

      // Extract tool call details
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          try {
            const args = JSON.parse(tc.function.arguments)
            const path = (args.path as string) || ''
            switch (tc.function.name) {
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

      // Capture tool results (both success and error).
      // Tool messages are always string content — contentAsText is a no-op
      // but keeps the narrow typed so TS is happy with the union.
      if (msg.role === 'tool' && msg.content) {
        const text = contentAsText(msg.content)
        if (text.startsWith('Error:')) {
          errors.push(text.slice(0, 300))
        } else if (text.length < 300) {
          // Short results are likely meaningful (e.g., "File updated: /path/to/file")
          toolResults.push(text)
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
  private microcompactToolResults(messages: OpenAIMessage[]): OpenAIMessage[] {
    // Find all indices of tool result messages
    const toolIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        toolIndices.push(i)
      }
    }

    // If fewer tool results than the threshold, no compaction needed
    if (toolIndices.length <= MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS) {
      return messages
    }

    // Indices to compact (all except the last N)
    const compactUpTo = toolIndices.length - MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS
    const indicesToCompact = new Set(toolIndices.slice(0, compactUpTo))

    return messages.map((msg, idx) => {
      if (!indicesToCompact.has(idx)) return msg
      const summary = this.summarizeToolResult(msg, idx, messages)
      return { ...msg, content: summary }
    })
  }

  /**
   * Generates a one-line summary for a tool result message.
   * Accepts msgIndex directly to avoid O(n) indexOf lookup.
   */
  private summarizeToolResult(toolMsg: OpenAIMessage, msgIndex: number, messages: OpenAIMessage[]): string {
    const toolCallId = toolMsg.tool_call_id
    // Tool results are always string content (tools return strings); the
    // union-type cast here is just to satisfy the new PromptValue-aware
    // content type without restructuring the tool handling path.
    const content = contentAsText(toolMsg.content) || ''

    // Short content or errors — keep as-is
    if (content.length < 200) return content
    if (content.startsWith('Error:')) return content

    // Find the matching tool call in a preceding assistant message
    if (toolCallId) {
      for (let i = msgIndex - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant' && msg.tool_calls) {
          const tc = msg.tool_calls.find(t => t.id === toolCallId)
          if (tc) {
            return this.buildToolSummaryLine(tc.function.name, tc.function.arguments, content)
          }
        }
      }
    }

    return content.slice(0, 150) + ' [... compacted]'
  }

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
  private async injectFileReReadings(messages: OpenAIMessage[]): Promise<void> {
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
    this.isRunning = false
    // forceEnd() bumps the QueryGuard's generation so the cancelled loop's
    // finally block sees a stale generation and skips its end() call.
    // This allows queue processing (or a fresh runAgentLoop) to start
    // without racing the cancelled loop's late finally.
    if (!this.lightweightOptions) {
      getQueryGuard().forceEnd()
    }
  }

  private async callAPI(messages: OpenAIMessage[]): Promise<Response> {
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

  private async callAPIOnce(messages: OpenAIMessage[]): Promise<Response> {
    const url = `${WORKER_URL}/v1/chat/completions`
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

  private async processStreamedTurn(
    response: Response,
    callbacks: AgentCallbacks
  ): Promise<TurnResult> {
    let textContent = ''
    let reasoningContent = ''
    let finishReason = ''
    let usage: { promptTokens: number; completionTokens: number } | null = null

    // Tool calls accumulator
    const toolCallsMap = new Map<number, {
      id: string
      name: string
      argsStr: string
    }>()

    // Detector for <think> blocks
    const thinkingDetector = createThinkingDetector()

    await parseSSEStream(response, {
      onEvent: (event: StreamEvent) => {
        switch (event.type) {
          case 'text_delta': {
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

          case 'tool_call_start': {
            toolCallsMap.set(event.index, {
              id: event.id,
              name: event.name,
              argsStr: '',
            })
            // Don't add to UI here — tool calls are shown AFTER text
            // narration completes (in runAgentLoop, after processStreamedTurn)
            break
          }

          case 'tool_call_args_delta': {
            const tc = toolCallsMap.get(event.index)
            if (tc) {
              tc.argsStr += event.argsDelta
            }
            break
          }

          case 'finish': {
            finishReason = event.reason
            break
          }

          case 'usage': {
            usage = {
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
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

          case 'done': {
            break
          }
        }
      },
    }, this.abortController?.signal)

    // Parse tool call arguments (now JSON is complete)
    const toolCalls = Array.from(toolCallsMap.values()).map(tc => {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.argsStr)
      } catch {
        args = { _raw: tc.argsStr, _parseError: true }
      }
      return { id: tc.id, name: tc.name, args }
    })

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
