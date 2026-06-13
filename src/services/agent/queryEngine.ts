/**
 * QueryEngine — manages the lifecycle of a query loop for a conversation.
 *
 * Ported from claude-vaz QueryEngine.ts, adapted for TM Code.
 *
 * Owns:
 *   - SDK client instance
 *   - Mutable message state
 *   - Abort controller
 *   - Usage tracking
 *   - The submitMessage() async generator that wraps query()
 */

import type OpenAI from 'openai'
import type { ContentBlockAPI } from '../../types/chat'
import {
  query,
  type QueryMessage,
  type QueryStreamEvent,
  type QueryTerminal,
  type QueryParams,
  type ToolExecutorFn,
} from './query'

// ── Constants ──

const DEFAULT_MODEL = 'tm-active-model'

// ── Types ──

export interface QueryEngineOptions {
  /** OpenAI SDK client (pre-configured with baseURL + auth). */
  client: OpenAI
  /** Recreate the SDK client with fresh credentials after an auth failure. */
  refreshClient?: () => Promise<OpenAI | null>
  /** Placeholder model. The AI pass-through Worker injects the active model. */
  model?: string
  /** System prompt. */
  systemPrompt: string
  /** Tool definitions in OpenAI format. */
  tools: OpenAI.ChatCompletionTool[]
  /** Tool execution function. */
  executeTool: ToolExecutorFn
  /** Max output tokens override. */
  maxOutputTokensOverride?: number
  /** Thinking config. */
  thinkingConfig?: Record<string, unknown>
  /** Usage callback. */
  onUsage?: (inputTokens: number, outputTokens: number) => void
  /** Compact instructions. */
  compactInstructions?: string
  /** Max turns (default: Infinity). */
  maxTurns?: number
  /** Extra headers merged into every chat.completions.create request. */
  extraHeaders?: Record<string, string>
  /** Called as soon as streaming response headers are available. */
  onResponseHeaders?: (headers: Headers) => void
  /** Inter-turn attachment collector — see QueryParams.collectInterTurnContext. */
  collectInterTurnContext?: () => Promise<string>
  /** Live active-model limits for auto-compact — see QueryParams.getContextLimits. */
  getContextLimits?: () => { contextWindow: number | null; maxOutputTokens: number | null }
}

export interface QueryEngineState {
  /** Whether a query is currently running. */
  isRunning: boolean
  /** Total input tokens consumed this session. */
  totalInputTokens: number
  /** Total output tokens consumed this session. */
  totalOutputTokens: number
  /** Number of turns completed. */
  turnCount: number
}

// ── Engine ──

/**
 * QueryEngine wraps the query loop and manages per-conversation state.
 *
 * Usage:
 *   const engine = new QueryEngine(options)
 *   for await (const event of engine.submitMessage(userMessage, history)) {
 *     // handle events
 *   }
 */
export class QueryEngine {
  private options: QueryEngineOptions
  private abortController: AbortController | null = null
  private _state: QueryEngineState = {
    isRunning: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }

  constructor(options: QueryEngineOptions) {
    this.options = options
  }

  /** Current engine state. */
  get state(): Readonly<QueryEngineState> {
    return this._state
  }

  /** Whether a query is currently running. */
  get isRunning(): boolean {
    return this._state.isRunning
  }

  /** Cancel the running query. */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  /**
   * Submit a user message and run the query loop.
   *
   * Yields QueryStreamEvents for the UI to consume.
   * Returns the QueryTerminal when the loop completes.
   */
  async *submitMessage(
    userMessage: string | ContentBlockAPI[],
    conversationHistory: QueryMessage[],
  ): AsyncGenerator<QueryStreamEvent, QueryTerminal> {
    if (this._state.isRunning) {
      this.cancel()
    }

    this.abortController = new AbortController()
    this._state.isRunning = true

    // Build the full message list
    const messages: QueryMessage[] = [
      ...conversationHistory,
    ]

    // Add the new user message
    messages.push({
      role: 'user',
      content: userMessage as string | ContentBlockAPI[],
    })

    const params: QueryParams = {
      messages,
      systemPrompt: this.options.systemPrompt,
      client: this.options.client,
      refreshClient: this.options.refreshClient,
      model: this.options.model ?? DEFAULT_MODEL,
      tools: this.options.tools,
      executeTool: this.options.executeTool,
      signal: this.abortController.signal,
      maxTurns: this.options.maxTurns,
      maxOutputTokensOverride: this.options.maxOutputTokensOverride,
      thinkingConfig: this.options.thinkingConfig,
      onUsage: (inputTokens, outputTokens) => {
        this._state.totalInputTokens += inputTokens
        this._state.totalOutputTokens += outputTokens
        this.options.onUsage?.(inputTokens, outputTokens)
      },
      compactInstructions: this.options.compactInstructions,
      extraHeaders: this.options.extraHeaders,
      onResponseHeaders: this.options.onResponseHeaders,
      collectInterTurnContext: this.options.collectInterTurnContext,
      getContextLimits: this.options.getContextLimits,
    }

    try {
      const terminal = yield* query(params)
      this._state.turnCount = terminal.turnCount
      return terminal
    } finally {
      this._state.isRunning = false
      this.abortController = null
    }
  }

  /**
   * Create a lightweight engine for sub-agents.
   *
   * Sub-agents share the same client but have their own abort controller
   * and limited tool set.
   */
  static createLightweight(
    parent: QueryEngine,
    overrides: Partial<QueryEngineOptions>,
  ): QueryEngine {
    return new QueryEngine({
      ...parent.options,
      ...overrides,
    })
  }
}

/**
 * Helper: convert TM Code's ConversationMessage[] to QueryMessage[].
 */
export function toQueryMessages(
  history: Array<{ role: string; content: string | ContentBlockAPI[] | null; _native?: Record<string, unknown> }>,
): QueryMessage[] {
  return history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      ...(m._native ? { _native: m._native } : {}),
    }))
}
