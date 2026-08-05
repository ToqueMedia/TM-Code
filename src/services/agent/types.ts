/**
 * Shared types for the agent subsystem.
 *
 * SRP: this file defines interfaces and type aliases ONLY.
 * No runtime logic, no imports from stores or services.
 *
 * External consumers import from here instead of agentService.ts,
 * breaking the circular dependency chain.
 */

import type { ContentBlockAPI, ContentPart, ProviderState } from '../../types/chat'
import type { OpenAIToolDefinition } from './toolExecutor'
import type OpenAI from 'openai'

// ── Re-export for back-compat ──
// promptValueHelpers.ts and agentRunner.ts import OpenAIContentPart from agentService.
// That type actually lives in types/chat.ts — re-exported here for the transition.

export type OpenAIContentPart = ContentPart

// ── OpenAI message shapes ──

export type OpenAIMessageParam = OpenAI.ChatCompletionMessageParam

export type OpenAITool = OpenAI.ChatCompletionTool

// ── Internal message shape (re-exported from messageUtils) ──

export type { InternalMessage } from './messageUtils'

// ── Callbacks ──

/**
 * Bridge between the agent loop and the UI layer.
 *
 * chatStore constructs an implementation of this interface and passes it
 * to AgentService.runAgentLoop(). Every streaming event, tool result, and
 * lifecycle signal flows through these callbacks.
 */
export interface AgentCallbacks {
  /**
   * Generation do queryGuard capturada no INÍCIO do dispatch (agentRunner).
   * Um Stop durante a preparação faz forceEnd → generation avança; nada mais
   * a toca nessa janela. runAgentLoop compara ANTES de criar o controller /
   * tryStart — se mudou, houve Stop no meio e o run NÃO pode nascer
   * (anti-ressurreição, bug 2026-07-17).
   */
  dispatchGeneration?: number;
  /** Streaming text (token by token). */
  onTextDelta: (text: string) => void

  /** Streaming reasoning (token by token, collapsible in UI). */
  onReasoningDelta: (text: string) => void

  /**
   * Reasoning block formally closed by the upstream (content_block_stop for
   * a thinking block). Flush buffered reasoning deltas immediately.
   */
  onReasoningComplete?: () => void

  /** Tool call detected but still accumulating args. */
  onToolCallPending: (toolId: string, toolName: string) => void

  /** Tool call complete, being executed. */
  onToolCallStart: (toolId: string, toolName: string, args: Record<string, unknown>) => void

  /** Tool executed, result available. */
  onToolResult: (toolId: string, toolName: string, result: string, isError: boolean) => void

  /** Turn completed. */
  onTurnComplete: (turnNumber: number, providerState?: ProviderState) => void

  /** Loop finished. */
  onDone: (finalText: string) => void

  /** Error. */
  onError: (error: Error) => void

  /** Usage update. `speedApplied` (default false) sinaliza que o worker serviu
   * TM Speed neste turno (`X-TM-Speed-Applied: true`) — usado SÓ para feedback
   * (log/UI). A cobrança (3x por defeito) é aplicada server-side no worker; o
   * cliente nunca faz matemática de consumo e os tokens reportados ficam raw. */
  onUsageUpdate: (inputTokens: number, outputTokens: number, speedApplied?: boolean) => void

  /** Per-request usage (real tokens + payloadInspector estimate + breakdown).
   *  Distinct from onUsageUpdate: carries the per-request breakdown that
   *  message_stop doesn't include. Pure observability — no double-counting. */
  onRequestUsage?: (entry: import('../../types/chat').RequestUsageEntry) => void

  /** Context was compressed to fit within model limits. */
  onContextCompression?: (event: import('@/types/agent').CompactProgressEvent) => void

  /**
   * Queued-message steering (claude-vaz parity). Invoked by the query loop at
   * each turn boundary. The host drains any prompt-mode messages the developer
   * queued WHILE this run was streaming, performs the transcript bookkeeping
   * (finalize the in-flight assistant bubble → show the user's message → open a
   * fresh bubble), and returns the model-facing text to inject as the next user
   * turn. Returns null when nothing is queued. Foreground main-agent runs only;
   * omitted for sub-agents and background auto-wakes. Must never throw.
   */
  collectSteeringMessages?: () => Promise<string | ContentBlockAPI[] | null>
}

// ── Turn result ──

export interface TurnResult {
  textContent: string
  reasoningContent: string
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  finishReason: string
  usage: { promptTokens: number; completionTokens: number } | null
}

// ── Lightweight sub-agent options ──

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

// ── File access tracking ──

export interface FileAccessEntry {
  path: string
  action: 'read' | 'modified'
  timestamp: number
}

// ── Tool telemetry ──

export interface ToolFailureEntry {
  count: number
  lastError: string
}
