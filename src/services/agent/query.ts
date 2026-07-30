/**
 * Query loop — async generator agent loop ported from claude-vaz query.ts.
 *
 * Core pattern: while(true) { stream → collect tool_calls → execute tools → continue }
 *
 * Adapted for TM Code:
 *   - No Bun feature flags — uses boolean constants
 *   - Uses OpenAI SDK for streaming (all providers OpenAI-compatible)
 *   - Internal ContentBlockAPI format converted at API boundary
 *   - Integrates with TM Code's ToolExecutor and AgentCallbacks
 */

import type OpenAI from "openai";
import type { ContentBlockAPI, ProviderState, RequestUsageEntry } from "../../types/chat";
// formatError: Tauri/IPC rejections are often plain objects or serde-tagged
// enums (e.g. {"PathNotFound":"…"}), and `String(err)` collapses those to the
// literal "[object Object]" the model then sees as the tool result. formatError
// resolves a useful message from every shape.
import { formatError } from "../../utils/errors";
import { t } from "../../i18n";
import {
  applyToolResultBudget,
  snipCompactIfNeeded,
  autoCompact,
  compactNow,
  tokenCountWithEstimation,
  getCompactPrompt,
  type AutoCompactTrackingState,
  type CompactFn,
} from "./compact";
import { applyGlobalToolResultBudget } from "./toolResultGlobalBudget";
import {
  buildRepeatedCallNoteText,
  buildToolLoopNudgeText,
  checkForLoop,
  checkForToolLoop,
  computeToolBatchFingerprint,
  createLoopDetectorState,
  createToolLoopState,
  resetLoopDetector,
} from "./loopDetector";
import { REMINDER_REINJECT_INTERVAL_TURNS } from "./agentConfig";
import { getCriticalReinjectionReminder } from "./contextBuilder/sections/chatSections";
import { isAtBlockingLimit } from "../../utils/contextWindow";
import { contentAsText } from "./promptValueHelpers";
import { inspectAndLogPayload } from "./payloadInspector";
import { getReadRanges } from "./toolExecutor/readRangeTracker";
import {
  getAndResetMentionContextStats,
  recordMentionContextFull,
  recordMentionContextStub,
  resetMentionContextTurnStats,
} from "./mentionContextTracker";
import {
  inferContinuationReason,
  isLegitimateContinuationReason,
  EFFICIENCY_TARGET_TURNS,
  createEfficiencyNudgeState,
  trackEfficiencyNudge,
  buildEfficiencyNudgeText,
  createTaskTrackerReminderState,
  shouldRemindTaskTracker,
  buildTaskTrackerReminderText,
} from "./turnEfficiency";
import { buildPostEditResultText } from "./toolExecutor/changedFileSnippet";
import { DESTRUCTIVE_TOOLS } from "./toolsetSelector";
import { EDIT_FILE, canonicalToolName } from "./toolNames";

// ── Constants ──

const MAX_OUTPUT_TOKENS = 32_768;
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
// Cortes transitórios de stream (rede/5xx/stall) recuperados por run antes
// de superficializar o erro — padrão "withheld errors" do claude-vaz: o erro
// só chega ao user quando as vias de recuperação se esgotam.
const STREAM_CUT_RECOVERY_LIMIT = 2;
// Teto do escalation quando o output é truncado (finish_reason length) e o
// modelo não expõe maxOutputTokens via getContextLimits. Porte do padrão
// claude-vaz (8k→64k): truncou → duplica o cap nos pedidos seguintes, até
// este teto ou ao máximo do modelo.
const ESCALATED_MAX_OUTPUT_TOKENS = 65_536;
const PLATFORM_AUTH_REFRESH_ATTEMPTS = 1;
const CREDENTIAL_CONFIG_MAX_RETRIES = 3;
const CREDENTIAL_CONFIG_RETRY_DELAY_MS = 30_000;

// 429 do upstream (visto em produção 2026-06-12 com a Vertex: quota
// por-minuto do projeto GCP, intermitente — 200s entre 429s). Escada
// crescente para atravessar a janela de quota; o Retry-After do provider,
// quando presente nos headers do erro, tem precedência (capped a 60s).
// Ladder alargada (pedido do user 2026-06-24): 6 tentativas a
// 10s/20s/30s/45s/55s/60s = ~220s de janela total, para atravessar quotas
// por-minuto mais teimosas sem desistir. Continua só ANTES de qualquer
// output (o 429 chega sempre pré-stream). NOTA: este retry é do lado da IDE,
// não do worker — o ai-pass-through propaga o 429 com Retry-After de
// propósito (billing.ts) e quem recua é o cliente; mexer no worker duplicaria
// o retry e prenderia o pedido ~220s no edge.
const RATE_LIMIT_MAX_RETRIES = 6;
const RATE_LIMIT_RETRY_DELAYS_MS = [10_000, 20_000, 30_000, 45_000, 55_000, 60_000];

// Client-side semantic watchdog for streaming model turns. The Worker has
// byte-level watchdogs, but providers can keep a stream alive with empty/role
// chunks that produce no user-visible text, reasoning, tool call, or finish
// event. Without this guard the UI can stay in "awaiting_response" until the
// SDK transport timeout or forever on custom BYOK transports.
const STREAM_SEMANTIC_IDLE_TIMEOUT_MS = 180_000;

/** Lê o Retry-After (segundos) dos headers de um APIError do SDK, se existir. */
function retryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: Record<string, string> | Headers } | null)?.headers;
  if (!headers) return null;
  const raw = typeof (headers as Headers).get === 'function'
    ? (headers as Headers).get('retry-after')
    : (headers as Record<string, string>)['retry-after'];
  const seconds = raw ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, 60) * 1000;
}

function sanitizeToolResultForModel(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (parsed?.type === 'diff') return buildPostEditResultText(parsed)
  } catch {
    // Non-JSON tool result.
  }
  return content
}

// ── Types ──

/** Message shape used throughout the query loop. */
export interface QueryMessage {
  role: "user" | "assistant";
  content: string | ContentBlockAPI[] | null;
  /**
   * Provider-native fields for exact round-trip (assistant only).
   * When present, toOpenAIMessages spreads these into the API message
   * instead of reconstructing from content blocks.
   */
  _native?: Record<string, unknown>;
}

export type QueuedSteeringContent = string | ContentBlockAPI[];

function mentionRefId(messageIndex: number): string {
  return `mc-${messageIndex}`;
}

function isMentionContextSystemReminder(reminder: string): boolean {
  return (
    /Called the (read_file|list_directory) tool with the following input:/.test(reminder) ||
    /Result of calling the (read_file|list_directory) tool:/.test(reminder) ||
    /@mention compact_reference/.test(reminder) ||
    /Mentioned file summary \(@mention compacted; full content was NOT injected\)/.test(reminder)
  );
}

function extractMentionContextPath(text: string): string | null {
  const pathLine = text.match(/^(?:path|filePath):\s*(.+)$/m)?.[1]?.trim();
  if (pathLine) return pathLine;
  const jsonPath = text.match(/"file_path"\s*:\s*"([^"]+)"/)?.[1]
    ?? text.match(/"path"\s*:\s*"([^"]+)"/)?.[1];
  return jsonPath?.trim() || null;
}

function buildMentionContextStub(refId: string, paths: string[]): string {
  const filePath = paths.length > 0 ? paths.join(', ') : '(unknown)';
  return [
    '<system-reminder>@mention compact_reference already provided earlier.',
    `mentionContextRefId: ${refId}`,
    `filePath: ${filePath}`,
    'alreadyProvided: true',
    'Use previous outline or read only missing ranges.</system-reminder>',
  ].join('\n');
}

function compactMentionContextText(
  text: string,
  refId: string,
  shouldCompact: boolean,
): string {
  const re = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
  const mentionBlocks: string[] = [];
  const paths: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const reminder = match[0];
    if (!isMentionContextSystemReminder(reminder)) continue;
    mentionBlocks.push(reminder);
    const path = extractMentionContextPath(reminder);
    if (path && !paths.includes(path)) paths.push(path);
  }

  if (mentionBlocks.length === 0) return text;

  const fullBody = mentionBlocks.join('\n');
  if (!shouldCompact) {
    recordMentionContextFull(refId, fullBody);
    return text;
  }

  const stub = buildMentionContextStub(refId, paths);
  let inserted = false;
  const compacted = text.replace(re, (reminder) => {
    if (!isMentionContextSystemReminder(reminder)) return reminder;
    if (inserted) return '';
    inserted = true;
    return stub;
  });
  recordMentionContextStub(refId, fullBody, stub);
  return compacted.replace(/\n{3,}/g, '\n\n');
}

/**
 * Compact historical @-mention context in the exact in-memory payload that is
 * about to be sent to the provider. The persisted ChatMessage is left intact;
 * only older user turns in this request get a short reference stub.
 */
export function compactHistoricalMentionContextForPayload(
  messages: QueryMessage[],
): QueryMessage[] {
  let lastNonSystemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' || messages[i].role === 'assistant') {
      lastNonSystemIndex = i;
      break;
    }
  }

  let changed = false;
  const next = messages.map((msg, index): QueryMessage => {
    if (msg.role !== 'user') return msg;
    const shouldCompact = index < lastNonSystemIndex;
    const refId = mentionRefId(index);

    if (typeof msg.content === 'string') {
      const content = compactMentionContextText(msg.content, refId, shouldCompact);
      if (content === msg.content) return msg;
      changed = true;
      return { ...msg, content };
    }

    if (!Array.isArray(msg.content)) return msg;

    let partsChanged = false;
    const content = msg.content.map((block) => {
      if (block.type !== 'text') return block;
      const text = compactMentionContextText(block.text, refId, shouldCompact);
      if (text === block.text) return block;
      partsChanged = true;
      return { ...block, text };
    });
    if (!partsChanged) return msg;
    changed = true;
    return { ...msg, content };
  });

  return changed ? next : messages;
}

function steeringContentToUserMessage(content: QueuedSteeringContent): QueryMessage {
  return {
    role: "user",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
  };
}

/** Stream events yielded to the caller for UI rendering. */
export type QueryStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; input: string }
  | { type: "tool_use_stop"; id: string }
  | { type: "message_start" }
  | { type: "message_stop"; stopReason: string; usage?: OpenAI.CompletionUsage; providerState?: ProviderState }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
    }
  | { type: "compact_start"; beforeTokens: number }
  | { type: "compact_end"; beforeTokens: number; afterTokens: number; summary?: string }
  | {
      type: "agent_status";
      phase: "attempting" | "retrying" | "connected";
      message: string;
      provider?: string;
      model?: string;
      attempt?: number;
      maxAttempts?: number;
      httpStatus?: number;
      retryInMs?: number;
    }
  | { type: "error"; message: string }
  | { type: "interrupted" };

/** Tool execution callback — the bridge to ToolExecutor. */
export type ToolExecutorFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  signal?: AbortSignal,
) => Promise<{ content: string; isError: boolean }>;

/** Parameters for the query loop. */
export interface QueryParams {
  /** Initial messages (conversation history). */
  messages: QueryMessage[];
  /** System prompt. */
  systemPrompt: string;
  /**
   * Optional live system-prompt resolver (loop-fusion residual).
   * When set, each turn re-reads the prompt so a mid-run `/plan` steer can
   * swap the architect role without restarting the engine. Falls back to
   * the static `systemPrompt` when absent or when the getter throws.
   */
  getSystemPrompt?: () => string;
  /** OpenAI SDK client (pre-configured with baseURL + auth). */
  client: OpenAI;
  /** Recreate the SDK client with fresh credentials after an auth failure. */
  refreshClient?: () => Promise<OpenAI | null>;
  /** Model ID to use. */
  model: string;
  /** Tool definitions in OpenAI format. */
  tools: OpenAI.ChatCompletionTool[];
  /** Tool execution function. */
  executeTool: ToolExecutorFn;
  /**
   * Predicado de execução em streaming: true sse o tool pode COMEÇAR a
   * executar durante o SSE (read-only/concurrencySafe no executor). Ausente
   * = sem execução mid-stream (comportamento clássico: tudo pós-stream).
   */
  isStreamSafeTool?: (toolName: string) => boolean;
  /** Re-injeta o reminder crítico a cada N turnos. SÓ para runs cujo system
   *  prompt contém essas regras (main + tarefas paralelas) — sub-agentes
   *  partilham este loop com prompts próprios e ficam de fora. */
  reinjectCriticalReminder?: boolean;
  /**
   * Enables periodic reconciliation against the main task tracker. Sub-agents
   * and parallel tasks share the query loop but do not own that tracker.
   */
  enableTaskTrackerReminder?: boolean;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Maximum turns before stopping (default: Infinity). */
  maxTurns?: number;
  /** Maximum output tokens override. */
  maxOutputTokensOverride?: number;
  /** Thinking configuration. */
  thinkingConfig?: Record<string, unknown>;
  /** Callback for reporting token usage. */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  /** Timeout for no useful model progress while reading a streaming turn.
   *  Production uses STREAM_SEMANTIC_IDLE_TIMEOUT_MS; tests may override. */
  streamSemanticIdleTimeoutMs?: number;
  /** Callback for reporting per-request usage (real tokens + inspector
   *  estimate + breakdown). Fires once per chat.completions.create, right
   *  after the provider's usage chunk lands. Best-effort, never throws. */
  onRequestUsage?: (entry: RequestUsageEntry) => void;
  /** Custom compact instructions. */
  compactInstructions?: string;
  /** Extra headers merged into every chat.completions.create request. */
  extraHeaders?: Record<string, string>;
  /**
   * Live extra headers (optional). When set, re-read each turn so mid-run
   * `/plan` can inject `X-Request-Type: plan` without restarting the engine.
   */
  getExtraHeaders?: () => Record<string, string> | undefined;
  /** Called as soon as streaming response headers are available. */
  onResponseHeaders?: (headers: Headers) => void;
  /**
   * Inter-turn attachment collector — claude-vaz parity (query.ts runs
   * getAttachmentMessages after every tool round). Called after each batch
   * of tool results; a non-empty return is appended as a user text message
   * AFTER the tool results ("Be careful to do this after tool calls are
   * done" — interleaving regular user content between tool_result messages
   * errors on some providers). Currently carries the external-modification
   * sweep ("Note: X was modified..." reminders). Must never throw.
   */
  collectInterTurnContext?: () => Promise<string>;
  /**
   * Queued-message steering collector — claude-vaz parity. Called at every
   * turn boundary (after each tool round, and again right before the loop
   * would otherwise stop). Drains any user messages the developer queued
   * WHILE this run was streaming and returns them as model-facing text; a
   * non-empty return is appended as a user message and the loop CONTINUES,
   * so the steered message is acted on at the next turn — not parked until
   * the whole run ends ("only sent at session end"). Returning null means
   * nothing was queued. The host also does the transcript bookkeeping
   * (finalize the in-flight assistant bubble, show the user's message, open
   * a fresh bubble) as a side effect, so the run stays continuous with no
   * idle flicker. Must never throw.
   */
  collectQueuedSteering?: () => Promise<QueuedSteeringContent | null>;
  /**
   * Live active-model limits for the auto-compact decision. Called fresh each
   * loop iteration because the active model (and thus its context window) is
   * injected server-side and learned from the response's X-Model-Context-Window
   * header (with a profile/plan fallback). The provided impl never returns null;
   * if a future caller does, the decision uses a conservative fallback window
   * (utils/contextWindow via autoCompact), never a 1M assumption.
   */
  getContextLimits?: () => { contextWindow: number | null; maxOutputTokens: number | null };
  /**
   * Dynamic toolset selector — when present, the loop filters the tool
   * definitions to the active subset each turn. It starts from the
   * model-selected profile base plus model-planned groups, then expands
   * through `request_tools`. On-demand additions are transient per model step.
   * Null/undefined → send all tools
   * (legacy behaviour).
   */
  toolsetSelector?: import('./toolsetSelector').ToolsetSelector;
  /**
   * Run é read-only por POLÍTICA, independente do selector.
   *
   * O bloqueio de tools destrutivas vivia atrás de `toolsetSelector.isReadOnly()`
   * — e o selector é null em todos os runs reais (só nasceria com um
   * `enforceReadOnly` que nenhum produtor liga, ver a nota no agentService).
   * Consequência medida na auditoria de 2026-07-29: um sub-agente criado com
   * `createLightweight({ readOnly: true })` (o `verify` do toolExecutor, o
   * /review) não tinha bloqueio nenhum ao nível do loop. A política passa a
   * viajar como flag própria, que é o que ela sempre foi.
   */
  readOnlyRun?: boolean;
  /** Auxiliary-context selection — core/auxiliary breakdown for the inspector. */
  auxiliarySelection?: import('./contextBuilder/auxiliaryRegistry').AuxiliarySelection;
  /** Execution phase for bootstrap/original-task telemetry and guardrails. */
  executionPhase?: 'project_bootstrap' | 'original_task';
  /** True when the original user request asks to implement/change/fix files. */
  mutableTask?: boolean;
  /** Returns telemetry from the last delegate call, or null if delegate
   *  wasn't called this run. Populated by the ToolExecutor bridge. */
  getDelegateTelemetry?: () => {
    requestedMember: string | null;
    resolvedMember: string | null;
    blocked: boolean;
    blockedReason: string | null;
    inputSchemaVersion: string;
    recoveryAttempted: boolean;
  } | null;
}

/** Terminal return value. */
export interface QueryTerminal {
  reason: "completed" | "aborted" | "error" | "max_turns" | "blocking_limit" | "incomplete";
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** ── Guardrail telemetry (populated on the final return) ── */
  runHasEdited?: boolean;
  noEditRecoveryCount?: number;
  noEditGuardTriggered?: boolean;
  firstWriteTurn?: number;
  writeActionCount?: number;
  originalTaskWriteActionCount?: number;
  originalTaskFirstWriteTurn?: number;
  noEditGuardReason?: string;
  noEditRecoveryAction?: string;
  completionGuardDecision?: string;
  completionGuardReason?: string;
}

// ── Internal state ──

interface LoopState {
  messages: QueryMessage[];
  autoCompactTracking: AutoCompactTrackingState | undefined;
  maxOutputTokensRecoveryCount: number;
  continuationCount: number;
  turnCount: number;
  collapseRecoveryAttempts: number;
}

// ── Helpers ──

function generateId(): string {
  return `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createLinkedAbortController(parent: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    controller,
    cleanup: () => parent.removeEventListener("abort", onAbort),
  };
}

function createStreamSemanticIdleError(timeoutMs: number): Error {
  return new Error(
    `Active AI provider did not produce model output for ${Math.round(timeoutMs / 1000)}s. ` +
    `The request was aborted to avoid leaving the agent stuck awaiting a response.`,
  );
}

async function readNextStreamChunk<T>(
  iterator: AsyncIterator<T>,
  semanticDeadlineMs: number,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<IteratorResult<T>> {
  const remainingMs = semanticDeadlineMs - Date.now();
  if (remainingMs <= 0) {
    onTimeout();
    throw createStreamSemanticIdleError(timeoutMs);
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const nextPromise = iterator.next();
  // If the timeout wins, the pending nextPromise may later reject because the
  // request was aborted. Observe it so browsers do not surface an unhandled
  // rejection after we already reported the semantic timeout.
  nextPromise.catch(() => {});

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout();
      reject(createStreamSemanticIdleError(timeoutMs));
    }, remainingMs);
  });

  try {
    return await Promise.race([nextPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function cancelStreamIterator(iterator: AsyncIterator<unknown>): void {
  try {
    const returned = iterator.return?.();
    if (returned && typeof (returned as PromiseLike<IteratorResult<unknown>>).then === "function") {
      void (returned as Promise<IteratorResult<unknown>>).catch(() => {});
    }
  } catch {
    // Best-effort stream cleanup after timeout.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function errorSource(error: unknown): string | undefined {
  const source = (error as { source?: unknown } | null)?.source;
  return typeof source === "string" ? source : undefined;
}

function errorPayload(error: unknown): string {
  const apiError = (error as { error?: unknown } | null)?.error;
  if (!apiError) return "";
  if (typeof apiError === "string") return apiError;
  try {
    return JSON.stringify(apiError);
  } catch {
    return "";
  }
}

function apiErrorInfo(error: unknown): { type?: string; message?: string } {
  const apiError = (error as { error?: unknown } | null)?.error;
  if (!apiError) return {};

  let payload: unknown = apiError;
  if (typeof apiError === "string") {
    try {
      payload = JSON.parse(apiError);
    } catch {
      return { message: apiError };
    }
  }

  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : record;
  const type = typeof nested.type === "string" ? nested.type : undefined;
  const message = typeof nested.message === "string" ? nested.message : undefined;
  return { type, message };
}

function isPlatformAuthError(error: unknown): boolean {
  if (errorSource(error) === "upstream") return false;
  if (errorStatus(error) !== 401) return false;
  const text = `${errorMessage(error)} ${errorPayload(error)}`.toLowerCase();
  return /invalid token|expired|auth|unauthori[sz]ed/.test(text);
}

function isCredentialOrConfigError(error: unknown): boolean {
  const status = errorStatus(error);
  const text = `${errorMessage(error)} ${errorPayload(error)}`.toLowerCase();

  if (errorSource(error) === "upstream" && (status === 401 || status === 403)) {
    return true;
  }

  return (
    /api key not configured|auth not configured|endpoint not configured|provider not configured/.test(text) ||
    /invalid api key|incorrect api key|api key.*invalid|invalid token|unauthori[sz]ed|permission denied|forbidden|credential/.test(text)
  );
}

/**
 * Corte TRANSITÓRIO de stream — recuperável por retry (pré-output) ou por
 * retoma em turno novo (pós-output). Classes deliberadas:
 *   - 5xx do provider/gateway (o worker já re-tenta gateway HTML pré-stream;
 *     isto cobre o corte DEPOIS do stream abrir);
 *   - erros de transporte sem status (fetch/socket/rede terminada a meio);
 *   - abort interno do watchdog semântico (requestAbort dispara sem o signal
 *     do user — stream stalled). O abort do USER é guardado pelo caller
 *     (!signal.aborted) antes de chamar isto.
 * 4xx tipados NÃO entram — têm caminhos próprios acima (401 refresh, 402
 * budget, 429 escada, credential/config) e re-tentar um 400 é inútil.
 */
function isTransientStreamCutError(error: unknown, errMsg: string): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return status >= 500;
  return /network|fetch failed|failed to fetch|econn|etimedout|socket|terminated|premature|connection|abort|stream.*(closed|ended|error)/i.test(
    errMsg,
  );
}

function hasStartedModelOutput(args: {
  textParts: string[];
  thinkingParts: string[];
  toolCalls: unknown[];
  pendingToolCalls: Map<unknown, unknown>;
}): boolean {
  return (
    args.textParts.length > 0 ||
    args.thinkingParts.length > 0 ||
    args.toolCalls.length > 0 ||
    args.pendingToolCalls.size > 0
  );
}

function createStreamPayloadError(raw: unknown): Error {
  const payload = raw as {
    type?: unknown;
    message?: unknown;
    status?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  const status = typeof payload.status === "number" ? payload.status : undefined;
  const message =
    typeof payload.message === "string"
      ? payload.message
      : errorMessage(raw);
  const err = new Error(
    status ? `Provider error (${status}): ${message}` : message,
  );
  const annotated = err as Error & {
    status?: number;
    source?: string;
    type?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  annotated.status = status;
  annotated.source = "upstream";
  annotated.type = payload.type;
  annotated.provider = payload.provider;
  annotated.model = payload.model;
  return annotated;
}

function getToolCallId(toolCall: unknown): string | null {
  const id = (toolCall as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function getToolMessageCallId(message: unknown): string | null {
  const toolCallId = (message as { tool_call_id?: unknown } | null)
    ?.tool_call_id;
  return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : null;
}

function isToolMessage(message: OpenAI.ChatCompletionMessageParam): boolean {
  return (message as { role?: unknown }).role === "tool";
}

function assistantHasSendablePayload(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  if (content !== null && content !== undefined) return true;

  return Object.keys(message).some(
    (key) => key !== "role" && key !== "tool_calls",
  );
}

/**
 * OpenAI-compatible providers validate tool history strictly: every
 * role:"tool" message must answer a tool_call id from the immediately
 * preceding assistant message. Provider-native round-trip state can become
 * stale after switching providers mid-session, and compaction can also leave
 * orphaned tool results behind. Normalize the wire payload at the API boundary
 * so strict providers such as MiniMax reject neither case.
 */
function normalizeOpenAIToolSequence(
  messages: OpenAI.ChatCompletionMessageParam[],
): OpenAI.ChatCompletionMessageParam[] {
  const normalized: OpenAI.ChatCompletionMessageParam[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as unknown as Record<string, unknown>;

    if (isToolMessage(messages[index])) {
      continue;
    }

    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      normalized.push(messages[index]);
      continue;
    }

    let nextIndex = index + 1;
    const followingToolMessages: OpenAI.ChatCompletionMessageParam[] = [];
    while (nextIndex < messages.length && isToolMessage(messages[nextIndex])) {
      followingToolMessages.push(messages[nextIndex]);
      nextIndex += 1;
    }

    const followingToolIds = new Set(
      followingToolMessages
        .map(getToolMessageCallId)
        .filter((id): id is string => id !== null),
    );

    const keptToolCalls = message.tool_calls.filter((toolCall) => {
      const id = getToolCallId(toolCall);
      return id !== null && followingToolIds.has(id);
    });

    const assistantMessage: Record<string, unknown> = {
      ...message,
      tool_calls: keptToolCalls,
    };

    if (keptToolCalls.length === 0) {
      const assistantWithoutToolCalls: Record<string, unknown> = { ...message };
      delete assistantWithoutToolCalls.tool_calls;
      if (assistantHasSendablePayload(assistantWithoutToolCalls)) {
        normalized.push(
          assistantWithoutToolCalls as unknown as OpenAI.ChatCompletionMessageParam,
        );
      }
      index = nextIndex - 1;
      continue;
    }

    normalized.push(
      assistantMessage as unknown as OpenAI.ChatCompletionMessageParam,
    );

    const pendingToolIds = new Set(
      keptToolCalls
        .map(getToolCallId)
        .filter((id): id is string => id !== null),
    );

    for (const toolMessage of followingToolMessages) {
      const toolCallId = getToolMessageCallId(toolMessage);
      if (!toolCallId || !pendingToolIds.has(toolCallId)) continue;
      normalized.push(toolMessage);
      pendingToolIds.delete(toolCallId);
    }

    index = nextIndex - 1;
  }

  return normalized;
}

/** Convert internal QueryMessage[] to OpenAI ChatCompletionMessageParam[]. */
export function toOpenAIMessages(
  messages: QueryMessage[],
  systemPrompt?: string,
  model?: string,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  const needsGemini3FunctionCallSignature = /^gemini-3/i.test(model ?? "");
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  // NOTA (auditoria 2026-07-28): ponderou-se PODAR o reasoning_content dos
  // turnos já fechados, para não repagar em input o raciocínio antigo. Foi
  // REJEITADO, por duas razões:
  //
  //  1. Custo — podar mutaria o histórico a cada turno (o último turno mantém
  //     o raciocínio e perde-o no turno seguinte), o que invalida o prefixo de
  //     cache do provider exatamente na ponta, TODOS os turnos. Tokens em
  //     cache custam ~10% dos normais: forçar um miss para poupar input não
  //     compensado sai mais caro do que reenviar o que já está cacheado.
  //  2. Qualidade — GLM-5 e Grok documentam a continuidade do raciocínio
  //     entre turnos como intencional (interleaved reasoning em tool calling
  //     multi-turno), não como peso morto.
  //
  // Se algum dia se voltar a este tema, precisa de medição real (A/B de custo
  // COM os números de cache à frente), não de inferência.
  for (const msg of messages) {
    if (typeof msg.content === "string" || msg.content === null) {
      const textContent = (msg.content ?? "") as string;
      if (msg.role === "assistant") {
        // ── Native round-trip: use _native when available ──
        if (msg._native) {
          const { _native, ...rest } = msg;
          // Spread native fields first, then override role to ensure correctness.
          // The _native object carries reasoning_content, reasoning_details,
          // tool_calls, and any provider-specific fields exactly as captured.
          const nativeMsg = { ..._native, ...rest } as any;
          nativeMsg.role = "assistant";
          result.push(nativeMsg);
        } else {
          result.push({ role: "assistant", content: textContent });
        }
      } else {
        result.push({ role: "user", content: textContent });
      }
    } else if (Array.isArray(msg.content)) {
      if (msg.role === "assistant") {
        // ── Native round-trip: use _native when available ──
        if (msg._native) {
          const { _native, ...rest } = msg;
          const nativeMsg = { ..._native, ...rest } as any;
          nativeMsg.role = "assistant";
          // Content from _native takes precedence — it has the exact
          // string the provider returned. The content field in `rest`
          // is the legacy text for display compatibility.
          if (_native.content !== undefined) {
            nativeMsg.content = _native.content;
          }
          result.push(nativeMsg);
        } else {
          const textParts = (msg.content as ContentBlockAPI[])
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join("");

          // MiniMax M2.7/M3: preserve thinking for reasoning continuity
          const thinkingParts = (msg.content as ContentBlockAPI[])
            .filter((b) => b.type === "thinking")
            .map((b) => (b as { type: "thinking"; thinking: string }).thinking)
            .join("");

          const toolCallBlocks = (msg.content as ContentBlockAPI[]).filter(
            (b) => b.type === "tool_call",
          );

          const toolCalls: OpenAI.ChatCompletionMessageToolCall[] =
            toolCallBlocks.map((b, index) => {
              const tc = b as {
                type: "tool_call";
                id: string;
                name: string;
                arguments: string;
                thoughtSignature?: string;
              };
              const toolCall: any = {
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments: tc.arguments,
                },
              };
              // Gemini OpenAI compatibility expects thought signatures under
              // tool_calls[].extra_content.google.thought_signature. Per the
              // Gemini 3 docs, only the first parallel function call carries a
              // signature, but that first call in each current-turn step is
              // mandatory. For history transferred from non-Gemini providers,
              // Google documents skip_thought_signature_validator as the dummy
              // fallback. Do not add it to subsequent parallel calls.
              const thoughtSignature =
                tc.thoughtSignature ||
                (needsGemini3FunctionCallSignature && index === 0
                  ? "skip_thought_signature_validator"
                  : undefined);
              if (thoughtSignature) {
                toolCall.extra_content = {
                  google: {
                    thought_signature: thoughtSignature,
                  },
                };
              }
              return toolCall as OpenAI.ChatCompletionMessageToolCall;
            });

          const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: "assistant",
            content: textParts || null,
          };
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;

          // MiniMax: preserve thinking in content with <think> tags OR as reasoning_details
          // For models that support reasoning_content/reasoning_details, we add it as a separate field
          if (thinkingParts) {
            (assistantMsg as any).reasoning_content = thinkingParts;
          }

          result.push(assistantMsg);
        }
      } else {
        // user message: text + image_url blocks stay together as ONE multimodal
        // user message; tool_result blocks become separate `tool` messages.
        //
        // ROOT CAUSE FIX: the old loop only handled `text` and `tool_result` and
        // SILENTLY DROPPED `image_url` blocks here — so a pasted image, even
        // though buildContentParts had correctly produced an image_url part,
        // never reached ANY model (provider-agnostic: Gemini, Qwen, Step all
        // replied "I don't see an image"). The image was lost at THIS OpenAI
        // conversion step, not at build time.
        const userParts: OpenAI.ChatCompletionContentPart[] = [];
        const flushUser = () => {
          if (userParts.length === 0) return;
          // Collapse a text-only message to a plain string (some providers
          // reject single-text content arrays); keep the array when it carries
          // an image so the model actually receives the pixels.
          const hasImage = userParts.some((p) => p.type === "image_url");
          result.push({
            role: "user",
            // Push a COPY — `userParts.length = 0` below empties this array, and
            // a by-reference push would zero out the message we just stored.
            content: hasImage
              ? userParts.slice()
              : userParts
                  .map((p) => (p as { type: "text"; text: string }).text)
                  .join("\n"),
          });
          userParts.length = 0;
        };
        for (const block of msg.content as ContentBlockAPI[]) {
          if (block.type === "text") {
            userParts.push({ type: "text", text: block.text });
          } else if (block.type === "image_url") {
            userParts.push({
              type: "image_url",
              image_url: (
                block as {
                  type: "image_url";
                  image_url: { url: string; detail?: "low" | "high" | "auto" };
                }
              ).image_url,
            });
          } else if (block.type === "tool_result") {
            // Flush any accumulated user text/images before the tool message.
            flushUser();
            result.push({
              role: "tool",
              tool_call_id: (
                block as { type: "tool_result"; toolCallId: string }
              ).toolCallId,
              content: (block as { type: "tool_result"; content: string })
                .content,
            });
          }
        }
        flushUser();
      }
    }
  }

  return normalizeOpenAIToolSequence(result);
}

/** Filter out incomplete tool_call blocks (no matching tool_result). */
function filterIncompleteToolCalls(messages: QueryMessage[]): QueryMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_call") toolCallIds.add(block.id);
      if (block.type === "tool_result") toolResultIds.add(block.toolCallId);
    }
  }

  const orphanedIds = new Set(
    [...toolCallIds].filter((id) => !toolResultIds.has(id)),
  );

  if (orphanedIds.size === 0) return messages;

  return messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
    const filtered = (msg.content as ContentBlockAPI[]).filter(
      (block) => !(block.type === "tool_call" && orphanedIds.has(block.id)),
    );
    if (filtered.length === (msg.content as ContentBlockAPI[]).length)
      return msg;
    return { ...msg, content: filtered.length > 0 ? filtered : "" };
  });
}

// ── Main query loop ──

/**
 * The core query loop — an async generator that streams model responses,
 * executes tools, applies context management, and continues until the
 * model stops requesting tools or a terminal condition is met.
 *
 * Yields QueryStreamEvents for the UI layer to consume.
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryStreamEvent, QueryTerminal> {
  const {
    systemPrompt: initialSystemPrompt,
    getSystemPrompt,
    model,
    tools,
    executeTool,
    signal,
    maxTurns = Infinity,
    maxOutputTokensOverride,
    thinkingConfig,
    onUsage,
    onRequestUsage,
    compactInstructions,
    extraHeaders: initialExtraHeaders,
    getExtraHeaders,
    onResponseHeaders,
    getContextLimits,
    toolsetSelector,
    readOnlyRun,
    auxiliarySelection,
    isStreamSafeTool,
  } = params;
  const resolveExtraHeaders = (): Record<string, string> | undefined => {
    if (!getExtraHeaders) return initialExtraHeaders
    try {
      return getExtraHeaders() ?? initialExtraHeaders
    } catch {
      return initialExtraHeaders
    }
  }
  let extraHeaders = resolveExtraHeaders()
  /** Resolve per-turn so mid-run plan-mode can rewire the architect role. */
  const resolveSystemPrompt = (): string => {
    if (!getSystemPrompt) return initialSystemPrompt
    try {
      const live = getSystemPrompt()
      return typeof live === 'string' && live.length > 0 ? live : initialSystemPrompt
    } catch {
      return initialSystemPrompt
    }
  }
  let systemPrompt = resolveSystemPrompt()
  let client = params.client;
  const refreshClient = params.refreshClient;

  // Real provider occupancy from the previous turn (prompt_tokens +
  // completion_tokens), fed into the auto-compact decision so it tracks the
  // active model's real window instead of a hardcoded 1M char-estimate.
  // Undefined until the first response is recorded.
  let lastTurnRealOccupancy: number | undefined;

  // Turn-efficiency tracking — the continuation reason inferred at the END of
  // the previous turn (why the loop kept going past the 3-4-request target).
  // Surfaced in the payload-inspector log of the NEXT turn so the forensic
  // trail travels with the request diagnostics. Undefined until turn ≥ target.
  let lastContinuationReason: string | undefined;

  // Nudge de eficiência — quando rondas consecutivas continuam SEM razão
  // técnica, o modelo recebe um system-reminder inter-turn a pedir para
  // consolidar (antes o sinal morria em console.debug e o pacing vivia numa
  // secção numérica do prompt que o modelo ignorava — auditoria 2026-07-22).
  // O decisor/throttle é puro (turnEfficiency.ts); aqui só guardamos o texto
  // pendente até ao ponto de injeção dos inter-turn attachments.
  const efficiencyNudgeState = createEfficiencyNudgeState();
  let pendingEfficiencyNudge: string | null = null;

  // Wall-clock of the previous turn's assistant message — feeds the gap-aware
  // (lastAssistantMessageAt was used by microcompact's gap-aware keepRecent.
  //  Removed when microcompact was replaced by applyGlobalToolResultBudget —
  //  the global budget uses a fixed keepRecent=4. Restore here if gap-aware
  //  eviction is re-added to the budget.)

  let state: LoopState = {
    messages: [...params.messages],
    autoCompactTracking: undefined,
    maxOutputTokensRecoveryCount: 0,
    continuationCount: 0,
    turnCount: 0,
    collapseRecoveryAttempts: 0,
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const executionPhase = params.executionPhase ?? 'original_task';
  const mutableTask = params.mutableTask === true && executionPhase === 'original_task';
  const loopDetectorState = createLoopDetectorState();
  // Metade do detector que olha para as TOOL CALLS (a de texto só corre em
  // turns sem tools e era resetada por qualquer tool call).
  const toolLoopState = createToolLoopState();
  let thinkingOnlyRecoveryCount = 0;

  // Guardrail: a bugfix_local run (readOnly=false) that ends without a single
  // file mutation likely stopped prematurely — the model diagnosed the bug but
  // deferred the fix ("No próximo turno, aplicarei…") without requesting
  // edit_file (which is intentionally excluded from the bugfix_local base).
  // Track whether any mutating tool ran successfully this run, and allow one
  // recovery attempt to nudge the model back on track.
  let runHasEdited = false;
  let noEditRecoveryCount = 0;
  /** Whether any successful update_tasks ran this run — see the
   *  task-reconciliation guardrail at the stop path. */
  let runTouchedTaskTracker = false;
  let taskGuardCount = 0;
  const taskTrackerReminderState = createTaskTrackerReminderState();
  let lastTaskTrackerUpdateTurn = 0;
  let writesSinceTaskTrackerUpdate = 0;
  /** Turn number of the first successful file mutation (1-indexed). */
  let firstWriteTurn: number | undefined;
  /** Total count of successful file-mutating tool calls this run. */
  let writeActionCount = 0;
  /** Set when the no-edit guardrail fires; reported on the NEXT request's usage entry. */
  let guardTriggeredLastTurn = false;
  let noEditGuardReason: string | undefined;
  let noEditRecoveryAction: string | undefined;
  /**
   * Cap de output escalado após truncagem (finish_reason "length" — OpenAI-
   * compat — ou "max_tokens", Anthropic). null = usa o cap normal. Sobe uma
   * vez por truncagem (2×, com teto no maxOutputTokens do modelo ou
   * ESCALATED_MAX_OUTPUT_TOKENS) e mantém-se até ao fim da run — se um output
   * já não coube uma vez, os seguintes têm a mesma cara.
   */
  let escalatedMaxTokens: number | null = null;
  /** Cortes transitórios de stream recuperados nesta run (limite: STREAM_CUT_RECOVERY_LIMIT). */
  let streamCutRecoveryCount = 0;

  // eslint-disable-next-line no-constant-condition
  queryLoop: while (true) {
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      turnCount,
    } = state;

    // ── Check termination ──

    if (signal.aborted) {
      yield { type: "interrupted" };
      return {
        reason: "aborted",
        turnCount,
        totalInputTokens,
        totalOutputTokens,
      };
    }

    if (turnCount >= maxTurns) {
      return {
        reason: "max_turns",
        turnCount,
        totalInputTokens,
        totalOutputTokens,
      };
    }

    state.turnCount++;

    // ── Context management pipeline ──
    // Order: toolResultBudget → microcompact → collapse → autoCompact
    //
    // Routine snip (a cheap tail-cut that drops old turns with NO summary) was
    // REMOVED from the per-request path. Its "only snip under pressure" guard was
    // a tautology — `currentTokens <= currentTokens * 0.5` is never true — so it
    // fired on EVERY request once a conversation passed ~20 messages, trimming
    // the outgoing prompt to the last ~20 messages and starving the summarizer
    // (autoCompact rarely saw enough tokens to fire). The model went blind beyond
    // a sliding 20-message window, with no summary of what was dropped — the
    // concrete cause of "the model loses the thread".
    //
    // claude-vaz's snip is a model-INVOKED tool for opportunistic pruning, not an
    // automatic per-turn trim; its routine compaction is summarization. We now
    // match that: routine context management is microcompact (clears OLD tool-
    // result CONTENT but keeps every turn) + autoCompact (summarizes near the
    // ceiling and PERSISTS the summary). Snip remains ONLY as a forced last
    // resort in the blocking-limit guard and the prompt_too_long recovery below,
    // where the alternative is a guaranteed overflow.

    let messagesForQuery = [...messages];

    // 0. Global tool-result budget — cap TOTAL tool-result tokens across all
    //    messages at ~40K. UNDER budget nothing is touched (the model keeps a
    //    full working set — hardcoding it to the last 4 results starved
    //    multi-file tasks and caused the re-read→stub→force:true dance, raiz
    //    corrigida 2026-07-13); OVER budget the oldest results are compacted
    //    to a structured summary (tool name, path/range, hash, preview,
    //    re-read hint) until back under, keepRecent=4 protected. Compacted ≠
    //    deleted — o modelo relê via read_file / read_large_result, e o read
    //    NUNCA lhe recusa a releitura (a supressão saiu em 2026-07-29).
    //    Token-reduction phase 2026-06-26, budget real 07-13.
    const budgetResult = applyGlobalToolResultBudget(messagesForQuery);
    if (budgetResult.compactedCount > 0) {
      messagesForQuery = budgetResult.messages;
      console.debug(
        `[query] global tool-result budget: compacted ${budgetResult.compactedCount} ` +
        `results (~${budgetResult.tokensBefore}→${budgetResult.tokensAfter} tokens)`,
      );
    }

    // 1. Per-message tool result budget — cap oversized single-message bodies.
    messagesForQuery = applyToolResultBudget(messagesForQuery);

    // 2. (routine snip removed — emergency-only below). No tokens pre-freed, so
    //    autoCompact reasons about the full occupancy.
    const snipTokensFreed = 0;

    // 3. (microcompact replaced by step 0 — applyGlobalToolResultBudget.
    //    The old microcompact cleared to "[Old tool result content cleared]"
    //    with no tool name/path/size/hash, so the model couldn't decide
    //    whether a re-read was worth it. The global budget does the same
    //    clearing but with a structured summary that preserves
    //    identifiability + re-read instructions. keepRecent lowered 8→4.)

    // 4. Auto-compact
    let tracking = autoCompactTracking;
    const compactFn: CompactFn = async (
      msgs: { role: string; content: any }[],
      _sysPrompt: string,
    ) => {
      // Side-call: use the same client to summarize
      const prompt = getCompactPrompt(compactInstructions);
      // Narrate the FULL content — tool calls AND tool results — into the
      // summarizer input, not just the conversational text. Filtering to
      // text-only blocks (the old behaviour) stripped every file read, edit,
      // command output and error before summarization, then the prompt asked
      // the model to capture "file edits, errors, code patterns" it could no
      // longer see — structurally forcing it to omit or invent (context
      // pollution audit, 2026-06-12). The messages reaching here have already
      // passed applyToolResultBudget + snip + microcompact above, so tool
      // results are size-bounded. contentAsText renders tool_call as
      // `[tool: name(args)]` and inlines the (bounded) tool_result text.
      const compactMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: prompt },
        ...msgs.map(
          (m: any): OpenAI.ChatCompletionMessageParam => ({
            role: m.role as "user" | "assistant",
            content:
              typeof m.content === "string"
                ? m.content
                : contentAsText(m.content as ContentBlockAPI[]),
          }),
        ),
      ];
      try {
        const response = await client.chat.completions.create(
          {
            model,
            max_tokens: 16384,
            messages: compactMessages,
          },
          { signal, headers: extraHeaders },
        );
        return response.choices[0]?.message?.content || null;
      } catch {
        return null;
      }
    };

    // Re-resolve before compact + request so a plan-mode steer that just
    // flipped the system prompt / request headers is visible on this turn.
    systemPrompt = resolveSystemPrompt();
    extraHeaders = resolveExtraHeaders();

    const ctxLimits = getContextLimits?.();
    const autoResult = await autoCompact(
      messagesForQuery,
      systemPrompt,
      compactFn,
      tracking,
      snipTokensFreed,
      {
        contextWindow: ctxLimits?.contextWindow ?? null,
        maxOutputTokens: ctxLimits?.maxOutputTokens ?? null,
        realOccupancyTokens: lastTurnRealOccupancy ?? null,
      },
    );

    if (autoResult.wasCompacted && autoResult.postCompactMessages) {
      yield {
        type: "compact_start",
        beforeTokens: autoResult.preCompactTokenCount ?? 0,
      };
      messagesForQuery = autoResult.postCompactMessages;
      tracking = {
        compacted: true,
        turnId: generateId(),
        turnCounter: 0,
        consecutiveFailures: 0,
        lastFailureAt: undefined,
      };
      // Carry the summary text out so the handler can PERSIST it on the boundary
      // marker (chatStore.addCompactBoundaryMessage). O sumário é SEMPRE o
      // elemento 0 do que compactNow devolve; os turnos recentes preservados
      // vêm a seguir. Sem isto o sumário ficava local ao loop e era descartado —
      // o modelo perdia todo o contexto pré-fronteira no turno seguinte.
      const compactSummary =
        typeof autoResult.postCompactMessages[0]?.content === "string"
          ? (autoResult.postCompactMessages[0].content as string)
          : undefined;
      yield {
        type: "compact_end",
        beforeTokens: autoResult.preCompactTokenCount ?? 0,
        afterTokens: autoResult.postCompactTokenCount ?? 0,
        summary: compactSummary,
      };
    } else if (autoResult.consecutiveFailures !== undefined) {
      tracking = {
        ...(tracking ?? { compacted: false, turnId: "", turnCounter: 0 }),
        consecutiveFailures: autoResult.consecutiveFailures,
        // Sem propagar o timestamp, o disjuntor não tem como arrefecer e
        // volta a ser o fusível que era.
        lastFailureAt: autoResult.lastFailureAt,
      };
    }

    // ── Pre-API blocking-limit guard ──
    // Belt-and-suspenders: even after the whole pipeline, occupancy can still sit
    // at the blocking limit (autoCompact's circuit breaker open, or its summarizer
    // kept failing). Rather than ship a prompt we KNOW is over the effective
    // ceiling and eat a guaranteed prompt_too_long, force a mechanical snip to
    // stay under it. claude-vaz blocks the send here too; we snip instead of
    // erroring so an autonomous run keeps going. Reactive recovery below still
    // catches anything this can't (few-but-huge messages snip can't reduce).
    {
      const guardWindow = ctxLimits?.contextWindow ?? null;
      if (guardWindow) {
        const occupancy = Math.max(
          tokenCountWithEstimation(messagesForQuery),
          lastTurnRealOccupancy ?? 0,
        );
        if (isAtBlockingLimit(occupancy, guardWindow, ctxLimits?.maxOutputTokens ?? null)) {
          const guardSnip = snipCompactIfNeeded(messagesForQuery, {
            force: true,
            keepRecentMessages: 8,
          });
          if (guardSnip.messagesRemoved > 0) {
            messagesForQuery = guardSnip.messages;
            console.warn(
              `[query] blocking-limit guard: forced snip freed ~${guardSnip.tokensFreed} ` +
              `tokens (${guardSnip.messagesRemoved} msgs) before send`,
            );
          }
        }
      }
    }

    // Filter incomplete tool calls (orphaned tool_use without tool_result)
    messagesForQuery = filterIncompleteToolCalls(messagesForQuery);

    // Compact historical @-mention context only in the exact payload about to
    // be sent. Keep messagesForQuery itself unmodified so turn 3+ can still
    // compute the same full-vs-stub saving instead of seeing only turn 2's
    // stub in loop state.
    resetMentionContextTurnStats();
    const providerMessagesForQuery = compactHistoricalMentionContextForPayload(messagesForQuery);

    // (Removido 2026-07-29) updateToolResultVisibility: registava, a cada turno,
    // quais tool_results seguiam INTACTOS no payload vs compactados. O ÚNICO
    // leitor desse registo era a dedup de leitura — que saiu com a supressão de
    // releituras — portanto isto passou a percorrer todas as mensagens de todos
    // os pedidos para produzir um estado que ninguém consultava. Registar por
    // registar não é observabilidade; é trabalho por turno a fingir que serve.
    // Ensure message alternation: Anthropic requires user/assistant/user/...
    // NOTE: This synthetic assistant message was removed — it caused the model
    // to see 'Understood. What would you like me to do next?' as its own prior
    // response and loop on it instead of actually executing tools. OpenAI-
    // compatible APIs (used by TM Code) do NOT require strict alternation;
    // the toOpenAIMessages() converter already handles tool_results correctly.
    // If a future provider requires alternation, fix it at the API boundary
    // (toOpenAIMessages) instead of injecting fake messages into state.

    // ── Build API request (convert internal format → OpenAI) ──

    const maxTokens = escalatedMaxTokens ?? maxOutputTokensOverride ?? MAX_OUTPUT_TOKENS;
    const apiMessages = toOpenAIMessages(providerMessagesForQuery, systemPrompt, model);

    // ── Dynamic toolset selection ──
    // Filter the tool definitions to the active subset for this turn. The
    // selector starts with the model-selected profile base plus any
    // model-planned groups, then expands through request_tools. Reduces
    // tool-schema overhead (~10K tokens for 36 tools) to the few the current
    // task needs. When the selector is absent, send all tools (legacy).
    const toolSelection = toolsetSelector
      ? toolsetSelector.selectForTurn(tools)
      : {
          tools,
          activeCount: tools.length,
          totalCount: tools.length,
          allActive: true,
        };
    const activeTools = toolSelection.tools;

    // ── Payload inspection (token-cost diagnostics) ──
    // Best-effort: sizes + hashes + top-10 blocks logged to console.debug
    // before every provider request. Never throws, never blocks the send.
    const payloadReport = inspectAndLogPayload(
      apiMessages, systemPrompt, activeTools, model, state.turnCount,
      toolSelection.totalCount, lastContinuationReason, auxiliarySelection,
      // Sinais de saúde da seleção dinâmica de tools: frequência de
      // request_tools (perfil mal calibrado → round-trips extra) e base para
      // o churn do toolset (invalidação de prompt cache) — ver toolsetChurn
      // no PayloadReport. typeof-guard: testes injetam mocks parciais do
      // seletor sem este método.
      typeof toolsetSelector?.getInstrumentationStats === 'function'
        ? toolsetSelector.getInstrumentationStats()
        : undefined,
    );

    // ── Stream from model ──

    yield { type: "message_start" };

    const assistantTextParts: string[] = [];
    const assistantThinkingParts: string[] = [];
    const collectedToolCalls: Array<{
      id: string;
      name: string;
      argsJson: string;
      thoughtSignature?: string;
    }> = [];
    const pendingToolCalls: Map<
      number,
      {
        id: string;
        name: string;
        argsParts: string[];
        thoughtSignature?: string;
      }
    > = new Map();
    let stopReason = "";
    // O stream fechou sem qualquer `finish_reason`? Ver a nota no fim do laço.
    let streamEndedWithoutSignal = false;
    let turnUsage: OpenAI.CompletionUsage | undefined;

    // ── Streaming tool execution (porte scoped do claude-vaz) ──
    // Um delta para um index NOVO de tool_call significa (semântica OpenAI-
    // compat: args por index são contíguos) que todos os indexes anteriores
    // têm args completos — tools READ-ONLY (isStreamSafeTool, i.e.
    // concurrencySafe no executor) começam a executar JÁ, sobrepondo a
    // execução ao resto da geração. Ganho concentra-se nos turnos
    // multi-read ("Leu 3 ficheiros"). Invariantes deliberados:
    //   - Regra de prefixo: o primeiro tool não-safe (edit/write/shell) ou
    //     com args não-parseáveis QUEBRA a cadeia — nada depois dele
    //     pre-despacha, para que um read nunca observe estado anterior a um
    //     edit que o precede na ordem do turno.
    //   - Os yields de tool_result ficam onde estavam (pós-stream, em
    //     ordem): só a EXECUÇÃO antecipa; o contrato de eventos com a UI e
    //     o transcript não muda.
    //   - Args que cheguem tarde para um index já despachado (interleaving
    //     de provider) invalidam o pre-dispatch: o loop serial compara
    //     argsJson e re-executa com os args completos — reads são
    //     idempotentes, o custo é só o overlap perdido.
    //   - Promises levam .catch imediato (mesma forma de erro do loop
    //     serial) para nunca gerarem unhandled rejection num stream
    //     abortado a meio.
    // Keyed por tool-call id. `streamDispatchBroken` implementa o prefixo.
    const preDispatched = new Map<
      string,
      { argsJson: string; promise: Promise<{ content: string; isError: boolean }> }
    >();
    let streamDispatchBroken = false;
    const tryStreamDispatch = (pending: {
      id: string;
      name: string;
      argsParts: string[];
    }): void => {
      if (streamDispatchBroken || !isStreamSafeTool) return;
      if (!pending.id || !pending.name) {
        streamDispatchBroken = true;
        return;
      }
      if (preDispatched.has(pending.id)) return;
      if (signal.aborted) return;
      const argsJson = pending.argsParts.join("");
      let parsed: Record<string, unknown>;
      try {
        parsed = argsJson ? JSON.parse(argsJson) : {};
      } catch {
        // Args incompletos apesar do index novo — não arrisca; quebra o
        // prefixo e deixa o loop serial (com reparo de _parseError) tratar.
        streamDispatchBroken = true;
        return;
      }
      if (!isStreamSafeTool(pending.name)) {
        streamDispatchBroken = true;
        return;
      }
      const promise = executeTool(pending.name, parsed, pending.id, signal).catch(
        (err) => ({
          content: `Tool execution error: ${formatError(err)}`,
          isError: true,
        }),
      );
      preDispatched.set(pending.id, { argsJson, promise });
      console.debug(
        `[query] stream-dispatch: ${pending.name} (${pending.id}) started during stream`,
      );
    };

    // MiniMax: buffer for content that may contain <think> tags
    // Gemini: buffer for content that may contain <thought> tags
    // Tags can span multiple chunks, so we buffer and only yield text
    // when we know the content is safe (no partial tags)
    const contentBuffer: string[] = [];
    let thinkMode = false; // true when inside <think>...</think> or <thought>...</thought>

    // ── Native delta accumulator for provider round-trip ──
    // Captures raw fields from every streaming chunk delta so the
    // native assistant message can be reconstructed exactly as the
    // provider returned it — preserving reasoning_details structure,
    // signatures, and any unknown fields that the UI layer discards.
    const KNOWN_DELTA_KEYS = new Set([
      'content', 'reasoning_content', 'reasoning_details',
      'tool_calls', 'role', 'function_call',
    ]);
    const nativeAccumulator = {
      reasoningContent: '' as string,
      reasoningDetails: [] as unknown[],
      toolCallExtras: new Map<number, Record<string, unknown>>(),
      extraDeltaFields: {} as Record<string, unknown>,
    };

    let authRefreshAttempts = 0;
    let credentialConfigRetries = 0;
    let rateLimitRetries = 0;
    const semanticIdleTimeoutMs = Math.max(
      1,
      params.streamSemanticIdleTimeoutMs ?? STREAM_SEMANTIC_IDLE_TIMEOUT_MS,
    );

    // Retry the same model turn only before any assistant output/tool call has
    // been emitted. Retrying after visible output could duplicate text or tools.
    // eslint-disable-next-line no-constant-condition
    while (true) {
    const requestAbort = createLinkedAbortController(signal);
    let semanticDeadlineMs = Date.now() + semanticIdleTimeoutMs;
    const markModelProgress = () => {
      semanticDeadlineMs = Date.now() + semanticIdleTimeoutMs;
    };
    try {
      const streamParams: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true },
      };

      if (activeTools.length > 0) {
        streamParams.tools = activeTools;
      }

      if (thinkingConfig) {
        Object.assign(streamParams, thinkingConfig);
      }

      const responsePromise = client.chat.completions.create(
        {
          ...streamParams,
          stream: true,
        } as any,
        { signal: requestAbort.controller.signal, headers: extraHeaders },
      );
      const { data: stream, response } =
        typeof (responsePromise as any).withResponse === "function"
          ? await (responsePromise as any).withResponse()
          : { data: await responsePromise, response: null };
      if (response?.headers) {
        onResponseHeaders?.(response.headers);
      }

      // Process OpenAI stream chunks
      const streamIterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      while (true) {
        const next = await readNextStreamChunk(
          streamIterator,
          semanticDeadlineMs,
          semanticIdleTimeoutMs,
          () => {
            requestAbort.controller.abort();
            cancelStreamIterator(streamIterator);
          },
        );
        if (next.done) break;
        const chunk = next.value as any;
        if (signal.aborted) {
          yield { type: "interrupted" };
          return {
            reason: "aborted",
            turnCount: state.turnCount,
            totalInputTokens,
            totalOutputTokens,
          };
        }

        if (chunk?.error) {
          throw createStreamPayloadError(chunk.error);
        }

        // Defensive: skip chunks that are null/undefined or lack choices array
        if (
          !chunk ||
          typeof chunk !== "object" ||
          !Array.isArray(chunk.choices)
        ) {
          continue;
        }

        // Usage-only chunks from OpenAI-compatible streaming providers
        // commonly arrive as `{ choices: [], usage: ... }` when
        // `stream_options.include_usage` is enabled. Capture usage before
        // reading `choices[0]`, otherwise the final accounting chunk is
        // skipped and BYOK sessions look unmetered.
        if (chunk.usage) {
          turnUsage = chunk.usage;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Debug: log first chunks to see reasoning_content vs content structure
        if (!delta) continue;

        // Gemini (Vertex/AI Studio OpenAI-compat): com include_thoughts, os
        // pensamentos chegam como delta.content NORMAL marcado com
        // `extra_content.google.thought: true` — NÃO existe reasoning_content
        // (verificado empiricamente 2026-06-12 contra a Vertex). Sem este
        // desvio, o thinking do Gemini aparecia misturado na resposta
        // visível. NOTA: `thought_signature` em extra_content aparece também
        // em deltas de resposta normal — só `thought === true` marca
        // reasoning.
        if (
          delta?.content &&
          (delta as any)?.extra_content?.google?.thought === true
        ) {
          const reasoning = String(delta.content);
          assistantThinkingParts.push(reasoning);
          nativeAccumulator.reasoningContent += reasoning;
          markModelProgress();
          yield { type: "thinking_delta", thinking: reasoning };
          continue;
        }

        // Reasoning/thinking content (OpenAI-compatible format)
        // MiniMax M3: reasoning_details field when reasoning_split=True
        // Other models: reasoning_content field
        if (delta?.reasoning_content) {
          const reasoning = delta.reasoning_content;
          assistantThinkingParts.push(reasoning);
          nativeAccumulator.reasoningContent += reasoning;
          markModelProgress();
          yield { type: "thinking_delta", thinking: reasoning };
        }

        // MiniMax M3: reasoning_details array (when reasoning_split=True)
        if (
          delta?.reasoning_details &&
          Array.isArray(delta.reasoning_details)
        ) {
          for (const detail of delta.reasoning_details) {
            // Preserve the raw detail object as-is for native round-trip —
            // it may contain type, signature, or other fields beyond .text
            nativeAccumulator.reasoningDetails.push(detail);
            if (detail?.text) {
              assistantThinkingParts.push(detail.text);
              markModelProgress();
              yield { type: "thinking_delta", thinking: detail.text };
            }
          }
        }

        // Capture unknown/extra delta fields for native round-trip.
        // These are provider-specific fields not in the standard OpenAI
        // schema (e.g. MiniMax reasoning_extra, Gemini safety_ratings).
        if (delta) {
          for (const key of Object.keys(delta)) {
            if (KNOWN_DELTA_KEYS.has(key)) continue;
            const val = (delta as any)[key];
            if (val !== undefined && val !== null) {
              nativeAccumulator.extraDeltaFields[key] = val;
            }
          }
        }

        // Text content — MiniMax may embed <think> tags in content
        // We use a state machine to handle tags spanning multiple chunks
        if (delta?.content) {
          markModelProgress();
          const raw = delta.content;
          contentBuffer.push(raw);

          // Process buffered content character-by-character to handle partial tags
          let buffered = contentBuffer.join("");
          contentBuffer.length = 0;

          while (buffered.length > 0) {
            if (!thinkMode) {
              // Look for opening <think> or <thought> tag
              const thinkOpenIdx = buffered.indexOf("<think>");
              const thoughtOpenIdx = buffered.indexOf("<thought>");

              // Find the earliest opening tag
              let openIdx = -1;
              let openTagLen = 0;

              if (
                thinkOpenIdx !== -1 &&
                (thoughtOpenIdx === -1 || thinkOpenIdx < thoughtOpenIdx)
              ) {
                openIdx = thinkOpenIdx;
                openTagLen = 7;
              } else if (thoughtOpenIdx !== -1) {
                openIdx = thoughtOpenIdx;
                openTagLen = 9;
              }

              if (openIdx === -1) {
                // No opening tag found — all text is safe
                assistantTextParts.push(buffered);
                yield { type: "text_delta", text: buffered };
                buffered = "";
              } else if (openIdx > 0) {
                // Text before the tag — safe to yield
                const before = buffered.slice(0, openIdx);
                assistantTextParts.push(before);
                yield { type: "text_delta", text: before };
                buffered = buffered.slice(openIdx);
              } else {
                // Starts with opening tag — enter think mode
                thinkMode = true;
                buffered = buffered.slice(openTagLen); // skip opening tag
              }
            } else {
              // Inside thinking — look for closing </think> or </thought>
              const thinkCloseIdx = buffered.indexOf("</think>");
              const thoughtCloseIdx = buffered.indexOf("</thought>");

              // Find the earliest closing tag
              let closeIdx = -1;
              let closeTagLen = 0;

              if (
                thinkCloseIdx !== -1 &&
                (thoughtCloseIdx === -1 || thinkCloseIdx < thoughtCloseIdx)
              ) {
                closeIdx = thinkCloseIdx;
                closeTagLen = 8; // '</think>'.length
              } else if (thoughtCloseIdx !== -1) {
                closeIdx = thoughtCloseIdx;
                closeTagLen = 10; // '</thought>'.length
              }

              if (closeIdx === -1) {
                // Still inside thinking — accumulate
                assistantThinkingParts.push(buffered);
                yield { type: "thinking_delta", thinking: buffered };
                buffered = "";
              } else {
                // Found closing tag — extract thinking content
                const thinking = buffered.slice(0, closeIdx);
                if (thinking) {
                  assistantThinkingParts.push(thinking);
                  yield { type: "thinking_delta", thinking };
                }
                thinkMode = false;
                buffered = buffered.slice(closeIdx + closeTagLen);
              }
            }
          }
        }

        // Tool calls (streaming)
        if (delta?.tool_calls) {
          markModelProgress();
          for (const tc of delta.tool_calls) {
            let pending = pendingToolCalls.get(tc.index);
            if (!pending) {
              // Index novo ⇒ os anteriores têm args completos (contiguidade
              // OpenAI-compat) — candidatos a execução durante o stream.
              // Ordenado por index: a regra de prefixo do tryStreamDispatch
              // depende de visitar os tools na ordem do turno.
              const completed = [...pendingToolCalls]
                .filter(([idx]) => idx < tc.index)
                .sort((a, b) => a[0] - b[0]);
              for (const [, prior] of completed) tryStreamDispatch(prior);
              pending = {
                id: tc.id || "",
                name: tc.function?.name || "",
                argsParts: [],
              };
              pendingToolCalls.set(tc.index, pending);
              // Only emit tool_use_start if we haven't already emitted for this ID
              if (tc.id) {
                const alreadyCollected = collectedToolCalls.some(
                  (c) => c.id === tc.id,
                );
                if (!alreadyCollected) {
                  yield {
                    type: "tool_use_start",
                    id: tc.id,
                    name: tc.function?.name || "",
                  };
                }
              }
            }
            if (tc.id && !pending.id) pending.id = tc.id;
            if (tc.function?.name && !pending.name)
              pending.name = tc.function.name;
            if (tc.function?.arguments) {
              pending.argsParts.push(tc.function.arguments);
              yield {
                type: "tool_use_delta",
                id: pending.id,
                input: tc.function.arguments,
              };
            }

            // Gemini 3: Capture thought_signature from extra_content.google
            // The thought_signature must be passed back in subsequent turns
            // for function calling to work correctly with Gemini 3 models.
            const tcAny = tc as any;
            const sig =
              tcAny?.extra_content?.google?.thought_signature ??
              tcAny?.extra_content?.google?.thoughtSignature;
            if (sig && !pending.thoughtSignature) {
              pending.thoughtSignature = sig;
            }

            // Capture non-standard tool call fields for native round-trip.
            // Known fields (index, id, type, function) are excluded — the
            // rest is preserved as-is (e.g. extra_content, custom metadata).
            const tcKnownKeys = new Set(['index', 'id', 'type', 'function']);
            for (const key of Object.keys(tc)) {
              if (tcKnownKeys.has(key)) continue;
              const val = (tc as any)[key];
              if (val !== undefined && val !== null) {
                let extras = nativeAccumulator.toolCallExtras.get(tc.index);
                if (!extras) {
                  extras = {};
                  nativeAccumulator.toolCallExtras.set(tc.index, extras);
                }
                extras[key] = val;
              }
            }
          }
        }

        // Finish reason — may appear in multiple chunks (e.g. MiniMax)
        if (choice.finish_reason) {
          markModelProgress();
          stopReason = choice.finish_reason;
          // Emit tool_use_stop for all completed tool calls (guard against duplicates)
          const seenToolIds = new Set(collectedToolCalls.map((tc) => tc.id));
          for (const [, pending] of pendingToolCalls) {
            if (pending.id && !seenToolIds.has(pending.id)) {
              collectedToolCalls.push({
                id: pending.id,
                name: pending.name,
                argsJson: pending.argsParts.join(""),
                thoughtSignature: pending.thoughtSignature,
              });
              seenToolIds.add(pending.id);
              yield { type: "tool_use_stop", id: pending.id };
            }
          }
        }

      }

      // Some OpenAI-compatible providers close the stream after tool-call
      // deltas without sending a final finish_reason chunk. MiniMax has been
      // observed doing this, leaving the UI with a pending "Creating..." tool
      // and the loop with collectedToolCalls empty. Flush any remaining
      // pending calls here so they still execute.
      const seenToolIds = new Set(collectedToolCalls.map((tc) => tc.id));
      for (const [, pending] of pendingToolCalls) {
        if (pending.id && !seenToolIds.has(pending.id)) {
          collectedToolCalls.push({
            id: pending.id,
            name: pending.name,
            argsJson: pending.argsParts.join(""),
            thoughtSignature: pending.thoughtSignature,
          });
          seenToolIds.add(pending.id);
          yield { type: "tool_use_stop", id: pending.id };
        }
      }

      // Get final message for usage/stop reason (not needed with standard stream)
      // Usage and finish_reason are already captured from chunks above
      //
      // CORTE SILENCIOSO (auditoria 2026-07-29): `stopReason` fica "" quando o
      // provider fecha o socket sem nunca mandar `finish_reason`. Isso não é
      // "acabou" — é "não sabemos". Sem esta marca, a recovery de truncagem
      // não disparava (compara com "length") e o run terminava com
      // reason:"completed" sobre uma resposta cortada a meio da frase. É o
      // mesmo defeito que o lado Web tinha, e lá chamei-lhe `sawTerminalSignal`.
      if (!stopReason) {
        streamEndedWithoutSignal = true;
      }
      break;
    } catch (error) {
      const errMsg = formatError(error);
      const outputStarted = hasStartedModelOutput({
        textParts: assistantTextParts,
        thinkingParts: assistantThinkingParts,
        toolCalls: collectedToolCalls,
        pendingToolCalls,
      });

      // Orçamento esgotado — o gate do worker rejeitou com 402 tipado.
      // Não é retryable. Para budget TM/fatia Team normal marcamos o billing
      // store para bloquear o próximo turno localmente; Team BYOK usa outro
      // ledger, então preservamos só a mensagem do worker.
      if (errorStatus(error) === 402) {
        const apiInfo = apiErrorInfo(error);
        const isTeamByokExhausted = apiInfo.type === "tm_team_byok_exhausted";
        let teamMemberBlocked = false;
        try {
          const { useBillingStore } = await import("../../stores/billingStore");
          const store = useBillingStore.getState();
          teamMemberBlocked = !!store.team && store.team.role !== "owner";
        } catch {
          /* non-critical */
        }
        // Códigos conhecidos → mensagem localizada; tm_* desconhecido usa a
        // mensagem do worker verbatim; sem tipo, heurística por contexto.
        const TM_402_MESSAGES: Record<string, string> = {
          tm_budget_exhausted: t("billing.budgetExhaustedError"),
          tm_team_slice_exhausted: t("billing.teamSliceExhaustedError"),
          tm_team_byok_exhausted: t("billing.teamByokExhaustedError"),
        };
        const message =
          (apiInfo.type && TM_402_MESSAGES[apiInfo.type]) ||
          (apiInfo.type?.startsWith("tm_") && apiInfo.message
            ? apiInfo.message
            : teamMemberBlocked
              ? t("billing.teamSliceExhaustedError")
              : t("billing.budgetExhaustedError"));
        yield {
          type: "error",
          message,
        };
        // setNoCredits DEPOIS do yield, nunca antes: o flip dispara o
        // budget-stop watcher (cancelLoop global) e, se corresse antes de o
        // consumer processar este evento, o ramo isAborted() dos handlers
        // engolia a mensagem tipada — um membro de equipa via "compra
        // consumo" (do watcher) em vez de "fala com o admin". O for-await
        // do consumer só faz resume do generator depois de processar o
        // evento, por isso aqui a mensagem já está no chat.
        if (!isTeamByokExhausted) {
          try {
            const { useBillingStore } = await import("../../stores/billingStore");
            useBillingStore.getState().setNoCredits();
          } catch {
            /* non-critical */
          }
        }
        return {
          reason: "error",
          turnCount: state.turnCount,
          totalInputTokens,
          totalOutputTokens,
        };
      }

      if (
        !outputStarted &&
        isPlatformAuthError(error)
      ) {
        if (refreshClient && authRefreshAttempts < PLATFORM_AUTH_REFRESH_ATTEMPTS) {
          authRefreshAttempts++;
          yield {
            type: "agent_status",
            phase: "retrying",
            message: "Authentication token expired. Refreshing and retrying...",
            attempt: authRefreshAttempts,
            maxAttempts: PLATFORM_AUTH_REFRESH_ATTEMPTS,
            httpStatus: errorStatus(error),
          };
          const refreshed = await refreshClient();
          if (refreshed) {
            client = refreshed;
            continue;
          }
        }
        yield {
          type: "error",
          message: "Authentication expired. Please sign in again.",
        };
        return {
          reason: "error",
          turnCount: state.turnCount,
          totalInputTokens,
          totalOutputTokens,
        };
      }

      if (
        !outputStarted &&
        isCredentialOrConfigError(error) &&
        credentialConfigRetries < CREDENTIAL_CONFIG_MAX_RETRIES
      ) {
        const nextRetry = credentialConfigRetries + 1;
        yield {
          type: "agent_status",
          phase: "retrying",
          message: `Provider credential/configuration error. Retrying ${nextRetry}/${CREDENTIAL_CONFIG_MAX_RETRIES} in 30s...`,
          attempt: nextRetry,
          maxAttempts: CREDENTIAL_CONFIG_MAX_RETRIES,
          httpStatus: errorStatus(error),
          retryInMs: CREDENTIAL_CONFIG_RETRY_DELAY_MS,
        };
        const completedDelay = await abortableDelay(
          CREDENTIAL_CONFIG_RETRY_DELAY_MS,
          signal,
        );
        if (!completedDelay) {
          yield { type: "interrupted" };
          return {
            reason: "aborted",
            turnCount: state.turnCount,
            totalInputTokens,
            totalOutputTokens,
          };
        }
        credentialConfigRetries = nextRetry;
        continue;
      }

      // ── 429 rate limit do upstream — retry 3x com escada crescente ──
      // Só antes de qualquer output (o 429 chega sempre pré-stream; se já
      // houve output, repetir duplicaria conteúdo). O Retry-After do
      // provider, quando presente, substitui o degrau da escada.
      if (
        !outputStarted &&
        errorStatus(error) === 429 &&
        rateLimitRetries < RATE_LIMIT_MAX_RETRIES
      ) {
        const nextRetry = rateLimitRetries + 1;
        const delayMs =
          retryAfterMs(error) ??
          RATE_LIMIT_RETRY_DELAYS_MS[rateLimitRetries] ??
          RATE_LIMIT_RETRY_DELAYS_MS[RATE_LIMIT_RETRY_DELAYS_MS.length - 1];
        yield {
          type: "agent_status",
          phase: "retrying",
          message: `Provider rate limit (429). Retrying ${nextRetry}/${RATE_LIMIT_MAX_RETRIES} in ${Math.round(delayMs / 1000)}s...`,
          attempt: nextRetry,
          maxAttempts: RATE_LIMIT_MAX_RETRIES,
          httpStatus: 429,
          retryInMs: delayMs,
        };
        const completedDelay = await abortableDelay(delayMs, signal);
        if (!completedDelay) {
          yield { type: "interrupted" };
          return {
            reason: "aborted",
            turnCount: state.turnCount,
            totalInputTokens,
            totalOutputTokens,
          };
        }
        rateLimitRetries = nextRetry;
        continue;
      }

      // ── Reactive recovery on prompt_too_long ──
      // The provider rejected the prompt as too long. Recover and retry instead
      // of failing the turn (claude-vaz parity). Two rungs, cheapest first:
      //   (1) forced mechanical snip — drops the oldest turns, instant, always
      //       makes progress, and bounds the summarizer input for rung 2;
      //   (2) forced LLM summarization of what remains (when snip can't reduce —
      //       few but huge messages). Only surface the error when both fail.
      // Houve um rung 0 (drain de "staged collapses") — era um no-op GARANTIDO:
      // o staging nunca foi ligado (_enabled=false, stageCollapse sem callers)
      // e o módulo collapse/ foi apagado na auditoria de 2026-07-28.
      const MAX_REACTIVE_RECOVERY = 3;
      const isPromptTooLong =
        /prompt_too_long|prompt is too long|context_length_exceeded/i.test(
          errMsg,
        );

      if (
        isPromptTooLong &&
        state.collapseRecoveryAttempts < MAX_REACTIVE_RECOVERY
      ) {
        // (1) Forced mechanical snip — drop oldest turns, keep a small tail.
        const forcedSnip = snipCompactIfNeeded(messagesForQuery, {
          force: true,
          keepRecentMessages: 8,
        });
        if (forcedSnip.messagesRemoved > 0) {
          console.warn(
            `[query] reactive recovery: forced snip dropped ${forcedSnip.messagesRemoved} ` +
            `msgs (~${forcedSnip.tokensFreed} tokens) after prompt_too_long`,
          );
          state = {
            ...state,
            messages: forcedSnip.messages as QueryMessage[],
            collapseRecoveryAttempts: state.collapseRecoveryAttempts + 1,
          };
          continue queryLoop;
        }

        // (2) Forced LLM summarization of what remains. compactFn's input is
        //     already small here (snip ran), so the summary call won't itself
        //     overflow.
        yield { type: "compact_start", beforeTokens: 0 };
        let reactivePostCompact: QueryMessage[] | null = null;
        try {
          // keepRecentTurns: 0 — modo de emergência. A compactação PROATIVA
          // preserva os turnos recentes, mas aqui o provider JÁ rejeitou o
          // prompt: guardar contexto seria arriscar uma segunda rejeição.
          reactivePostCompact = (await compactNow(
            messagesForQuery,
            systemPrompt,
            compactFn,
            0,
          )) as QueryMessage[] | null;
        } catch (reactiveErr) {
          console.error("[query] reactive summarization failed:", reactiveErr);
        }
        yield { type: "compact_end", beforeTokens: 0, afterTokens: 0 };
        if (reactivePostCompact) {
          state = {
            ...state,
            messages: reactivePostCompact,
            collapseRecoveryAttempts: state.collapseRecoveryAttempts + 1,
          };
          continue queryLoop;
        }
      }

      // ── Withheld transient stream-cut recovery (porte claude-vaz) ──
      // O erro NÃO chega ao user enquanto houver via de recuperação. Guardas:
      //   - !signal.aborted: cancelamento do user nunca é "recuperado";
      //   - só classes transitórias (5xx pós-abertura, transporte, stall do
      //     watchdog) — 4xx tipados já foram tratados acima;
      //   - limite por run (anti-death-spiral).
      // Pré-output: repetir o MESMO pedido é seguro (nada foi emitido).
      // Pós-output: NUNCA repetimos (duplicaria texto na UI) — preservamos o
      // parcial como turno real, fechamos tool calls órfãs com tool_results
      // sintéticos (os cards da UI resolvem em vez de ficarem "running" para
      // sempre) e retomamos num turno novo, mesma mecânica da recovery de
      // max_tokens.
      if (
        !signal.aborted &&
        isTransientStreamCutError(error, errMsg) &&
        streamCutRecoveryCount < STREAM_CUT_RECOVERY_LIMIT
      ) {
        streamCutRecoveryCount++;

        if (!outputStarted) {
          // hasStartedModelOutput não vê o contentBuffer (fragmento de tag
          // <think> parcial ainda não classificado) — limpa-o para o retry
          // não prefixar o stream novo com lixo do anterior.
          contentBuffer.length = 0;
          thinkMode = false;
          yield {
            type: "agent_status",
            phase: "retrying",
            message: `Connection to the model was interrupted. Retrying ${streamCutRecoveryCount}/${STREAM_CUT_RECOVERY_LIMIT}...`,
            attempt: streamCutRecoveryCount,
            maxAttempts: STREAM_CUT_RECOVERY_LIMIT,
            httpStatus: errorStatus(error),
          };
          continue;
        }

        // Fecha os tool calls do stream parcial: pendentes ainda não
        // coletados entram também (o tool_use_start deles já foi emitido —
        // sem resultado sintético o card ficava pendurado).
        const seenIds = new Set(collectedToolCalls.map((tc) => tc.id));
        const orphanedCalls = [...collectedToolCalls];
        for (const [, pending] of pendingToolCalls) {
          if (pending.id && !seenIds.has(pending.id)) {
            orphanedCalls.push({
              id: pending.id,
              name: pending.name,
              argsJson: pending.argsParts.join(""),
              thoughtSignature: pending.thoughtSignature,
            });
            seenIds.add(pending.id);
          }
        }

        const partialBlocks: ContentBlockAPI[] = [];
        const partialThinking = assistantThinkingParts.join("");
        const partialText = assistantTextParts.join("");
        if (partialThinking) partialBlocks.push({ type: "thinking", thinking: partialThinking });
        if (partialText) partialBlocks.push({ type: "text", text: partialText });
        for (const tc of orphanedCalls) {
          partialBlocks.push({
            type: "tool_call",
            id: tc.id,
            name: tc.name,
            arguments: tc.argsJson,
          });
        }

        const syntheticResult =
          "Stream was interrupted by a transient connection error before this tool could execute. " +
          "Re-issue the call if you still need it.";
        const recoveryBlocks: ContentBlockAPI[] = orphanedCalls.map((tc) => ({
          type: "tool_result",
          toolCallId: tc.id,
          content: syntheticResult,
          isError: true,
        }));
        for (const tc of orphanedCalls) {
          yield {
            type: "tool_result",
            toolUseId: tc.id,
            content: syntheticResult,
            isError: true,
          };
        }
        recoveryBlocks.push({
          type: "text",
          text:
            "Your previous message was cut off by a transient connection error mid-stream. " +
            "Resume EXACTLY where it stopped — no apology, no recap, do not repeat text already produced. " +
            "Re-issue any tool call that was interrupted before executing.",
        });

        yield {
          type: "agent_status",
          phase: "retrying",
          message: `Connection interrupted mid-response. Resuming ${streamCutRecoveryCount}/${STREAM_CUT_RECOVERY_LIMIT}...`,
          attempt: streamCutRecoveryCount,
          maxAttempts: STREAM_CUT_RECOVERY_LIMIT,
          httpStatus: errorStatus(error),
        };

        state = {
          ...state,
          messages: [
            ...messagesForQuery,
            ...(partialBlocks.length > 0
              ? [{ role: "assistant" as const, content: partialBlocks }]
              : []),
            { role: "user" as const, content: recoveryBlocks },
          ],
          continuationCount: 0,
        };
        continue queryLoop;
      }

      yield { type: "error", message: errMsg };

      // If we have tool calls from a partial stream, yield error results
      for (const tc of collectedToolCalls) {
        yield {
          type: "tool_result",
          toolUseId: tc.id,
          content: `Error: ${errMsg}`,
          isError: true,
        };
      }

      return {
        reason: "error",
        turnCount: state.turnCount,
        totalInputTokens,
        totalOutputTokens,
      };
    } finally {
      requestAbort.cleanup();
    }
    }

    // ── Record usage ──

    if (turnUsage) {
      totalInputTokens += turnUsage.prompt_tokens;
      totalOutputTokens += turnUsage.completion_tokens;
      onUsage?.(turnUsage.prompt_tokens, turnUsage.completion_tokens);
      // Prompt-cache observability — surfaces provider cache hit/miss per
      // request so a multi-turn session shows the first turn creating the
      // cache and subsequent turns reading it. Anthropic reports
      // cache_read_input_tokens; DashScope reports cached_tokens under usage.
      try {
        const tu2 = turnUsage as unknown as Record<string, unknown>
        const promptDetails = tu2.prompt_tokens_details && typeof tu2.prompt_tokens_details === 'object'
          ? tu2.prompt_tokens_details as Record<string, unknown>
          : undefined
        const cRead = typeof tu2.cache_read_input_tokens === 'number'
          ? tu2.cache_read_input_tokens
          : typeof promptDetails?.cached_tokens === 'number'
            ? promptDetails.cached_tokens
            : typeof tu2.cached_tokens === 'number'
              ? tu2.cached_tokens
              : undefined
        const cCreate = typeof tu2.cache_creation_input_tokens === 'number'
          ? tu2.cache_creation_input_tokens
          : undefined
        if (cRead !== undefined || cCreate !== undefined) {
          const read = cRead ?? 0
          const create = cCreate ?? 0
          const input = turnUsage.prompt_tokens ?? 0
          const uncached = Math.max(0, input - read - create)
          // eslint-disable-next-line no-console
          console.debug(
            `[query] prompt cache · turn ${state.turnCount} · ` +
            `read=${read} create=${create} uncached=${uncached} input=${input} ` +
            `${read > 0 ? '(HIT)' : '(MISS — creating)'}`,
          )
        }
      } catch { /* cache log never blocks the agent loop */ }
      // Real occupancy for the NEXT iteration's compaction decision. input
      // already includes all prior history; output rolls into the next
      // prompt — their sum is the true "how full is the window right now"
      // (matches utils/contextWindow.ts totalContextTokens + the UI pill).
      lastTurnRealOccupancy = turnUsage.prompt_tokens + turnUsage.completion_tokens;
    }

    // Per-request usage log — real tokens + payloadInspector estimate +
    // breakdown. Persist an inspector-only row even if a streaming provider
    // omits usage, otherwise exports lose the request entirely.
    if (turnUsage || payloadReport) {
      try {
        const tu = (turnUsage ?? {}) as unknown as Record<string, unknown>
        const promptDetails = tu.prompt_tokens_details && typeof tu.prompt_tokens_details === 'object'
          ? tu.prompt_tokens_details as Record<string, unknown>
          : undefined
        const dashScopeCachedTokens =
          typeof promptDetails?.cached_tokens === 'number'
            ? promptDetails.cached_tokens
            : typeof tu.cached_tokens === 'number'
              ? tu.cached_tokens
              : undefined
        const cacheCreationInputTokens =
          typeof tu.cache_creation_input_tokens === 'number' ? tu.cache_creation_input_tokens : undefined
        const cacheReadInputTokens =
          typeof tu.cache_read_input_tokens === 'number' ? tu.cache_read_input_tokens : dashScopeCachedTokens
        onRequestUsage?.({
          requestId: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${state.turnCount}-${Date.now()}`,
          turn: state.turnCount,
          executionPhase,
          mutableTask,
          model,
          inputTokens: turnUsage?.prompt_tokens ?? 0,
          outputTokens: turnUsage?.completion_tokens ?? 0,
          usageAvailable: !!turnUsage,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          estimatedInputTokens: payloadReport?.totalEstimatedTokens ?? 0,
          estimatedInputTokensBreakdown: payloadReport?.estimatedInputTokensBreakdown,
          totalMessages: payloadReport?.totalMessages,
          toolCount: payloadReport?.toolCount,
          toolCountTotal: payloadReport?.toolCountTotal,
          toolNames: activeTools.map((tool: any) => tool?.function?.name).filter((name: unknown): name is string => typeof name === 'string'),
          toolDefsTokens: payloadReport?.toolDefsTokens,
          continuationReason: payloadReport?.continuationReason,
          mentionContextTokens: payloadReport?.mentionContextTokens ?? 0,
          breakdown: payloadReport?.byCategory ?? {},
          systemPromptSections: payloadReport?.systemPromptSections ?? [],
          auxiliaryPromptCandidates: payloadReport?.auxiliaryPromptCandidates ?? [],
          // ── Lazy System Prompt + Tighter Toolset telemetry (Phase 1) ──
          // The dynamic/on-demand toolset only "counts" if the export can prove it:
          // which profile the Intent Router chose, the core/auxiliary token
          // split, the savings, and which tools were requested vs denied by
          // explicit policy.
          selectedPromptProfile: auxiliarySelection?.profile,
          selectedToolProfile: toolsetSelector?.getProfile() ?? auxiliarySelection?.profile,
          coreContextTokens: payloadReport?.coreContextTokens,
          coreSystemTokens: payloadReport?.coreSystemTokens,
          onDemandIndexTokens: payloadReport?.onDemandIndexTokens,
          auxiliaryContextTokens: payloadReport?.auxiliaryContextTokens,
          auxiliaryLoaded: payloadReport?.auxiliaryLoaded?.map((a: { id: string }) => a.id),
          loadedSystemSections: payloadReport?.loadedSystemSections,
          auxiliaryOmitted: payloadReport?.auxiliaryOmitted?.map((a: { id: string }) => a.id),
          omittedSystemSections: payloadReport?.omittedSystemSections,
          autoLoadedSystemSections: payloadReport?.autoLoadedSystemSections,
          contextPlanCandidateSections: payloadReport?.contextPlanCandidateSections,
          modelRequestedContextSections: payloadReport?.modelRequestedContextSections,
          requestContextToolCalls: payloadReport?.requestContextToolCalls,
          requestContextSectionsLoaded: payloadReport?.requestContextSectionsLoaded,
          requestContextSelectionReason: payloadReport?.requestContextSelectionReason,
          requestContextCostTier: payloadReport?.requestContextCostTier,
          requestContextFallbackUsed: payloadReport?.requestContextFallbackUsed,
          requestContextFallbackFrom: payloadReport?.requestContextFallbackFrom,
          requestContextFallbackTo: payloadReport?.requestContextFallbackTo,
          requestedButNotLoadedSections: payloadReport?.requestedButNotLoadedSections,
          requestedContextSections: payloadReport?.requestedContextSections,
          auxiliarySavingsTokens: payloadReport?.auxiliarySavingsTokens,
          systemPromptSavingsTokens: payloadReport?.systemPromptSavingsTokens,
          systemPromptProfileReason: payloadReport?.systemPromptProfileReason,
          readOnlyRun: auxiliarySelection?.readOnly,
          toolsetReason: auxiliarySelection?.reason,
          routerSource: auxiliarySelection?.routerSource,
          routerConfidence: auxiliarySelection?.routerConfidence,
          routerError: auxiliarySelection?.routerError,
          routerDiagnostics: auxiliarySelection?.routerDiagnostics,
          // ── Context Planner telemetry (audit) ──
          contextPlannerStatus: auxiliarySelection?.contextPlannerStatus,
          contextPlannerSource: auxiliarySelection?.contextPlannerSource,
          contextPlannerModel: auxiliarySelection?.contextPlannerModel,
          contextPlannerError: auxiliarySelection?.contextPlannerError,
          contextPlannerRawOutput: auxiliarySelection?.contextPlannerRawOutput,
          contextPlannerFallbackReason: auxiliarySelection?.contextPlannerFallbackReason,
          contextPlannerTaskDomain: auxiliarySelection?.contextPlan?.taskDomain,
          contextPlannerRequiredCapabilities: auxiliarySelection?.contextPlan?.requiredCapabilities,
          contextPlannerSelectedContexts: auxiliarySelection?.contextPlan?.selectedContexts,
          contextPlannerRejectedContexts: auxiliarySelection?.contextPlannerRejectedContexts,
          contextPlannerSelectionReason: auxiliarySelection?.contextPlannerSelectionReason,
          expandedToolNames: toolsetSelector?.getExpandedNames(),
          deniedToolNames: toolsetSelector?.getDeniedNames(),
          // ── Read Range Tracker telemetry ──
          // Quais intervalos foram lidos entre o pedido anterior e este. Os
          // contadores skippedOverlappingReads/adjustedReadRanges saíram com a
          // dedup de sobreposição (auditoria 2026-07-29): sem a dedup só podiam
          // reportar zero, e uma métrica que não pode variar mente sobre o que
          // mede — quem lesse o painel concluía "nenhuma leitura redundante".
          readRanges: getReadRanges(),
          // ── Mention context redundancy telemetry (Correção B) ──
          // mentionContextSentFullThisTurn=false means the follow-up-turn
          // stub fired (full outline replaced by a short reference);
          // mentionContextRepeatedTokens is the token saving vs re-sending
          // the full body. Both reset each turn.
          ...getAndResetMentionContextStats(),
          // ── "Stopped without editing" guardrail telemetry ──
          // Cumulative values as of THIS request. The guardrail fires AFTER
          // onRequestUsage, so noEditGuardTriggered reflects the PREVIOUS
          // turn's firing. Final decision fields (completionGuardDecision /
          // completionGuardReason) are stamped on the last entry by the
          // caller after the loop returns (see QueryTerminal).
          runHasEdited,
          noEditRecoveryCount,
          noEditGuardTriggered: guardTriggeredLastTurn,
          noEditGuardReason,
          noEditRecoveryAction,
          firstWriteTurn,
          writeActionCount,
          originalTaskWriteActionCount: executionPhase === 'original_task' ? writeActionCount : 0,
          originalTaskFirstWriteTurn: executionPhase === 'original_task' ? firstWriteTurn : undefined,
          // ── Delegate/sub-agent telemetry ──
          // Read from the toolExecutor's last delegate call info. Populated
          // on the turn AFTER delegate was called (onRequestUsage fires before
          // tool execution; the data surfaces on the next request's entry).
          ...(() => {
            const di = params.getDelegateTelemetry?.() ?? null
            if (!di) return {}
            return {
              delegateRequestedMember: di.requestedMember,
              delegateResolvedMember: di.resolvedMember,
              delegateBlocked: di.blocked,
              delegateBlockedReason: di.blockedReason,
              delegateInputSchemaVersion: di.inputSchemaVersion,
              delegateRecoveryAttempted: di.recoveryAttempted,
            }
          })(),
        })
      } catch { /* usage logging never blocks the agent loop */ }
    }
    // Reset the guard-triggered flag after the usage entry has captured it,
    // so it's only true on the request that immediately follows the firing.
    guardTriggeredLastTurn = false;

    // ── Build provider-native state for round-trip ──
    // Reconstruct the assistant message as the provider would have
    // returned it non-streaming. Preserves reasoning_content,
    // reasoning_details, tool_calls with extra fields, and any
    // unknown delta fields. Used by rebuildConversationHistory for
    // exact native round-trip instead of text-based reconstruction.
    const nativeAssistantMessage: Record<string, unknown> = {
      role: 'assistant',
      content: assistantTextParts.join('') || null,
    };
    if (nativeAccumulator.reasoningContent) {
      nativeAssistantMessage.reasoning_content = nativeAccumulator.reasoningContent;
    }
    if (nativeAccumulator.reasoningDetails.length > 0) {
      nativeAssistantMessage.reasoning_details = nativeAccumulator.reasoningDetails;
    }
    if (collectedToolCalls.length > 0) {
      nativeAssistantMessage.tool_calls = collectedToolCalls.map((tc, idx) => {
        const tcNative: Record<string, unknown> = {
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.argsJson,
          },
        };
        // Merge per-tool-call extra fields captured from delta
        const extras = nativeAccumulator.toolCallExtras.get(idx);
        if (extras) {
          Object.assign(tcNative, extras);
        }
        return tcNative;
      });
    }
    // Merge any unknown delta-level fields (provider-specific extras)
    for (const [key, val] of Object.entries(nativeAccumulator.extraDeltaFields)) {
      if (!(key in nativeAssistantMessage)) {
        nativeAssistantMessage[key] = val;
      }
    }

    const turnProviderState: ProviderState = {
      provider: model,
      protocol: 'openai-chat',
      nativeAssistantMessage,
      capturedAt: Date.now(),
    };

    // Safe debug log — sizes and presence only, never content
    const nativeSize = JSON.stringify(nativeAssistantMessage).length;
    const hasReasoning = !!nativeAssistantMessage.reasoning_content;
    const hasReasoningDetails = nativeAccumulator.reasoningDetails.length > 0;
    const tcCount = collectedToolCalls.length;
    const extraFieldCount = Object.keys(nativeAccumulator.extraDeltaFields).length;
    // eslint-disable-next-line no-console
    console.debug(
      `[query] providerState captured: ${nativeSize}B, ` +
      `reasoning=${hasReasoning}, reasoning_details=${hasReasoningDetails}, ` +
      `tool_calls=${tcCount}, extra_fields=${extraFieldCount}`,
    );

    yield { type: "message_stop", stopReason, usage: turnUsage, providerState: turnProviderState };

    // ── Output-cap escalation (porte claude-vaz) ──
    // O output foi truncado pelo cap ("length" = OpenAI-compat; "max_tokens"
    // = Anthropic). Duplica o cap dos pedidos SEGUINTES até ao máximo do
    // modelo (getContextLimits) ou ESCALATED_MAX_OUTPUT_TOKENS. Aplica-se
    // também quando há tool calls: argsJson truncado a meio é exatamente o
    // caso que o reparo de _parseError tenta remendar — mais vale o próximo
    // pedido ter espaço do que remendar JSON outra vez.
    if (stopReason === "length" || stopReason === "max_tokens") {
      const ceiling = getContextLimits?.()?.maxOutputTokens ?? ESCALATED_MAX_OUTPUT_TOKENS;
      const next = Math.min(ceiling, maxTokens * 2);
      if (next > maxTokens) {
        escalatedMaxTokens = next;
        console.debug(
          `[query] output truncated (finish_reason=${stopReason}) — escalating max_tokens ${maxTokens} → ${next} for subsequent requests`,
        );
      }
    }

    // ── Build assistant message and add to history ──

    const assistantBlocks: ContentBlockAPI[] = [];
    if (assistantThinkingParts.length > 0) {
      assistantBlocks.push({
        type: "thinking",
        thinking: assistantThinkingParts.join(""),
      });
    }
    if (assistantTextParts.length > 0) {
      assistantBlocks.push({ type: "text", text: assistantTextParts.join("") });
    }
    for (const tc of collectedToolCalls) {
      assistantBlocks.push({
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        arguments: tc.argsJson,
        ...(tc.thoughtSignature
          ? { thoughtSignature: tc.thoughtSignature }
          : {}),
      });
    }

    const assistantMessage: QueryMessage = {
      role: "assistant",
      content:
        assistantBlocks.length > 0
          ? assistantBlocks
          : assistantTextParts.join("") || "",
    };

    const updatedMessages = [...messagesForQuery, assistantMessage];

    // ── Check if we need to continue (tool_use) ──

    if (collectedToolCalls.length === 0) {
      const assistantText = assistantTextParts.join("").trim();
      const assistantThinking = assistantThinkingParts.join("").trim();

      // Guardrail: a turn that emits only reasoning and no visible text/tool call
      // is not useful to the developer. Give the model one chance to recover,
      // then stop instead of burning credits in a thinking loop.
      if (!assistantText && assistantThinking.length > 0) {
        if (thinkingOnlyRecoveryCount < 1) {
          state = {
            ...state,
            messages: [
              ...updatedMessages,
              {
                role: "user",
                content:
                  "Your previous turn produced only thinking/reasoning with no visible answer and no tool call. Stop reasoning privately and either call the correct tool now or provide the concise final answer. Do not repeat the same thinking.",
              },
            ],
            continuationCount: 0,
          };
          thinkingOnlyRecoveryCount++;
          continue;
        }
        yield {
          type: "error",
          message:
            "Stopped: the model produced only thinking with no visible answer or tool call.",
        };
        return {
          reason: "error",
          turnCount: state.turnCount,
          totalInputTokens,
          totalOutputTokens,
        };
      }

      const loopCheck = checkForLoop(assistantText, loopDetectorState);
      if (loopCheck.isLoop) {
        yield {
          type: "error",
          message: `Stopped: repeated similar assistant output detected (${Math.round(loopCheck.similarity * 100)}% similarity across ${loopCheck.count} turns).`,
        };
        return {
          reason: "error",
          turnCount: state.turnCount,
          totalInputTokens,
          totalOutputTokens,
        };
      }

      // No tool calls — check for output-cap truncation continuation.
      // BUG HISTÓRICO (corrigido 2026-07-13): comparava só com "max_tokens"
      // (vocabulário Anthropic), mas os providers OpenAI-compat do data-plane
      // emitem finish_reason "length" — a recovery NUNCA disparava e respostas
      // truncadas terminavam a run como se estivessem completas. O cap dos
      // pedidos seguintes já foi escalado no pós-stream (escalatedMaxTokens),
      // por isso a continuação tem espaço real, não só o pedido de brevidade.
      const truncatedByCap = stopReason === "length" || stopReason === "max_tokens";
      // Corte silencioso: sem finish_reason E com texto produzido, a resposta
      // ficou a meio. Só conta como corte se houve texto — um stream vazio sem
      // sinal é outro problema (erro de transporte) e não se resolve pedindo
      // ao modelo para "continuar de onde parou".
      const cutSilently = streamEndedWithoutSignal && assistantTextParts.join('').trim().length > 0;
      if (
        (truncatedByCap || cutSilently) &&
        maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
      ) {
        state = {
          ...state,
          messages: [
            ...updatedMessages,
            {
              role: "user",
              content: truncatedByCap
                ? "Your previous message hit the output token limit and was cut off mid-answer. " +
                  "Resume EXACTLY where it stopped — no apology, no recap, do not repeat text already produced."
                : "Your previous message was cut off mid-answer (the connection closed before you finished). " +
                  "Resume EXACTLY where it stopped — no apology, no recap, do not repeat text already produced.",
            },
          ],
          maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
          continuationCount: 0,
        };
        continue;
      }
      // Esgotou as tentativas de retoma e continua cortada: o run NÃO está
      // completo, e dizê-lo é o mínimo. Quem chama já distingue os reasons.
      if (truncatedByCap || cutSilently) {
        state.messages = updatedMessages;
        return {
          reason: "incomplete",
          turnCount: state.turnCount,
          totalInputTokens,
          totalOutputTokens,
          runHasEdited,
          noEditRecoveryCount,
          noEditGuardTriggered: noEditRecoveryCount > 0,
          firstWriteTurn,
          writeActionCount,
        };
      }

      // The model is ready to stop — but if the developer queued a message
      // while it was finishing, act on it in THIS run instead of ending and
      // making them wait for a fresh dispatch. Same steering collector as the
      // post-tool boundary; a non-empty return keeps the loop alive.
      if (params.collectQueuedSteering) {
        let steered: QueuedSteeringContent | null = null;
        try {
          steered = await params.collectQueuedSteering();
        } catch {
          // Best-effort — never let steering break the stop path.
        }
        if (steered) {
          state = {
            ...state,
            messages: [
              ...updatedMessages,
              steeringContentToUserMessage(steered),
            ],
            continuationCount: 0,
          };
          continue;
        }
      }

      // Guardrail: mutable original-task run that ends without a single file
      // mutation. The model likely diagnosed the work but deferred the edit.
      // Give it one chance to continue; if it stops again without editing,
      // let it end with explicit telemetry instead of looping on reads.
      if (
        mutableTask &&
        !runHasEdited &&
        noEditRecoveryCount < 1 &&
        // FASE A: selector null = toolset completo congelado (o caso normal);
        // o guard continua vivo — read-only explícito continua a desarmá-lo.
        !readOnlyRun &&
        (!toolsetSelector || !toolsetSelector.isReadOnly())
      ) {
        const hasEditFile = !toolsetSelector || toolsetSelector.isActive(EDIT_FILE);
        noEditGuardReason = "mutable original_task attempted to stop without file edit";
        noEditRecoveryAction = hasEditFile ? "apply_edit" : "request_tools:edit_file";
        state = {
          ...state,
          messages: [
            ...updatedMessages,
            {
              role: "user",
              // DEBIAS (auditoria 2026-07-17): a versão anterior ORDENAVA um
              // edit ("apply the change now") — num diagnóstico cuja resposta
              // certa é uma decisão de arquitetura ("este runtime não suporta
              // esta dependência"), isso empurrava o modelo para remendos de
              // config/bundler em vez de fechar a decisão. A porta de saída
              // explícita mantém o guardrail (não adiar) sem forçar o remendo.
              content: hasEditFile
                ? "You have edit_file available but have not applied any edit yet. If a code change is genuinely the right outcome, apply it now — do not defer to the next turn. But if your investigation concluded that NO edit is appropriate (the correct outcome is an architecture/runtime decision, a recommendation, or the cause lies outside this codebase), do not force one: state that conclusion explicitly and decisively as your final answer."
                : "You have not applied any file edit yet. If a code change is genuinely the right outcome, call request_tools to activate edit_file and apply it now — do not defer. But if your investigation concluded that NO edit is appropriate (architecture/runtime decision, recommendation, or external cause), do not force one: state that conclusion explicitly and decisively as your final answer.",
            },
          ],
          continuationCount: 0,
        };
        noEditRecoveryCount++;
        guardTriggeredLastTurn = true;
        continue;
      }

      // Guardrail: run is stopping while the task tracker still has
      // non-completed tasks AND the model never called update_tasks this run.
      // This is the observed "claims everything is done, tracker says 0/N"
      // failure: the model narrates completion (or calls update_session_memory
      // believing that IS the tracker) and ends, stranding the panel on
      // pending rows. One reconciliation nudge per run; a model that touched
      // the tracker at all (even partially) is deliberately NOT nudged —
      // partial sessions legitimately end with pending tasks.
      //
      // `writeActionCount > 0` (auditoria 2026-07-29): o tracker é POR SESSÃO,
      // não por run, portanto as linhas pendentes que este run nunca tocou
      // podem ser de um pedido ANTERIOR já resolvido. Sem esta condição, uma
      // pergunta read-only ("onde está X?") a seguir a um run com linhas
      // pendentes era interrompida com uma ordem para reconciliar um tracker
      // que não é dela — ruído com cara de guardrail. Com trabalho de escrita
      // feito, a reconciliação é legítima; e o texto passa a admitir que as
      // linhas podem ser de antes, que é uma resolução válida em vez de um
      // convite a inventar progresso.
      if (taskGuardCount < 1 && !runTouchedTaskTracker && writeActionCount > 0) {
        try {
          const { useAgentStore } = await import("../../stores/agentStore");
          const tasks = useAgentStore.getState().tasks;
          const unfinished = tasks.filter((tk) => tk.status !== "completed");
          if (tasks.length > 0 && unfinished.length > 0) {
            taskGuardCount++;
            const preview = unfinished
              .slice(0, 4)
              .map((tk) => `- ${tk.description ?? tk.id} (${tk.status})`)
              .join("\n");
            state = {
              ...state,
              messages: [
                ...updatedMessages,
                {
                  role: "user",
                  content:
                    `You changed files this run but never called update_tasks, and the task tracker still shows ${unfinished.length} task(s) not completed:\n${preview}\n\n` +
                    `Reconcile it before finishing (update_session_memory is NOT the task tracker — use update_tasks): ` +
                    `if this work is actually done and verified, call update_tasks now marking each finished task completed (with evidence); ` +
                    `if something remains, continue working on it now; if a task is obsolete, blocked, or left over from an EARLIER request, update its status/description to say exactly that. ` +
                    `Do not invent progress to clear a row, and do not end the run with a tracker that contradicts what happened.`,
                },
              ],
              continuationCount: 0,
            };
            continue;
          }
        } catch {
          // Guardrail is best-effort — never let it break the stop path.
        }
      }

      // Model is done — return terminal
      state.messages = updatedMessages;
      return {
        reason: "completed",
        turnCount: state.turnCount,
        totalInputTokens,
        totalOutputTokens,
        // Guardrail telemetry — final values at loop termination.
        runHasEdited,
        noEditRecoveryCount,
        noEditGuardTriggered: noEditRecoveryCount > 0,
        firstWriteTurn,
        writeActionCount,
        originalTaskWriteActionCount: executionPhase === 'original_task' ? writeActionCount : 0,
        originalTaskFirstWriteTurn: executionPhase === 'original_task' ? firstWriteTurn : undefined,
        noEditGuardReason,
        noEditRecoveryAction,
        completionGuardDecision:
          noEditRecoveryCount > 0 && runHasEdited
            ? "recovered_then_completed"
            : noEditRecoveryCount > 0 && !runHasEdited
              ? "recovery_failed_then_completed"
              : "completed",
        completionGuardReason:
          noEditRecoveryCount > 0
            ? runHasEdited
              ? "mutable original_task attempted to stop without edit; guardrail steered the model to request/edit and apply the change"
              : "mutable original_task attempted to stop without edit; guardrail fired but model did not recover"
            : undefined,
      };
    }

    // Tool calls mean the model is making observable progress; reset loop guards.
    resetLoopDetector(loopDetectorState);
    thinkingOnlyRecoveryCount = 0;

    // ── Tool-call loop guard ──
    // "Tool calls = progress" is true only while the calls CHANGE. The same
    // call with the same args, over and over, is the most expensive failure
    // mode there is and the text detector above cannot see it (it only runs on
    // turns without tool calls). Polling tools are exempt — repeating is what
    // they are for.
    const toolLoop = checkForToolLoop(
      computeToolBatchFingerprint(
        collectedToolCalls.map((tc) => ({ name: tc.name, argsJson: tc.argsJson })),
      ),
      toolLoopState,
    );
    if (toolLoop.shouldStop) {
      yield {
        type: "error",
        message: `Stopped: the same tool call was repeated ${toolLoop.repeats} times with identical arguments and no change in result.`,
      };
      return {
        reason: "error",
        turnCount: state.turnCount,
        totalInputTokens,
        totalOutputTokens,
      };
    }
    const pendingToolLoopNudge: string | null = toolLoop.shouldNudge
      ? buildToolLoopNudgeText(toolLoop.repeats)
      : null;

    // ── Execute tools ──

    // Fecho do stream: o pre-dispatch a meio do SSE só arranca quando um índice
    // POSTERIOR aparece, portanto o ÚLTIMO tool call de cada ronda — e todo o
    // turn de chamada única, que é o caso mais comum — nunca beneficiava dele
    // e corria serial (3 web_fetch independentes = 3x a latência). Aqui a
    // ronda já está fechada e os args completos: despacha o resto do PREFIXO
    // stream-safe de uma vez.
    //
    // O prefixo é a mesma invariante do mid-stream: o primeiro tool não-seguro
    // corta os seguintes, para que nada com efeitos colaterais corra fora da
    // ordem que o modelo pediu. Reavaliado do zero (e não a partir de
    // `streamDispatchBroken`) porque o que a meio do stream era "args
    // incompletos" já não é: agora estão todos lá.
    if (!signal.aborted && isStreamSafeTool) {
      for (const tc of collectedToolCalls) {
        if (!tc.id || !tc.name || !isStreamSafeTool(tc.name)) break;
        if (preDispatched.has(tc.id)) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = tc.argsJson ? JSON.parse(tc.argsJson) : {};
        } catch {
          break;
        }
        preDispatched.set(tc.id, {
          argsJson: tc.argsJson,
          promise: executeTool(tc.name, parsed, tc.id, signal).catch((err) => ({
            content: `Tool execution error: ${formatError(err)}`,
            isError: true,
          })),
        });
      }
    }

    const toolResultBlocks: Array<ContentBlockAPI & { isError?: boolean }> = [];

    for (const tc of collectedToolCalls) {
      if (signal.aborted) {
        yield { type: "interrupted" };
        return {
          reason: "aborted",
          turnCount: state.turnCount,
          totalInputTokens,
          totalOutputTokens,
        };
      }

      let toolInput: Record<string, unknown> = {};
      try {
        toolInput = tc.argsJson ? JSON.parse(tc.argsJson) : {};
      } catch {
        toolInput = {};
      }

      if ((readOnlyRun || toolsetSelector?.isReadOnly()) && DESTRUCTIVE_TOOLS.has(canonicalToolName(tc.name))) {
        toolsetSelector?.noteDeniedToolName(tc.name);
        const blocked = `Tool blocked: ${tc.name} cannot run because this run is read-only (no file mutations).`;
        yield {
          type: "tool_result",
          toolUseId: tc.id,
          content: blocked,
          isError: true,
        };
        toolResultBlocks.push({
          type: "tool_result",
          toolCallId: tc.id,
          content: blocked,
          isError: true,
        });
        continue;
      }

      try {
        // Execução em streaming: se este tool call foi pre-despachado durante
        // o stream, consome o resultado (já pronto ou quase). O guard de
        // argsJson invalida o pre-dispatch quando args chegaram DEPOIS do
        // despacho (interleaving raro de provider): re-executa com os args
        // completos — o pre-dispatch é sempre read-only, o custo é só o
        // overlap perdido, nunca um side effect duplicado.
        const pre = preDispatched.get(tc.id);
        const result =
          pre && pre.argsJson === tc.argsJson
            ? await pre.promise
            : await executeTool(tc.name, toolInput, tc.id, signal);
        const modelContent = sanitizeToolResultForModel(result.content)
        yield {
          type: "tool_result",
          toolUseId: tc.id,
          content: result.content,
          isError: result.isError,
        };
        toolResultBlocks.push({
          type: "tool_result",
          toolCallId: tc.id,
          content: modelContent,
          isError: result.isError,
        });
        // Track whether any file-mutating tool ran successfully this run.
        // Drives the "stopped without editing" guardrail at the stop path.
        // canonicalToolName: `tc.name` é o que o MODELO escreveu (`Edit`,
        // `Write`), e DESTRUCTIVE_TOOLS guarda nomes canónicos. Sem isto,
        // runHasEdited/writeActionCount/firstWriteTurn ficavam permanentemente
        // falsos para o agente principal — a instrumentação de onde estas
        // auditorias saem reportava "run sem edições" em TODOS os runs que
        // editaram ficheiros.
        if (!result.isError && DESTRUCTIVE_TOOLS.has(canonicalToolName(tc.name))) {
          runHasEdited = true;
          writeActionCount++;
          writesSinceTaskTrackerUpdate++;
          if (firstWriteTurn === undefined) {
            firstWriteTurn = state.turnCount;
          }
        }
        // Track whether the model touched the task tracker at all this run.
        // Drives the task-reconciliation guardrail at the stop path: a run
        // that ends with unfinished tasks AND never called update_tasks is
        // the "claims done, tracker says 0/N" failure mode.
        if (!result.isError && tc.name === "update_tasks") {
          runTouchedTaskTracker = true;
          lastTaskTrackerUpdateTurn = state.turnCount;
          writesSinceTaskTrackerUpdate = 0;
        }
      } catch (err) {
        const errMsg = formatError(err);
        yield {
          type: "tool_result",
          toolUseId: tc.id,
          content: `Tool execution error: ${errMsg}`,
          isError: true,
        };
        toolResultBlocks.push({
          type: "tool_result",
          toolCallId: tc.id,
          content: `Tool execution error: ${errMsg}`,
          isError: true,
        });
      }
    }

    // ── Turn-efficiency measurement ──
    // When the loop exceeds the 3-4-request target for localized fixes,
    // infer WHY it continued from what the turn actually did (tool calls +
    // results). Never blocks — pure observability so a 7-turn bugfix leaves
    // a forensic trail of the technical reason (or the lack of one).
    if (state.turnCount >= EFFICIENCY_TARGET_TURNS) {
      try {
        const reason = inferContinuationReason({
          toolCalls: collectedToolCalls.map((tc) => ({ name: tc.name })),
          toolResults: toolResultBlocks
            .filter((b): b is ContentBlockAPI & { type: "tool_result"; content: string; isError?: boolean } =>
              b.type === "tool_result")
            .map((b) => ({
              content: b.content ?? "",
              isError: !!b.isError,
            })),
        });
        lastContinuationReason = reason;
        const legit = isLegitimateContinuationReason(reason);
        // eslint-disable-next-line no-console
        console.debug(
          `[query] turn efficiency · turn ${state.turnCount} · ` +
          (legit ? `continuing: ${reason}` : `WARNING — ${reason}`) +
          (legit ? "" : " — consider wrapping up if the task is simple"),
        );
        if (trackEfficiencyNudge(efficiencyNudgeState, reason, state.turnCount)) {
          pendingEfficiencyNudge = buildEfficiencyNudgeText(state.turnCount);
          // eslint-disable-next-line no-console
          console.debug(
            `[query] turn efficiency · injecting wrap-up nudge #${efficiencyNudgeState.nudgeCount} at turn ${state.turnCount}`,
          );
        }
      } catch {
        /* measurement never blocks the loop */
      }
    }

    // Add tool results as a user message
    const toolResultMessage: QueryMessage = {
      role: "user",
      content: toolResultBlocks,
    };

    // ── Inter-turn attachments (claude-vaz parity) ──
    // After the tool round, give the host a chance to inject context the
    // model should see before its next response — today the external-
    // modification sweep ("Note: X was modified..."). Appended AFTER the
    // tool results, mirroring claude-vaz's ordering constraint.
    const interTurnMessages: QueryMessage[] = [];
    if (params.collectInterTurnContext) {
      try {
        const interTurnContext = await params.collectInterTurnContext();
        if (interTurnContext) {
          interTurnMessages.push({
            role: "user",
            content: [{ type: "text", text: interTurnContext }],
          });
        }
      } catch {
        // The sweep is best-effort — never let it break the loop.
      }
    }

    // ── Re-injecção periódica das regras de maior custo ──
    // O reminder vive no topo do prompt, mas ao fim de muitos turnos de tool
    // results a cauda — que é onde o modelo mais atende — afasta-se dele e as
    // regras começam a cair. O bloco existia e estava documentado como
    // "AgentService re-injects this every N turns"… sem um único caller
    // (auditoria 2026-07-28): runs longos perdiam exatamente as regras que a
    // re-injecção foi construída para segurar.
    //
    // GATED por params.reinjectCriticalReminder: os SUB-AGENTES correm este
    // mesmo loop com prompts próprios que não contêm estas regras — injetar
    // aqui regras de dev-server/credentials num Explore seria contaminação
    // (a primeira versão desta ligação fazia exatamente isso; apanhada na
    // própria sessão). Main e tarefas paralelas ligam o flag; sub-agentes não.
    //
    // Texto DETERMINISTA de propósito (sem contadores interpolados): cada
    // re-injecção é byte-idêntica, e como é append no fim do histórico não
    // toca no prefixo já cacheado.
    if (params.reinjectCriticalReminder && state.turnCount > 0 && state.turnCount % REMINDER_REINJECT_INTERVAL_TURNS === 0) {
      interTurnMessages.push({
        role: "user",
        content: [{ type: "text", text: getCriticalReinjectionReminder() }],
      });
    }

    // Aviso de ronda repetida — antes do nudge de eficiência: "estás a repetir
    // a mesma chamada" é informação mais acionável do que "já vais em N turns".
    if (pendingToolLoopNudge) {
      interTurnMessages.push({
        role: "user",
        content: [{ type: "text", text: pendingToolLoopNudge }],
      });
      // eslint-disable-next-line no-console
      console.debug(
        `[query] tool-loop · same round repeated ${toolLoop.repeats}x · nudging at turn ${state.turnCount}`,
      );
    }

    // Repetição ESPAÇADA da mesma chamada exacta (mesma tool, mesmos args).
    // Distinta do bloco acima, que só vê rondas consecutivas: com uma ronda
    // diferente pelo meio o contador reinicia e a repetição fica invisível.
    // Medido na sessão yyyy (2026-07-30): a mesma busca na ronda 2 e na ronda
    // 12, com o mesmo "No matches found." — um turno inteiro para reconfirmar
    // um "não existe" que já estava no contexto. Nada é escondido: a chamada
    // correu e o resultado chegou inteiro; isto só nomeia o facto.
    if (toolLoop.repeatedFromRound !== null && !pendingToolLoopNudge) {
      interTurnMessages.push({
        role: "user",
        content: [{ type: "text", text: buildRepeatedCallNoteText(toolLoop.repeatedFromRound) }],
      });
      // eslint-disable-next-line no-console
      console.debug(
        `[query] tool-loop · exact call repeated from round ${toolLoop.repeatedFromRound} at turn ${state.turnCount}`,
      );
    }

    // Nudge de eficiência (decidido na medição desta ronda) — viaja no mesmo
    // canal dos attachments, DEPOIS do sweep e ANTES do steering: se o
    // developer mandou instruções, são elas a última palavra, não o nudge.
    if (pendingEfficiencyNudge) {
      interTurnMessages.push({
        role: "user",
        content: [{ type: "text", text: pendingEfficiencyNudge }],
      });
      pendingEfficiencyNudge = null;
    }

    // ── Periodic task-tracker reconciliation ──
    // The end-of-run guard catches a contradictory completion claim, but a
    // long implementation needs a gentle, structural reminder before that
    // point. Read the live tracker only after successful mutations and use a
    // throttled pure decision function so no reminder becomes prompt noise.
    if (params.enableTaskTrackerReminder && writesSinceTaskTrackerUpdate > 0) {
      try {
        const { useAgentStore } = await import("../../stores/agentStore");
        const unfinishedTaskCount = useAgentStore.getState().tasks
          .filter((task) => task.status !== "completed").length;
        if (shouldRemindTaskTracker(taskTrackerReminderState, {
          turnCount: state.turnCount,
          lastTaskUpdateTurn: lastTaskTrackerUpdateTurn,
          writesSinceTaskUpdate: writesSinceTaskTrackerUpdate,
          unfinishedTaskCount,
        })) {
          interTurnMessages.push({
            role: "user",
            content: [{
              type: "text",
              text: buildTaskTrackerReminderText(
                writesSinceTaskTrackerUpdate,
                unfinishedTaskCount,
              ),
            }],
          });
        }
      } catch {
        // Tracker state is advisory; it must never interrupt the run.
      }
    }

    // ── Queued-message steering (claude-vaz parity) ──
    // Mid-run, the developer may have queued a follow-up ("also do X",
    // "stop, do Y instead"). Drain it HERE so it rides the next turn instead
    // of waiting for the whole run to finish. Appended AFTER the inter-turn
    // sweep so the user's own words are the most recent message the model
    // sees. The host owns the transcript bookkeeping inside the collector.
    const steeringMessages: QueryMessage[] = [];
    if (params.collectQueuedSteering) {
      try {
        const steered = await params.collectQueuedSteering();
        if (steered) {
          steeringMessages.push(steeringContentToUserMessage(steered));
        }
      } catch {
        // Best-effort — a steering failure must never break the loop.
      }
    }

    // ── Update state for next iteration ──

    state = {
      messages: [
        ...updatedMessages,
        toolResultMessage,
        ...interTurnMessages,
        ...steeringMessages,
      ],
      autoCompactTracking: tracking,
      maxOutputTokensRecoveryCount: 0,
      continuationCount: 0,
      turnCount: state.turnCount,
      collapseRecoveryAttempts: state.collapseRecoveryAttempts,
    };
  } // while (true)
}
