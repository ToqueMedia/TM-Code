import ToolExecutor, { OpenAIToolDefinition } from './toolExecutor'
import DiffService from './diffService'
import { devServerManager } from '../devServerManager'
import FirebaseAuthService from '../auth/firebaseAuth'
import { ServiceError } from '../../utils/errors'
import { parseSSEStream, parseOpenAISSEStream, createThinkingDetector } from './streamParser'
import { getProfileForPlan } from './modelProfiles'
import { resolveThinkingHint } from './thinkingShapeDetection'
import { buildCompactPrompt, buildPostCompactionSummaryMessage, formatCompactSummary } from './compactPrompt'
import { archivePreCompactTranscript } from './compactTranscriptArchive'
import { streamLocalChat } from './byokLocalStream'
import { anthropicToOpenAIBody } from './anthropicToOpenai'
import { createDiffApprovalPromise, resolveAllPendingDiffApprovals, useChatStore } from '../../stores/chatStore'
import { useBillingStore } from '../../stores/billingStore'
import { useAgentStore } from '../../stores/agentStore'
import { useByokStore } from '../../stores/byokStore'
import { invoke } from '@/utils/invokeMetrics'
import { logger } from '../../utils/logger'
import { resolveWorkerUrl } from '../../utils/devUrls'
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
import { getAutoCompactThreshold } from '../../utils/contextWindow'

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

// Resolved via OS-aware helper — on Mac/Linux dev the env's 192.168.64.1 is
// auto-remapped to localhost. See src/utils/devUrls.ts for rationale.
const WORKER_URL = resolveWorkerUrl()
const MAX_OUTPUT_TOKENS = 32768
// Max auto-continuations when model hits token limit mid-response
const MAX_CONTINUATIONS = 3
// Max retries when the upstream→worker SSE drops mid-stream
// (worker emits `upstream_stream_interrupted` typed event). Separate from
// MAX_CONTINUATIONS because the trigger is network-side, not model-side.
// 1 retry = 2 total attempts. With the 90 s stream-idle watchdog in
// streamParser.ts, the worst case before surfacing to the user is
// 2 × 90 s = 3 min — bounded enough that the user gets feedback instead
// of staring at a frozen UI. Was 2 retries (4.5 min worst case) before
// the watchdog made the per-attempt cap reliable.
const MAX_INTERRUPT_RETRIES = 1

// Re-inject the top-violation-cost reminders into the tool_result user
// message every N tool-bearing turns. The full reminder lives at the top of
// the system prompt; after many turns of tool results, the tail is far
// from it and high-cost rules (complete files, dev-server logs, request_credentials)
// start drifting. Re-injection rebookmarks them without an extra round-trip.
//
// 5 is provisional — chosen as a midpoint between "noise" (every turn) and
// "useless" (every 15+ turns, where the dev_server_logs_skipped signal
// already fires). Calibrate against tool_call_per_turn / rule_drop_signal /
// critical_reminder_reinjected telemetry once dogfood data is in.
const REMINDER_REINJECT_INTERVAL_TURNS = 5
// Don't reinject until the session has accumulated enough tool calls to be
// "long". A 4-tool-call session doesn't need a recap.
const REMINDER_REINJECT_MIN_TOOLS = 10

// Context compression threshold is now token-absolute (claude-vaz pattern):
// effective window = raw − 20K (summary headroom)
// trigger          = effective − 13K (AUTOCOMPACT_BUFFER_TOKENS)
// See utils/contextWindow.ts and ContextWindowIndicator for the same math.
const DEFAULT_CONTEXT_WINDOW = 131_072  // Conservative fallback (128K)

// === BYOK thinking-param translation ===
//
// Each BYOK upstream expects its own thinking-toggle shape. Sending the wrong
// shape is silently ignored by the upstream — that was the root cause of the
// "thinking toggle has no effect under BYOK" bug.
//
//   anthropic                — thinking: { type: 'enabled' | 'disabled', budget_tokens? }
//   openai_reasoning_effort  — reasoning_effort: 'minimal' | 'medium'
//   qwen_enable_thinking     — enable_thinking: boolean
//   gemini_thinking_budget   — thinking_budget: number (0 = off)
//   openrouter_reasoning     — reasoning: { exclude: true } / { effort: 'medium' }
//   mimo_chat_template_kwargs — chat_template_kwargs: { enable_thinking: boolean }
//
// Some BYOK models are "thinking-by-default" (e.g. o1/o3) and cannot be turned
// fully off; we send the lowest effort instead so we at least minimise it.
//
// `openrouter_reasoning` exists because models routed via OpenRouter (e.g.
// xiaomi/mimo-v2.5-pro) silently ignore `reasoning_effort` (OpenAI shape)
// and `enable_thinking` (Qwen shape). The OpenRouter-native `reasoning.*`
// object is the only shape they honour. We send `{ reasoning: { exclude: true } }`
// to disable rather than `{ reasoning: { enabled: false } }` because some
// mandatory-reasoning models on OpenRouter reject `enabled: false`;
// `exclude: true` is universal — the model still reasons internally but
// doesn't emit reasoning tokens, so we don't waste display surface on it.
//
// `mimo_chat_template_kwargs` is the official Xiaomi MiMo API shape (used by
// platform.xiaomimimo.com and self-hosted MiMo via SGLang). Unlike Qwen
// which takes `enable_thinking` at the top level, MiMo's template wraps it
// in `chat_template_kwargs.enable_thinking`. Mistaking one for the other is
// silent — both APIs accept extra top-level fields, so the model just
// keeps reasoning while the param is ignored.
type ByokThinkingShape =
  | 'anthropic'
  | 'openai_reasoning_effort'
  | 'qwen_enable_thinking'
  | 'gemini_thinking_budget'
  | 'openrouter_reasoning'
  | 'mimo_chat_template_kwargs'
  | 'moonshot_thinking'

const BYOK_THINKING_BUDGET_TOKENS = 8_192
const BYOK_GEMINI_THINKING_BUDGET = 24_000

function buildByokThinkingParam(
  hint: { supportsThinking: boolean; thinkingShape?: ByokThinkingShape },
  enabled: boolean,
): Record<string, unknown> | null {
  if (!hint.supportsThinking || !hint.thinkingShape) return null
  switch (hint.thinkingShape) {
    case 'anthropic':
      return enabled
        ? { thinking: { type: 'enabled', budget_tokens: BYOK_THINKING_BUDGET_TOKENS } }
        : { thinking: { type: 'disabled' } }
    case 'openai_reasoning_effort':
      return { reasoning_effort: enabled ? 'medium' : 'minimal' }
    case 'qwen_enable_thinking':
      return { enable_thinking: enabled }
    case 'gemini_thinking_budget':
      return { thinking_budget: enabled ? BYOK_GEMINI_THINKING_BUDGET : 0 }
    case 'openrouter_reasoning':
      return enabled
        ? { reasoning: { effort: 'medium' } }
        : { reasoning: { exclude: true } }
    case 'mimo_chat_template_kwargs':
      return { chat_template_kwargs: { enable_thinking: enabled } }
    case 'moonshot_thinking':
      // Kimi-specific `thinking` extension. The k2-thinking* SKUs reason
      // unconditionally regardless of this flag — the param is meaningful
      // only on K2.5 / K2.6 which expose both modes. Shape mirrors the
      // Anthropic-style nested object, the closest convention to what the
      // Kimi platform documents.
      return enabled
        ? { thinking: { type: 'enabled' } }
        : { thinking: { type: 'disabled' } }
  }
}


// Context window is reported by the backend via X-Model-Context-Window header.
// The backend's MODEL_CONTEXT_WINDOWS in proxy.ts is the source of truth;
// a per-profile fallback is also set in callAPI() from profile.contextWindow.
// We previously kept a name→size table here for inference when neither was
// available, but it went stale fast (referenced legacy models like
// openrouter/hunter-alpha that the May 2026 routing doesn't serve) and no
// caller actually used it. DEFAULT_CONTEXT_WINDOW is now the only emergency
// fallback if both the header and the profile are absent.
// Minimum recent turns to preserve in full (not compressed).
// Actual value is adaptive: scales with conversation length (min 4, max 12).
const MIN_KEEP_RECENT_TURNS = 4
const MAX_KEEP_RECENT_TURNS = 12

// Layer 1: Microcompaction — keep last N tool results in full, compact older ones.
// A typical turn has 1-3 tool calls; 8 means ~3-4 recent turns have full results.
const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 8

// Time-based microcompaction (claude-vaz parity, services/compact/timeBasedMCConfig.ts).
// When (now − last assistant timestamp) exceeds this gap, switch to a more
// aggressive keepRecent. Rationale: the upstream's prompt-cache TTL is 1h, so
// after 60min of idle the cache is GUARANTEED expired — the full prefix gets
// retransmitted anyway. Shrinking the prefix BEFORE the request shortens the
// retransmit. We use a 60min threshold to match the cache TTL exactly.
const MICROCOMPACT_GAP_THRESHOLD_MS = 60 * 60 * 1000
// Aggressive mode keep count — 5 (vs default 8) when the gap fires.
const MICROCOMPACT_GAP_KEEP_RECENT = 5
// Maximum files to re-read after compaction for context recovery.
const POST_COMPACTION_REREAD_FILES = 5
// Max chars per re-read file (prevents re-blowing context).
const POST_COMPACTION_FILE_MAX_CHARS = 8000

// Compact-summary prompt + post-processing live in a zero-dependency
// module so they can be unit-tested without the store/Firebase chain.
// See `compactPrompt.ts` for the claude-vaz-parity prompt body.

// === Callbacks ===

export interface AgentCallbacks {
  // Streaming text (token by token)
  onTextDelta: (text: string) => void

  // Streaming reasoning (token by token, collapsible in UI)
  onReasoningDelta: (text: string) => void

  // Reasoning block formally closed by the upstream (content_block_stop for
  // a thinking block). Use this to flush any buffered reasoning deltas
  // immediately so the visible block is complete before the next phase
  // (tool calls / final answer) begins. Without this, the delta buffer's
  // 50ms timer races against the next content_block_start and can leave
  // the last reasoning fragment unflushed.
  onReasoningComplete?: () => void

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
  /** Wall-clock timestamp (ms) of the last completed assistant turn. Drives
   *  time-based microcompaction: when the gap before the next API call
   *  exceeds MICROCOMPACT_GAP_THRESHOLD_MS (60min, the upstream cache TTL),
   *  we switch to a more aggressive keepRecent because the cache is
   *  guaranteed expired and the full prefix gets retransmitted anyway.
   *  Persists across `runAgentLoop` invocations on the singleton instance
   *  so idle-between-prompts gaps are measured correctly. Null until the
   *  first assistant turn completes. */
  private lastAssistantMessageAt: number | null = null
  /** Context window size (tokens) — updated from API usage if available. */
  private contextWindowSize = DEFAULT_CONTEXT_WINDOW
  /** SSE shape produced by the most recent callAPIOnce. processStreamedTurn
   *  consults this to pick parseSSEStream (Anthropic, the default for both
   *  TMS-routed and cloud BYOK) vs parseOpenAISSEStream (local BYOK —
   *  Ollama / LM Studio /v1/chat/completions). */
  private lastResponseShape: 'anthropic' | 'openai' = 'anthropic'
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
  // ── Phase A tool-call pattern telemetry ──────────────────────────────────
  // These counters answer: "how many tool calls before the model drops rule X?".
  // They're additive (no behaviour change) — the data feeds Phase C's decision
  // on the right re-injection interval for critical reminders.
  /** Per-run cumulative tool-call count across all turns. Reset on new session. */
  private cumulativeToolCalls = 0
  /** Monotonically incremented per tool-result-bearing turn. */
  private turnIndex = 0
  /** Writes (write/edit/create_file) since the last read_dev_server_logs while
   *  a dev server is active. Resets to 0 on a read_dev_server_logs call. */
  private writesWithoutDevServerLogs = 0
  /** Tool-bearing turns since the last critical-reminder re-injection.
   *  Counter advances per turn; reaches REMINDER_REINJECT_INTERVAL_TURNS → fire + reset. */
  private turnsSinceLastReminder = 0

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
   * Whether the next turn will have reasoning ON. Computed from the same
   * inputs `buildRequestBody` uses internally so the UI can stamp the
   * assistant message with `thinkingRequested` at start time and the
   * MessageBubble can hide reasoning blocks when the user didn't ask for
   * them (defense in depth — some BYOK reasoning models keep emitting
   * reasoning even when the disable param is honoured).
   */
  isThinkingRequestedForNextTurn(): boolean {
    // Reasoning is always ON when the active model supports it (claude-vaz
    // parity: thinking follows the model's default; the user has no toggle).
    // Slash commands no longer "force" reasoning via this path — both
    // GLM-5.1 (paid) and DeepSeek V4-Flash (free) already think every turn.
    // For models without thinking capability (profile.supportsThinking=false)
    // this returns false and the chat UI hides reasoning blocks accordingly.
    //
    // Reads the active plan's profile synchronously — no await/dynamic
    // import — because this is called by the chat UI to stamp the
    // assistant message at turn start (before the async buildRequestBody
    // path runs). Falls back to false if the billing/profile stores
    // haven't hydrated yet — the worst case is one turn of reasoning
    // blocks rendered without the "thinking" framing.
    try {
      const plan = useBillingStore.getState().plan
      const profile = getProfileForPlan(plan)
      return profile.supportsThinking === true
    } catch {
      return false
    }
  }

  /**
   * Refreshes the tool definitions (call after MCP tools are registered/changed).
   */
  refreshTools(): void {
    this.tools = this.toolExecutor.getToolDefinitions()
  }

  /** Whether reasoning_content should be preserved in conversation history
   *  between turns. claude-vaz parity: ALWAYS true. Models that can't
   *  accept reasoning_content back (DeepSeek V3.2 historically returned
   *  400) are handled server-side — the proxy strips the field for the
   *  upstreams that reject it. The frontend's job is to keep the chain
   *  of thought intact in conversation history so multi-turn reasoning
   *  doesn't lose context. Hard-coded true (was profile-driven, but both
   *  active profiles set it true anyway). */
  private preserveReasoningBetweenTurns = true


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
  private async buildRequestBody(
    messages: AnthropicMessage[],
    byokThinkingHint: { supportsThinking: boolean; thinkingShape?: ByokThinkingShape } | null = null,
  ): Promise<Record<string, unknown>> {
    try {
      const { buildSamplingParams, buildThinkingParam } = await import('./modelProfiles')
      const { useBillingStore } = await import('../../stores/billingStore')
      const plan = useBillingStore.getState().plan
      const profile = getProfileForPlan(plan)

      // Reasoning is always ON when the active model supports it
      // (claude-vaz parity). The previous request-type-driven forcing
      // (/plan, /debug, /review, /te2e setting `forceThinking` via
      // X-Request-Type) was made redundant by this rule — every active
      // coder profile (DeepSeek V4-Flash, GLM-5.1) sets supportsThinking
      // true, so reasoning is on by default for every turn. The header is
      // still sent for the backend's analytics/routing purposes; it just
      // no longer changes the thinking decision here.
      const isThinking = profile.supportsThinking === true

      // Filter tools based on model capabilities.
      // web_search is exposed to the model when profile.supportsSearch is true.
      //   - DashScope-native (DeepSeek, Qwen): provider resolves enable_search server-side.
      //   - Non-native (GLM-5.1): frontend execute() side-cars the query to Qwen
      //     via X-Request-Type: 'web_search' and returns the answer as tool_result.
      const filteredTools = this.tools.filter(t => {
        if (t.function.name === 'web_search') {
          return profile.supportsSearch
        }
        return true
      })

      // Convert tools to Anthropic format. The LAST tool gets a
      // `cache_control: { type: 'ephemeral' }` marker — the Anthropic
      // prompt-caching spec caches the request prefix UP TO any block
      // carrying that marker, so the entire tools array (the largest
      // stable prefix segment, ~10K tokens of schemas) becomes one
      // cache entry. The marker is harmless on upstreams that don't
      // support caching (treated as an extra field and ignored). For
      // BYOK users on Anthropic-native it's an immediate cost win;
      // for DashScope/OpenRouter the worker has the hint available
      // to use for its own server-side cache key in the future.
      // Reference: claude-vaz utils/api.ts:72-133.
      const anthropicTools = filteredTools.map((t, idx, arr) => {
        const base = {
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }
        return idx === arr.length - 1
          ? { ...base, cache_control: { type: 'ephemeral' as const } }
          : base
      })

      // Anthropic Messages API body — system is top-level, not in messages.
      // System is sent as a single-block array (not a bare string) so we
      // can attach cache_control. Anthropic accepts BOTH shapes; the
      // converter at anthropicToOpenai.ts:79-86 already collapses the
      // array form to a string for local BYOK paths (Ollama/LM Studio)
      // where caching doesn't apply.
      const body: Record<string, unknown> = {
        system: [
          {
            type: 'text' as const,
            text: this.systemPrompt,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
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

      // BYOK overrides the plan-profile thinking shape. Anthropic/OpenAI/
      // Gemini upstreams silently ignore qwen-style `enable_thinking` and
      // openrouter-style `reasoning.enabled`, so the toggle had no effect
      // for those providers before this branch existed (root cause of the
      // "thinking still shows when toggle is OFF" bug). When BYOK is
      // active, build the param in the BYOK model's native shape and
      // skip the plan profile's shape entirely.
      if (byokThinkingHint) {
        const byokParam = buildByokThinkingParam(byokThinkingHint, isThinking)
        if (byokParam) Object.assign(body, byokParam)
      } else {
        const thinking = buildThinkingParam(profile, isThinking)
        if (thinking) {
          Object.assign(body, thinking)
        }
      }

      return body
    } catch {
      // Emergency fallback when dynamic imports fail. Keep cache_control
      // markers consistent with the main path — they cost nothing where
      // unsupported and the upstream-routing rules are the same.
      const filteredTools = this.tools.filter(t => t.function.name !== 'web_search')
      const body: Record<string, unknown> = {
        system: [
          {
            type: 'text' as const,
            text: this.systemPrompt,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        messages,
        tools: filteredTools.map((t, idx, arr) => {
          const base = {
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          }
          return idx === arr.length - 1
            ? { ...base, cache_control: { type: 'ephemeral' as const } }
            : base
        }),
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
      this.cumulativeToolCalls = 0
      this.turnIndex = 0
      this.writesWithoutDevServerLogs = 0
      this.turnsSinceLastReminder = 0
      this.toolExecutor.resetSessionState()
    }
    if (isMainAgentNewSession) {
      // Reset the UI mirror counter so the Experimental tab shows a fresh
      // count for the new session.
      try {
        const { useAgentStore } = await import('../../stores/agentStore')
        useAgentStore.getState().resetPoolConflictsAvoided()
        useAgentStore.getState().resetToolCallCounters()
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
        // preserveReasoningBetweenTurns is hard-coded true at the class
        // field (claude-vaz parity). The proxy strips reasoning_content
        // for upstreams that reject it; we keep it intact in conversation
        // history regardless.
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
    let interruptRetryCount = 0
    let enforcementRetries = 0
    const MAX_ENFORCEMENT_RETRIES = 3

    try {
      const maxTurns = this.lightweightOptions?.maxTurns ?? Infinity
      while (turnCount < maxTurns) {
        if (this.abortController?.signal.aborted) return

        turnCount++
        // turnCount tracked for telemetry and max-turns enforcement

        // Layer 2: Compress context if approaching token limit.
        // Token-absolute (claude-vaz pattern): threshold = effective − 13K,
        // effective = raw − 20K (summary headroom). Same math the ctx
        // indicator displays so the pill's red zone and compression fire
        // together — no drift between UI and behaviour.
        const compressionThreshold = getAutoCompactThreshold(this.contextWindowSize)
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
        //
        // Time-based mode: when the gap since the last assistant turn
        // exceeds the upstream cache TTL (~60min), the prompt cache is
        // guaranteed expired and the full prefix gets retransmitted by
        // the upstream regardless. Shrinking the prefix BEFORE the
        // request shortens that retransmit — saves cost on the request
        // that would have paid full price anyway. Sub-agents skip this
        // because their short lifetimes mean gap-eviction doesn't apply
        // (the gap field is null for them too — extra defence).
        let microcompactKeepRecent = MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS
        if (!this.lightweightOptions && this.lastAssistantMessageAt !== null) {
          const gapMs = Date.now() - this.lastAssistantMessageAt
          if (gapMs > MICROCOMPACT_GAP_THRESHOLD_MS) {
            microcompactKeepRecent = MICROCOMPACT_GAP_KEEP_RECENT
            logger.info(
              'agent',
              `[microcompact] time-based eviction firing: gap=${Math.round(gapMs / 60_000)}min > ${MICROCOMPACT_GAP_THRESHOLD_MS / 60_000}min — keepRecent=${MICROCOMPACT_GAP_KEEP_RECENT} (default ${MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS})`,
            )
          }
        }
        const apiMessages = this.microcompactToolResults(messages, microcompactKeepRecent)

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

        // Stamp the assistant-turn timestamp so the NEXT API call can compute
        // gap-since-last-turn for time-based microcompaction. We update
        // regardless of finishReason — even a stream_interrupted turn produced
        // some output and committed wall-clock time. Sub-agents skip (their
        // `lastAssistantMessageAt` is unused; main-agent only).
        if (!this.lightweightOptions) {
          this.lastAssistantMessageAt = Date.now()
        }

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

        // Handle mid-stream upstream interruption — set by processStreamedTurn
        // when the parser receives the worker's `upstream_stream_interrupted`
        // typed event. The conversation state is intact; we re-send the same
        // turn with any partial text/reasoning preserved (so the user doesn't
        // see flicker) and a continuation hint to the model. Capped separately
        // from `length` continuations because the failure modes are different
        // — `length` means "model has more to say"; `stream_interrupted` means
        // "network blip, model may or may not have actually emitted anything".
        if (turnResult.finishReason === 'stream_interrupted' && interruptRetryCount < MAX_INTERRUPT_RETRIES) {
          interruptRetryCount++
          const partialBlocks: AnthropicContentBlock[] = []
          if (this.preserveReasoningBetweenTurns && turnResult.reasoningContent) {
            partialBlocks.push({ type: 'thinking', thinking: turnResult.reasoningContent })
          }
          if (turnResult.textContent) {
            partialBlocks.push({ type: 'text', text: turnResult.textContent })
          }
          // If nothing was emitted yet, just re-send the original last user
          // message (skip the assistant placeholder + continue prompt). The
          // model gets the same input and produces a fresh response.
          if (partialBlocks.length === 0) {
            logger.info('agent', `[stream] retry ${interruptRetryCount}/${MAX_INTERRUPT_RETRIES}: empty partial, re-issuing same turn`)
          } else {
            messages.push({
              role: 'assistant',
              content: partialBlocks,
            })
            messages.push({
              role: 'user',
              content: 'The previous response was cut off by a network issue. Continue exactly where you left off — do not restart, do not summarise, do not apologise.',
            })
            logger.info('agent', `[stream] retry ${interruptRetryCount}/${MAX_INTERRUPT_RETRIES}: appended partial (${(turnResult.textContent || '').length} chars text, reasoning=${!!turnResult.reasoningContent})`)
          }
          // Visible feedback so the user knows the retry is firing.
          try {
            useChatStore.getState().addSystemMessage(
              `Retry ${interruptRetryCount}/${MAX_INTERRUPT_RETRIES} — resuming from where the stream dropped.`,
              undefined,
              { ephemeral: true },
            )
          } catch { /* chatStore may be torn down */ }
          callbacks.onTurnComplete(turnCount)
          continue
        }
        if (turnResult.finishReason === 'stream_interrupted' && interruptRetryCount >= MAX_INTERRUPT_RETRIES) {
          // Exhausted retries — propagate the failure to the UI so the user
          // can take over. The conversation state is preserved; they can
          // type a new prompt or click Stop.
          logger.error('agent', `[stream] exhausted ${MAX_INTERRUPT_RETRIES} retries — surfacing to user`)
          callbacks.onError(new ServiceError(
            `Model stream was interrupted ${MAX_INTERRUPT_RETRIES + 1} times in a row. Check your connection and try again.`,
            'STREAM_INTERRUPTED_EXHAUSTED',
            false,
          ))
          break
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

        // ── Phase A: tool-call pattern telemetry ────────────────────────────
        // Measure per-turn shape so Phase C can pick a calibrated re-injection
        // interval instead of an arbitrary one. Additive — no behaviour change.
        if (!this.lightweightOptions) {
          this.turnIndex += 1
          const validResults = toolResults.filter((e): e is DrainEntry => e !== null)
          const namesThisTurn = validResults.map(e => e.toolCall.name)
          const writesThisTurn = namesThisTurn.filter(n =>
            n === 'write_file' || n === 'edit_file' || n === 'create_file'
          ).length
          const hasReadDevLogs = namesThisTurn.includes('read_dev_server_logs')
          const hasReads = namesThisTurn.some(n =>
            n === 'read_file' || n === 'list_directory' || n === 'search_files'
            || n === 'glob' || n === 'get_diagnostics' || n === 'read_large_result'
          )
          this.cumulativeToolCalls += validResults.length
          if (hasReadDevLogs) this.writesWithoutDevServerLogs = 0
          else this.writesWithoutDevServerLogs += writesThisTurn

          // Mirror to agentStore for status-bar / debug-overlay visibility.
          try {
            const { useAgentStore } = await import('../../stores/agentStore')
            const store = useAgentStore.getState()
            store.bumpCumulativeToolCalls(validResults.length)
            store.setWritesWithoutDevServerLogs(this.writesWithoutDevServerLogs)
          } catch { /* non-critical */ }

          // Per-turn event — answers "how many tool calls per turn typically?"
          import('../../services/analytics').then(({ trackEvent }) => {
            void trackEvent('tool_call_per_turn', {
              turn_index: this.turnIndex,
              tools_in_turn: validResults.length,
              cumulative_tools: this.cumulativeToolCalls,
              writes_in_turn: writesThisTurn,
              has_reads: hasReads,
              has_read_dev_server_logs: hasReadDevLogs,
              writes_without_dev_server_logs: this.writesWithoutDevServerLogs,
              tool_names: namesThisTurn.slice(0, 20).join(','),
            })
          }).catch(() => {})

          // Signal: ≥3 file writes without a dev-server-log read while a dev
          // server is active — the model is drifting past Reminder #2 of the
          // system prompt. Emit once per crossing so the data stays tractable.
          if (
            this.writesWithoutDevServerLogs >= 3
            && writesThisTurn > 0
            && devServerManager.isActive()
          ) {
            import('../../services/analytics').then(({ trackEvent }) => {
              void trackEvent('rule_drop_signal', {
                rule: 'dev_server_logs_skipped',
                writes_count: this.writesWithoutDevServerLogs,
                cumulative_tools: this.cumulativeToolCalls,
                turn_index: this.turnIndex,
              })
            }).catch(() => {})
          }

          // Signal: short file overwrites (< 100 chars). High-confidence
          // proxy for "model omitted the rest of the file" — Reminder #1.
          for (const entry of validResults) {
            const name = entry.toolCall.name
            if (name !== 'write_file' && name !== 'create_file') continue
            const args = entry.toolCall.args as { content?: unknown; path?: unknown }
            const content = typeof args.content === 'string' ? args.content : null
            if (content && content.length > 0 && content.length < 100) {
              import('../../services/analytics').then(({ trackEvent }) => {
                void trackEvent('rule_drop_signal', {
                  rule: 'short_overwrite',
                  tool: name,
                  path: typeof args.path === 'string' ? args.path : 'unknown',
                  content_length: content.length,
                  cumulative_tools: this.cumulativeToolCalls,
                  turn_index: this.turnIndex,
                })
              }).catch(() => {})
            }
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

        // ── Phase C: critical reminder re-injection ─────────────────────────
        // After many turns of tool results, the static reminder at the top of
        // the system prompt drifts far from the tail the model attends to most.
        // Re-inject the top-violation-cost rules into THIS user message (same
        // envelope as the tool_results — no extra round-trip, no consecutive-
        // user violation) every REMINDER_REINJECT_INTERVAL_TURNS turns, but
        // only once the session is past REMINDER_REINJECT_MIN_TOOLS so short
        // sessions don't get spammed.
        if (
          !this.lightweightOptions
          && this.cumulativeToolCalls >= REMINDER_REINJECT_MIN_TOOLS
        ) {
          this.turnsSinceLastReminder += 1
          if (this.turnsSinceLastReminder >= REMINDER_REINJECT_INTERVAL_TURNS) {
            const { getCriticalReinjectionReminder } = await import(
              './contextBuilder/sections/chatSections'
            )
            toolResultBlocks.push({
              type: 'text',
              text: getCriticalReinjectionReminder(),
            } as AnthropicContentBlock)
            const turnsBeforeReset = this.turnsSinceLastReminder
            this.turnsSinceLastReminder = 0
            import('../../services/analytics').then(({ trackEvent }) => {
              void trackEvent('critical_reminder_reinjected', {
                turn_index: this.turnIndex,
                cumulative_tools: this.cumulativeToolCalls,
                turns_since_last: turnsBeforeReset,
                writes_without_dev_server_logs: this.writesWithoutDevServerLogs,
              })
            }).catch(() => {})
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

            // Split the streaming assistant message: finalise the current
            // bubble (so the work-so-far is visible as a complete reply),
            // append the user's queued message AT THE END (where their
            // viewport is locked by stick-to-bottom — placing it above the
            // streaming assistant makes the bubble appear off-screen and
            // the user reports the message "disappeared"), and start a new
            // streaming assistant. Subsequent deltas/tool calls land in
            // the new bubble.
            try {
              const { useChatStore: chatStoreImport } = await import('../../stores/chatStore')
              chatStoreImport.getState().splitForQueuedMessage(
                displayText,
                displayAttachments,
                promptBlocksList,
              )
            } catch { /* non-critical */ }

            // Append to the tool_results user message (avoids consecutive
            // user msgs in the API conversation). The INTERRUPT framing
            // tells the model the message is a side-channel from the
            // developer — address it inline, then RESUME the original
            // task. Without this hint, the model treats the message as a
            // topic change, replies once, and exits the loop early —
            // leaving the in-progress task half-done.
            toolResultBlocks.push({
              type: 'text',
              text: `[USER_MESSAGE_INTERRUPT]
The developer sent a side-channel message while you were mid-task. Address it inline as part of your next response, then RESUME the original task without asking for confirmation. Do NOT call onDone, do NOT treat this as the end of the session, do NOT abandon the in-progress work — your goal is unchanged unless the developer explicitly says "stop" or "cancel".

Developer message: ${displayText}
[/USER_MESSAGE_INTERRUPT]`,
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

          // Post-turn memory extraction. Fire-and-forget on the main
          // agent only — sub-agents share their parent's session and
          // shouldn't trigger their own extraction passes (would duplicate
          // proposals for the same exchange). Skip when the user message
          // wasn't a plain string (image attachments, structured input)
          // because the extractor expects text. Failures are silent;
          // proposals are nice-to-have, not load-bearing.
          if (!this.lightweightOptions && typeof userMessage === 'string') {
            void this.runMemoryExtractor(userMessage, turnResult.textContent || '')
              .catch(() => { /* non-fatal */ })
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

            // Same split as mid-turn drain — finalise the current assistant
            // bubble, drop the user's queued message at the end where their
            // scroll lock keeps the viewport, start a fresh streaming
            // assistant for the response.
            try {
              const { useChatStore: chatStoreImport } = await import('../../stores/chatStore')
              chatStoreImport.getState().splitForQueuedMessage(displayText, displayAttachments)
            } catch { /* non-critical */ }

            // Different framing from mid-turn drain: pre-exit fires when the
            // model wanted to STOP. The queued message is now the developer's
            // follow-up — there's no in-progress task to "resume", just a
            // request to address. Plain USER_MESSAGE wrapper is enough.
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

      callbacks.onError(new ServiceError(
        `Agent exceeded maximum turns (${maxTurns})`,
        'TURN_LIMIT',
        false,
      ))
    } catch (error) {
      // Clean exit on abort — don't treat as error
      if (this.abortController?.signal.aborted) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      // Pass through ServiceErrors verbatim (their `code` drives the UI's
      // post-error UX — error-aware system messages, retry hints, etc).
      // Wrap plain throws into a generic ServiceError so downstream code
      // can rely on `error.code` always being set without a regex fallback.
      if (error instanceof ServiceError) {
        callbacks.onError(error)
      } else if (error instanceof Error) {
        callbacks.onError(new ServiceError(error.message, 'UNKNOWN_ERROR', false))
      } else {
        callbacks.onError(new ServiceError(String(error), 'UNKNOWN_ERROR', false))
      }
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
        if (this.summarizationFailures > 0) {
          // Recovered before tripping the breaker — log once so the
          // mechanical-fallback streak ends visibly in telemetry.
          logger.info('agent', `[compaction] summarization recovered after ${this.summarizationFailures} failure(s) — back to LLM summaries`)
        }
        this.summarizationFailures = 0 // reset on success
      } catch (err) {
        this.summarizationFailures++
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn('agent', `Summarization failed (${this.summarizationFailures}/3) — using mechanical fallback. Reason: ${reason}`)
        // Surface the transition to the user when the breaker just tripped.
        // Below 3 is a single hiccup — silent fallback is fine. At exactly 3
        // every subsequent compaction is mechanical (lower-quality summary
        // = lower-quality recovered context), so the user needs to know
        // their session is degrading and a restart will help. Single shot
        // per breaker open — don't spam.
        if (this.summarizationFailures === 3 && !this.lightweightOptions) {
          try {
            useChatStore.getState().addSystemMessage(
              'Compaction is using a mechanical fallback after 3 LLM-summarize failures. Recovered context may be lower-quality from now on. Open a new chat for a fresh start, or wait for the upstream to recover.',
            )
          } catch { /* chatStore may be torn down */ }
        }
        summary = this.mechanicalFallback(oldMessages)
      }
    }

    // Archive the pre-compact transcript to disk so the model can recover
    // exact details (code snippets, verbatim user phrasing, full error
    // messages) the summary lossily dropped. Fire-and-forget read of
    // active session+project; archive failure falls through to a null
    // path which the summary message handles gracefully.
    let transcriptPath: string | null = null
    try {
      const [{ useChatStore }, { useProjectStore }] = await Promise.all([
        import('../../stores/chatStore'),
        import('../../stores/projectStore'),
      ])
      const sessionId = useChatStore.getState().activeSessionId
      const projectPath = useProjectStore.getState().currentProject?.path
      if (sessionId && projectPath) {
        transcriptPath = await archivePreCompactTranscript(
          projectPath,
          sessionId,
          oldMessages as unknown as Array<{ role: string; content: string | Array<Record<string, unknown>> | null }>,
        )
        if (transcriptPath) {
          logger.info('agent', `[compaction] archived ${oldMessages.length} pre-compact messages to ${transcriptPath}`)
        }
      }
    } catch (err) {
      logger.warn('agent', '[compaction] transcript archive failed (non-fatal):', err)
    }

    return [
      systemMsg,
      {
        role: 'user' as const,
        content: buildPostCompactionSummaryMessage(summary, {
          transcriptPath,
          recentMessagesPreserved: recentMessages.length > 0,
        }),
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
   *
   * Prompt structure ported from claude-vaz services/compact/prompt.ts:
   * (a) NO_TOOLS_PREAMBLE + trailer — belt-and-braces "text-only response"
   *     guards. Our /v1/summarize endpoint already disables tools server-side
   *     so this is redundant for our worker, but matters when /v1/summarize
   *     itself runs on a model that interprets the conversation history as
   *     a tool-aware context (the DashScope summarizer model occasionally
   *     tries to "call" a tool from the previous turn's tool_use blocks).
   * (b) 9-section output — Primary Request / Key Technical Concepts /
   *     Files and Code Sections / Errors and Fixes / Problem Solving /
   *     All user messages / Pending Tasks / Current Work / **Optional
   *     Next Step**. The last two — Current Work + Optional Next Step —
   *     are what give the agent "I was halfway through Y, next is Z"
   *     continuity after auto-compact. The bullet-list prompt this
   *     replaces had 7 sections and was missing both.
   * (c) `<analysis>` drafting block — the model thinks before writing the
   *     summary. Stripped post-hoc by formatCompactSummary().
   */
  /**
   * Fire-and-forget post-turn memory extraction. Reads the (userMessage,
   * assistantText) tuple plus the current memdir names, asks the per-plan
   * extractor model for proposals, persists them as pending proposals so
   * the NEXT turn's prompt builder surfaces them to the agent.
   *
   * Errors are swallowed deliberately — extraction is opportunistic; if
   * the side-car call fails for any reason the agent loop carries on
   * with the existing "agent saves what it noticed" discipline.
   */
  private async runMemoryExtractor(
    userMessage: string,
    assistantText: string,
  ): Promise<void> {
    try {
      const [
        { extractMemoriesFromTurn },
        { recordProposals },
        { invalidateMemorySelectorCache },
        { loadMemoryIndex, parseIndexEntries },
        { useProjectStore },
      ] = await Promise.all([
        import('./memoryExtractor'),
        import('./memoryProposalsStore'),
        import('./memorySelector'),
        import('./memdir'),
        import('../../stores/projectStore'),
      ])

      const projectPath = useProjectStore.getState().currentProject?.path ?? null

      // Collect existing memory names so the extractor doesn't re-propose
      // entries the developer (or a previous turn) already saved.
      const [userResult, projectResult] = await Promise.all([
        loadMemoryIndex('user'),
        projectPath
          ? loadMemoryIndex('project', projectPath)
          : Promise.resolve({ content: null } as { content: string | null }),
      ])
      const existingNames: string[] = []
      if (userResult.content) {
        for (const e of parseIndexEntries(userResult.content)) existingNames.push(e.name)
      }
      if (projectResult.content) {
        for (const e of parseIndexEntries(projectResult.content)) existingNames.push(e.name)
      }

      const result = await extractMemoriesFromTurn({
        userMessage,
        assistantText,
        existingNames,
      })

      if (result.proposals.length > 0) {
        await recordProposals(projectPath, result.proposals)
        // Bust the selector cache — the next prompt build's MEMORY.md
        // hasn't changed yet but the proposals reminder is part of the
        // dynamic block; clearing keeps cache state predictable.
        invalidateMemorySelectorCache()
      }

      // Telemetry — measure extractor yield vs cost in aggregate.
      void import('../../services/analytics').then(({ trackEvent }) =>
        trackEvent('memory_extractor_run', {
          proposals: result.proposals.length,
          latency_ms: result.latencyMs,
          existing_count: existingNames.length,
        }),
      ).catch(() => { /* analytics never blocks */ })
    } catch (err) {
      logger.debug('agent', '[memory-extractor] post-turn run failed:', err)
    }
  }

  private async callSummarizationAPI(messages: AnthropicMessage[]): Promise<string> {
    const serialized = this.serializeMessagesForSummary(messages)

    const summaryPrompt = buildCompactPrompt()

    const url = `${WORKER_URL}/v1/summarize`
    const firebaseToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!firebaseToken) throw new Error('Auth expired during compression')

    // Wall-clock timeout so a stalled /v1/summarize call can't hang the
    // agent loop indefinitely. Compaction is triggered between turns
    // (`agentService.ts:651-669`) — without this timeout, a hung summarize
    // fetch holds the UI on its previous state (e.g. "Wrote" after the
    // last write_file) and the user has no way out short of Stop. The
    // catch site at line 1287 routes timeouts to `mechanicalFallback`,
    // so the loop continues with degraded-but-functional context.
    // 90 s aligns with the SSE idle watchdog in streamParser.ts.
    const SUMMARIZE_TIMEOUT_MS = 90_000
    const timeoutCtl = new AbortController()
    const onParentAbort = () => timeoutCtl.abort()
    const parentSignal = this.abortController?.signal
    if (parentSignal?.aborted) {
      timeoutCtl.abort()
    } else {
      parentSignal?.addEventListener('abort', onParentAbort)
    }
    const timeoutId = setTimeout(() => timeoutCtl.abort(), SUMMARIZE_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, {
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
        signal: timeoutCtl.signal,
      })
    } catch (err) {
      if (timeoutCtl.signal.aborted && !parentSignal?.aborted) {
        logger.warn('agent', `[compaction-watchdog] /v1/summarize timed out after ${SUMMARIZE_TIMEOUT_MS / 1000}s — falling back to mechanical compaction`)
        throw new Error(`Summarization API timeout after ${SUMMARIZE_TIMEOUT_MS / 1000}s — falling back to mechanical compaction`)
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
      parentSignal?.removeEventListener('abort', onParentAbort)
    }

    if (!response.ok) {
      throw new Error(`Summarization API failed: ${response.status}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }

    const rawContent = data.choices[0]?.message?.content || ''
    if (rawContent.length < 100) {
      throw new Error('Summary too short or empty — falling back to mechanical extraction')
    }
    // Strip the `<analysis>` drafting scratchpad and unwrap the `<summary>`
    // tag before the summary becomes context for the next turn. The model
    // was instructed to write both blocks; we keep the value of the
    // analysis (it improves summary quality during generation) without
    // paying the token cost in subsequent turns. If the model didn't
    // emit the tags (older models, generation drift), formatCompactSummary
    // returns the original text unchanged.
    return formatCompactSummary(rawContent)
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
  private microcompactToolResults(
    messages: AnthropicMessage[],
    keepRecent: number = MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
  ): AnthropicMessage[] {
    // Collect indices of user messages that contain tool_result blocks
    const toolResultMsgIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some((b: any) => b.type === 'tool_result')
        if (hasToolResult) toolResultMsgIndices.push(i)
      }
    }

    if (toolResultMsgIndices.length <= keepRecent) {
      return messages
    }

    const compactUpTo = toolResultMsgIndices.length - keepRecent
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

    // Re-inject any skills the agent has invoked this session. Mirrors
    // claude-vaz's `createSkillAttachmentIfNeeded` — the original tool result
    // (with verbatim CRITICAL: blocks) was summarized into a bullet point by
    // compressContext; without re-injection, the model falls back to its
    // training prior and ignores the skill rules. Module-level state in
    // skillService survives compression and supplies the full text here.
    const { buildPostCompactionSkillsBlock } = await import('./skillService')
    const skillsBlock = buildPostCompactionSkillsBlock()

    if (fileContents.length === 0 && !devServerNote && !skillsBlock) return

    const parts = []
    if (skillsBlock) {
      parts.push(skillsBlock)
    }
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

  /**
   * True when the current run was cancelled (handleStop fired) and no fresh
   * runAgentLoop has started yet. Stream callbacks should consult this before
   * mutating UI state — late deltas keep arriving for ~1s after abort and
   * would otherwise re-flip the status from "idle" back to "thinking".
   */
  isAborted(): boolean {
    return this.abortController?.signal.aborted === true
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
      // Notify any non-singleton sub-agents that this stop applies to them
      // too (e.g. /review's reviewer sub-agent). Sub-agents have their own
      // AbortController so cancelLoop() above only aborts the main loop;
      // they listen for this event to mirror the cancellation. Only fired
      // from the main agent — sub-agent.cancelLoop() (rare) doesn't
      // re-broadcast and avoid feedback loops.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agent-stop-requested'))
      }
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

    // Request type — forwarded as X-Request-Type for the backend's
    // analytics / model-routing / billing visibility. Auto-cleared for
    // short-lived types (plan, debug) after the first call so subsequent
    // turns (tool results, follow-ups) revert to the normal request shape.
    //
    // 'e2e' and 'review' are STICKY across all turns: those flows span
    // many turns (snapshot → reason → click for /te2e; multi-file reading
    // for /review) and the backend tags every turn for the same flow
    // identity. The commands' `finally` blocks clear it via
    // setRequestType(null) when the flow finishes.
    //
    // NOTE: previously this code also derived `forceThinking` from the
    // request type to flip `enable_thinking=true` for /plan, /debug,
    // /review, /te2e even when the user had thinking OFF. That dependency
    // is gone — reasoning is always ON for supportsThinking profiles
    // (handled in buildRequestBody), so the request type no longer
    // changes the thinking decision client-side. The backend still
    // belt-and-braces forces enable_thinking=true on these types
    // (proxy.ts) which is harmless redundancy.
    if (this.requestType) {
      headers['X-Request-Type'] = this.requestType
      if (this.requestType !== 'e2e' && this.requestType !== 'review') {
        this.requestType = null
      }
    }

    // BYOK: inject the user's per-request key + provider/model selection.
    // Session snapshot wins over the global active selection — switching
    // the active provider mid-conversation does NOT affect already-running
    // sessions (the snapshot is frozen at session creation).
    //
    // The key is fetched from the OS keychain just-in-time (never persisted
    // in JS state) and only crosses the JS boundary into the fetch headers.
    type ByokInjection = {
      providerId: string
      modelId: string
      baseURL: string
      custom: boolean
      local: boolean
      capabilities?: { images: boolean; audio: boolean; video: boolean; tools: boolean }
    }
    let byokInject: ByokInjection | null = null
    if (activeSession?.byokSnapshot) {
      const snap = activeSession.byokSnapshot
      // `local` may be absent on sessions persisted before the field existed —
      // re-derive from byokStore in that case.
      let local = snap.local === true
      if (snap.local === undefined) {
        const provider = useByokStore.getState().providers.find(p => p.id === snap.providerId)
        local = provider?.local === true
      }
      byokInject = {
        providerId: snap.providerId,
        modelId: snap.modelId,
        baseURL: snap.baseURL,
        custom: snap.custom,
        local,
        capabilities: snap.capabilities,
      }
    } else {
      const active = useByokStore.getState().resolveActive()
      if (active) {
        // Send capabilities whenever the resolved model isn't a registry hit:
        // (a) custom provider — registry is empty by definition; (b) "other
        // model" mode — user typed a model id not in our hardcoded catalog.
        // For curated providers with a known model the registry is the
        // source of truth and the header is omitted.
        const inRegistry = active.provider.models.some(m => m.id === active.model.id)
        const sendCapabilities = !inRegistry
        byokInject = {
          providerId: active.provider.id,
          modelId: active.model.id,
          baseURL: active.baseURL,
          custom: active.provider.custom === true,
          local: active.provider.local === true,
          capabilities: sendCapabilities ? active.model.capabilities : undefined,
        }
      }
    }
    // Local providers (Ollama, LM Studio): the worker proxy refuses to route
    // local URLs (proxy.ts:1111) and the WebView would hit CORS dialing
    // localhost:11434 directly. The local route runs through the Rust SSE
    // bridge after requestBody is built; here we just bookmark and skip the
    // mandatory-key check below — local providers have no key by default.
    if (byokInject?.local) {
      this.lastResponseShape = 'openai'
      useByokStore.getState().markUsed(byokInject.providerId)
    } else {
      this.lastResponseShape = 'anthropic'
    }
    if (byokInject && !byokInject.local) {
      let apiKey: string | null = null
      try {
        apiKey = await invoke<string | null>('byok_get_key', { provider: byokInject.providerId })
      } catch (err) {
        console.warn('[byok] failed to read key from keychain:', err)
      }
      if (apiKey) {
        headers['X-BYOK-Provider'] = byokInject.providerId
        headers['X-BYOK-Key'] = apiKey
        headers['X-BYOK-Model'] = byokInject.modelId
        if (byokInject.baseURL) {
          headers['X-BYOK-Base-URL'] = byokInject.baseURL
        }
        // Send capabilities whenever they're set (custom provider OR user-
        // declared "other model"). Backend's getModelCapabilities trusts
        // declared values over the registry.
        if (byokInject.capabilities) {
          headers['X-BYOK-Capabilities'] = JSON.stringify(byokInject.capabilities)
        }
        useByokStore.getState().markUsed(byokInject.providerId)
      } else {
        // BYOK is configured to be on (snapshot or active selection) but the
        // key isn't actually available in the keychain or fallback file.
        // Refusing here is the right behaviour — silently falling back to TMS
        // would consume the user's plan tokens despite them having opted into
        // BYOK. Common cause: a previous dev-build session "saved" a key that
        // the macOS keychain accepted but didn't persist; the new Rust binary
        // with file fallback fixes it once the user re-saves.
        //
        // Sync hasKey to false so the Settings UI reflects the truth.
        const store = useByokStore.getState()
        const config = { ...store.perProviderConfig }
        if (config[byokInject.providerId]) {
          config[byokInject.providerId] = { ...config[byokInject.providerId], hasKey: false }
          useByokStore.setState({ perProviderConfig: config })
        }
        throw new ServiceError(
          `BYOK está activo para ${byokInject.providerId} mas a chave não está disponível. `
            + `Vai a Settings → API Keys e volta a guardar a chave (em dev builds, as chaves `
            + `por vezes não persistem; o file fallback resolve isto após restart do dev server).`,
          'BYOK_KEY_MISSING',
          false,
        )
      }
    }

    // Cache request body to reuse on 401 retry (avoids re-encoding which could differ).
    // When BYOK is active, hand the snapshot down so buildRequestBody can build
    // the thinking parameter in the BYOK provider's shape (anthropic / openai /
    // qwen / gemini) instead of the plan-profile shape that the upstream would
    // silently ignore — that's how the toggle was previously a no-op for BYOK.
    let byokThinkingHint: { supportsThinking: boolean; thinkingShape?: ByokThinkingShape } | null = null
    if (byokInject) {
      // Pull catalog inputs from the session snapshot first, then live store
      // as fallback for older persisted sessions that pre-date the
      // supportsThinking/thinkingShape fields.
      let catalogSupportsThinking = activeSession?.byokSnapshot?.supportsThinking
      let catalogShape = activeSession?.byokSnapshot?.thinkingShape
      if (catalogSupportsThinking === undefined) {
        const active = useByokStore.getState().resolveActive()
        if (active && active.provider.id === byokInject.providerId && active.model.id === byokInject.modelId) {
          catalogSupportsThinking = active.model.supportsThinking
          catalogShape = active.model.thinkingShape
        }
      }
      // Pure-function resolution — host wins over catalog; tested as a unit
      // in thinkingShapeDetection.test.ts so the rule can't drift here.
      byokThinkingHint = resolveThinkingHint({
        baseURL: byokInject.baseURL,
        catalogSupportsThinking,
        catalogShape,
      })
    }
    const requestBody = JSON.stringify(await this.buildRequestBody(messages, byokThinkingHint))

    // Local BYOK route: Rust SSE bridge → OpenAI-shape /v1/chat/completions.
    // Bypasses the worker entirely (proxy refuses local URLs) and bypasses
    // the WebView's CORS by going through reqwest in Rust. Returns a
    // standard Response wrapping the streamed body — processStreamedTurn
    // dispatches on this.lastResponseShape='openai' to use parseOpenAISSEStream.
    if (byokInject?.local) {
      const anthropicBody = JSON.parse(requestBody) as Record<string, unknown>
      const openaiBody = anthropicToOpenAIBody(anthropicBody, byokInject.modelId)
      const localUrl = `${byokInject.baseURL.replace(/\/$/, '')}/v1/chat/completions`
      const localHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      }
      // Optional auth — supports LM Studio behind a private gateway etc.
      // For Ollama-without-auth, byok_get_key returns null and we send no
      // Authorization header.
      try {
        const apiKey = await invoke<string | null>('byok_get_key', { provider: byokInject.providerId })
        if (apiKey) localHeaders['Authorization'] = `Bearer ${apiKey}`
      } catch { /* no key — fine */ }

      const localResp = await streamLocalChat(
        localUrl,
        JSON.stringify(openaiBody),
        localHeaders,
        this.abortController?.signal,
      )
      if (!localResp.ok || !localResp.body) {
        const reachableHint = localResp.status === 0
          ? `Não consegui contactar ${localUrl}. O servidor está iniciado?`
          : `O servidor local respondeu ${localResp.status}: ${(localResp.errorBody ?? '').slice(0, 300)}`
        throw new ServiceError(reachableHint, 'BYOK_LOCAL_ERROR', false)
      }
      const wrapped = new Response(localResp.body, {
        status: 200,
        headers: {
          'X-Model-Name': byokInject.modelId,
          'X-Model-Provider': byokInject.providerId,
        },
      })
      return wrapped
    }

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
            'Sem créditos disponíveis. Aguarda o reset do ciclo ou compra consumo extra.',
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
    let contextWindowForStore: number | null | undefined = undefined
    if (contextWindow) {
      const parsed = parseInt(contextWindow, 10)
      if (parsed > 0) {
        this.contextWindowSize = parsed
        contextWindowForStore = parsed
      }
    }

    const modelName = response.headers.get('X-Model-Name')
    const modelProvider = response.headers.get('X-Model-Provider')
    const thinkingHeader = response.headers.get('X-Model-Thinking-Mode')
    const thinkingMode: 'none' | 'toggleable' | 'mandatory' | null =
      thinkingHeader === 'none' || thinkingHeader === 'toggleable' || thinkingHeader === 'mandatory'
        ? thinkingHeader
        : null
    if (modelName || modelProvider || thinkingHeader || contextWindowForStore !== undefined) {
      useAgentStore
        .getState()
        .setModelInfo(modelName, modelProvider, thinkingMode, contextWindowForStore)
    }

    // Authoritative BYOK marker: the server confirms whether the request
    // was actually routed via a client-supplied key. The IDE's UI pill
    // reads this — NOT the byokStore.enabled toggle (which only says what
    // the user configured, not what the server accepted).
    useAgentStore.getState().setByokActive(response.headers.get('X-BYOK-Active') === 'true')

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

    // Local BYOK responses arrive in OpenAI-compatible SSE shape — parser
    // is set by callAPIOnce via this.lastResponseShape. The rest of the
    // turn processing is shape-agnostic (StreamEvent is the common surface).
    const parser = this.lastResponseShape === 'openai' ? parseOpenAISSEStream : parseSSEStream

    await parser(response, {
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
            if (completed?.type === 'thinking') {
              // Drain the reasoning delta buffer the moment the upstream
              // closes the thinking block — closes the race where the next
              // content_block_start fires before the 50ms buffer timer.
              callbacks.onReasoningComplete?.()
            }
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
            logger.info('agent', `[stop_reason] received="${event.stopReason}" toolCallsSoFar=${toolCalls.length}`)
            break
          }

          case 'usage': {
            // Combine across multiple usage events per turn. Anthropic-style
            // streams emit usage TWICE: message_start with prompt_tokens (and
            // completion=0) then message_delta with completion_tokens (and
            // prompt=0). The previous `??` chain only short-circuits on
            // null/undefined — `0` is a real number that always wins, so the
            // second event was OVERWRITING promptTokens=X with promptTokens=0.
            // Result: input tokens silently dropped, chat counter only ever
            // saw completion totals (~21K instead of the real ~500K+).
            //
            // Math.max handles every emit pattern correctly:
            //   - Two-event Anthropic-style (X,0) then (0,Y) → keeps X and Y
            //   - Single-event provider (X,Y) → keeps X and Y
            //   - Incremental cumulative completion (10 → 50 → 100) → keeps 100
            usage = {
              promptTokens: Math.max(usage?.promptTokens ?? 0, event.promptTokens ?? 0),
              completionTokens: Math.max(usage?.completionTokens ?? 0, event.completionTokens ?? 0),
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
              token_budget: event.tokenBudget,
              cycle_end: event.cycleEnd,
              extra_usage_balance: event.tmsRemaining,
              plan: event.plan,
              used_overage: event.usedOverage,
            })
            break
          }

          case 'error': {
            // Mid-stream upstream drop is a TRANSIENT class — the worker
            // emitted a typed event (`upstream_stream_interrupted`) because
            // the TCP between worker→provider died but the conversation
            // state is intact. Don't propagate to the UI as a hard error;
            // signal the outer runAgentLoop to retry via a sentinel
            // finishReason (`stream_interrupted`), which the loop maps to
            // the same partial-response continuation path used for
            // `finish_reason='length'`. See MAX_INTERRUPT_RETRIES.
            if (event.errorType === 'upstream_stream_interrupted') {
              finishReason = 'stream_interrupted'
              logger.warn('agent', `[stream] interrupted mid-stream — will auto-retry: ${event.message}`)
              // Visible feedback in chat so the user sees the retry happening
              // without needing dev tools. Ephemeral — auto-removes ~8s.
              try {
                useChatStore.getState().addSystemMessage(
                  'Response interrupted by the network. Retrying automatically…',
                  undefined,
                  { ephemeral: true },
                )
              } catch { /* chatStore may be torn down */ }
              break
            }
            callbacks.onError(new ServiceError(event.message, 'STREAM_ERROR', false))
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
