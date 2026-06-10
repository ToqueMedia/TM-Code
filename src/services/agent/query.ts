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
import type { ContentBlockAPI, ProviderState } from "../../types/chat";
import {
  microcompact,
  applyToolResultBudget,
  snipCompactIfNeeded,
  autoCompact,
  getCompactPrompt,
  type AutoCompactTrackingState,
  type CompactFn,
} from "./compact";
import {
  applyCollapsesIfNeeded,
  recoverFromOverflow,
  withholdPromptTooLong,
  resetContextCollapse,
} from "./collapse";
import {
  checkForLoop,
  createLoopDetectorState,
  resetLoopDetector,
} from "./loopDetector";

// ── Constants ──

const MAX_OUTPUT_TOKENS = 32_768;
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const PLATFORM_AUTH_REFRESH_ATTEMPTS = 1;
const CREDENTIAL_CONFIG_MAX_RETRIES = 3;
const CREDENTIAL_CONFIG_RETRY_DELAY_MS = 30_000;

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
  | { type: "compact_end"; beforeTokens: number; afterTokens: number }
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
  /** Custom compact instructions. */
  compactInstructions?: string;
  /** Extra headers merged into every chat.completions.create request. */
  extraHeaders?: Record<string, string>;
  /** Called as soon as streaming response headers are available. */
  onResponseHeaders?: (headers: Headers) => void;
}

/** Terminal return value. */
export interface QueryTerminal {
  reason: "completed" | "aborted" | "error" | "max_turns" | "blocking_limit";
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
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
        // user message: split into text + tool result messages
        const textParts: string[] = [];
        for (const block of msg.content as ContentBlockAPI[]) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            // Flush text first
            if (textParts.length > 0) {
              result.push({ role: "user", content: textParts.join("\n") });
              textParts.length = 0;
            }
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
        if (textParts.length > 0) {
          result.push({ role: "user", content: textParts.join("\n") });
        }
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
    systemPrompt,
    model,
    tools,
    executeTool,
    signal,
    maxTurns = Infinity,
    maxOutputTokensOverride,
    thinkingConfig,
    onUsage,
    compactInstructions,
    extraHeaders,
    onResponseHeaders,
  } = params;
  let client = params.client;
  const refreshClient = params.refreshClient;

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
  const loopDetectorState = createLoopDetectorState();
  let thinkingOnlyRecoveryCount = 0;

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
    // Order: toolResultBudget → snip → microcompact → collapse → autoCompact

    let messagesForQuery = [...messages];

    // 1. Tool result budget
    messagesForQuery = applyToolResultBudget(messagesForQuery);

    // 2. Snip compact
    const snipResult = snipCompactIfNeeded(messagesForQuery);
    if (snipResult.messagesRemoved > 0) {
      messagesForQuery = snipResult.messages;
    }
    const snipTokensFreed = snipResult.tokensFreed;

    // 3. Microcompact
    const microResult = microcompact(messagesForQuery);
    if (microResult.clearedCount > 0) {
      messagesForQuery = microResult.messages;
    }

    // 4. Context collapse (stub for now)
    const collapseResult = applyCollapsesIfNeeded(messagesForQuery);
    messagesForQuery = collapseResult.messages;

    // 5. Auto-compact
    let tracking = autoCompactTracking;
    const compactFn: CompactFn = async (
      msgs: { role: string; content: any }[],
      _sysPrompt: string,
    ) => {
      // Side-call: use the same client to summarize
      const prompt = getCompactPrompt(compactInstructions);
      const compactMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: prompt },
        ...msgs.map(
          (m: any): OpenAI.ChatCompletionMessageParam => ({
            role: m.role as "user" | "assistant",
            content:
              typeof m.content === "string"
                ? m.content
                : (m.content as ContentBlockAPI[])
                    .filter((b) => b.type === "text")
                    .map((b) => (b as { type: "text"; text: string }).text)
                    .join("\n"),
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

    const autoResult = await autoCompact(
      messagesForQuery,
      systemPrompt,
      compactFn,
      tracking,
      snipTokensFreed,
    );

    if (autoResult.wasCompacted && autoResult.postCompactMessages) {
      yield {
        type: "compact_start",
        beforeTokens: autoResult.preCompactTokenCount ?? 0,
      };
      messagesForQuery = autoResult.postCompactMessages;
      resetContextCollapse();
      tracking = {
        compacted: true,
        turnId: generateId(),
        turnCounter: 0,
        consecutiveFailures: 0,
      };
      yield {
        type: "compact_end",
        beforeTokens: autoResult.preCompactTokenCount ?? 0,
        afterTokens: autoResult.postCompactTokenCount ?? 0,
      };
    } else if (autoResult.consecutiveFailures !== undefined) {
      tracking = {
        ...(tracking ?? { compacted: false, turnId: "", turnCounter: 0 }),
        consecutiveFailures: autoResult.consecutiveFailures,
      };
    }

    // Filter incomplete tool calls (orphaned tool_use without tool_result)
    messagesForQuery = filterIncompleteToolCalls(messagesForQuery);

    // Ensure message alternation: Anthropic requires user/assistant/user/...
    // NOTE: This synthetic assistant message was removed — it caused the model
    // to see 'Understood. What would you like me to do next?' as its own prior
    // response and loop on it instead of actually executing tools. OpenAI-
    // compatible APIs (used by TM Code) do NOT require strict alternation;
    // the toOpenAIMessages() converter already handles tool_results correctly.
    // If a future provider requires alternation, fix it at the API boundary
    // (toOpenAIMessages) instead of injecting fake messages into state.

    // ── Build API request (convert internal format → OpenAI) ──

    const maxTokens = maxOutputTokensOverride ?? MAX_OUTPUT_TOKENS;
    const apiMessages = toOpenAIMessages(messagesForQuery, systemPrompt, model);

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
    let turnUsage: OpenAI.CompletionUsage | undefined;

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

    // Retry the same model turn only before any assistant output/tool call has
    // been emitted. Retrying after visible output could duplicate text or tools.
    // eslint-disable-next-line no-constant-condition
    while (true) {
    try {
      const streamParams: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: apiMessages,
        stream: true,
      };

      if (tools.length > 0) {
        streamParams.tools = tools;
      }

      if (thinkingConfig) {
        Object.assign(streamParams, thinkingConfig);
      }

      const responsePromise = client.chat.completions.create(
        {
          ...streamParams,
          stream: true,
        } as any,
        { signal, headers: extraHeaders },
      );
      const { data: stream, response } =
        typeof (responsePromise as any).withResponse === "function"
          ? await (responsePromise as any).withResponse()
          : { data: await responsePromise, response: null };
      if (response?.headers) {
        onResponseHeaders?.(response.headers);
      }

      // Process OpenAI stream chunks
      for await (const chunk of stream as any) {
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

        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Debug: log first chunks to see reasoning_content vs content structure
        if (!delta) continue;

        // Reasoning/thinking content (OpenAI-compatible format)
        // MiniMax M3: reasoning_details field when reasoning_split=True
        // Other models: reasoning_content field
        if (delta?.reasoning_content) {
          const reasoning = delta.reasoning_content;
          assistantThinkingParts.push(reasoning);
          nativeAccumulator.reasoningContent += reasoning;
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
          for (const tc of delta.tool_calls) {
            let pending = pendingToolCalls.get(tc.index);
            if (!pending) {
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

        // Usage
        if (chunk.usage) {
          turnUsage = chunk.usage;
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
      break;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const outputStarted = hasStartedModelOutput({
        textParts: assistantTextParts,
        thinkingParts: assistantThinkingParts,
        toolCalls: collectedToolCalls,
        pendingToolCalls,
      });

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

      // ── Collapse recovery on prompt_too_long ──
      const MAX_COLLAPSE_RECOVERY = 3;
      const isPromptTooLong =
        /prompt_too_long|prompt is too long|context_length_exceeded/i.test(
          errMsg,
        );

      if (
        isPromptTooLong &&
        state.collapseRecoveryAttempts < MAX_COLLAPSE_RECOVERY
      ) {
        withholdPromptTooLong();
        const recovery = recoverFromOverflow(messagesForQuery);
        if (recovery.committed > 0) {
          state = {
            ...state,
            messages: recovery.messages as QueryMessage[],
            collapseRecoveryAttempts: state.collapseRecoveryAttempts + 1,
          };
          continue queryLoop;
        }
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
    }
    }

    // ── Record usage ──

    if (turnUsage) {
      totalInputTokens += turnUsage.prompt_tokens;
      totalOutputTokens += turnUsage.completion_tokens;
      onUsage?.(turnUsage.prompt_tokens, turnUsage.completion_tokens);
    }

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

      // No tool calls — check for max_tokens continuation
      if (
        stopReason === "max_tokens" &&
        maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
      ) {
        state = {
          ...state,
          messages: [
            ...updatedMessages,
            {
              role: "user",
              content:
                "Output token limit hit. Resume directly — no apology, no recap. Break remaining work into smaller pieces.",
            },
          ],
          maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
          continuationCount: 0,
        };
        continue;
      }

      // Model is done — return terminal
      state.messages = updatedMessages;
      return {
        reason: "completed",
        turnCount: state.turnCount,
        totalInputTokens,
        totalOutputTokens,
      };
    }

    // Tool calls mean the model is making observable progress; reset loop guards.
    resetLoopDetector(loopDetectorState);
    thinkingOnlyRecoveryCount = 0;

    // ── Execute tools ──

    const toolResultBlocks: ContentBlockAPI[] = [];

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

      try {
        const result = await executeTool(tc.name, toolInput, tc.id, signal);
        yield {
          type: "tool_result",
          toolUseId: tc.id,
          content: result.content,
          isError: result.isError,
        };
        toolResultBlocks.push({
          type: "tool_result",
          toolCallId: tc.id,
          content: result.content,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
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
        });
      }
    }

    // Add tool results as a user message
    const toolResultMessage: QueryMessage = {
      role: "user",
      content: toolResultBlocks,
    };

    // ── Update state for next iteration ──

    state = {
      messages: [...updatedMessages, toolResultMessage],
      autoCompactTracking: tracking,
      maxOutputTokensRecoveryCount: 0,
      continuationCount: 0,
      turnCount: state.turnCount,
      collapseRecoveryAttempts: state.collapseRecoveryAttempts,
    };
  } // while (true)
}
