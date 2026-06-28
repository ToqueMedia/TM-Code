/**
 * AgentService — thin facade orchestrating the agent loop via QueryEngine.
 *
 * Architecture (post-refactor):
 *   - QueryEngine + query.ts async generator handle the core agent loop
 *     using OpenAI SDK native streaming
 *   - AgentService bridges QueryEngine events to the existing AgentCallbacks
 *     interface so all callers (agentRunner, usePromptBar, subAgentRunner,
 *     commands/*) continue working without changes
 *   - Tool execution goes through ToolExecutor with inline diff approval
 *
 * Public API is backward-compatible — external callers need no changes.
 */

import ToolExecutor, { type OpenAIToolDefinition } from "./toolExecutor";
import { t } from "../../i18n";
import FirebaseAuthService from "../auth/firebaseAuth";
import { ServiceError, formatError } from "../../utils/errors";
import { MODEL_PROFILES, getProfileForPlan } from "./modelProfiles";
import {
  createDiffApprovalPromise,
  generateId,
  resolveAllPendingDiffApprovals,
  useChatStore,
} from "../../stores/chatStore";
import { useBillingStore } from "../../stores/billingStore";
import { useAgentStore } from "../../stores/agentStore";
import { useTmSpeedStore } from "../../stores/tmSpeedStore";
import { invoke } from "@/utils/invokeMetrics";
import { logger } from "../../utils/logger";
import { FALLBACK_CONTEXT_WINDOW } from "../../utils/contextWindow";
import { getQueryGuard } from "./queryGuard";
import type { ContentPart, ByokSessionSnapshot } from "../../types/chat";

// ── Query engine ──

import type OpenAI from "openai";
import { createAgentClient, createSubAgentClient } from "./sdkClient";
import { useByokStore } from "../../stores/byokStore";
import { buildByokClientFromSnapshot, buildByokThinkingConfig } from "./byokRouting";
import { contentAsText } from "./promptValueHelpers";
import { QueryEngine, toQueryMessages } from "./queryEngine";
import { ToolsetSelector, REQUEST_TOOLS_NAME, REQUEST_CONTEXT_NAME } from "./toolsetSelector";
import type { QueryStreamEvent, QueryTerminal, ToolExecutorFn } from "./query";

// ── Extracted services ──

import { SessionState } from "./sessionState";
import {
  checkForLoop,
  createLoopDetectorState,
  type LoopDetectorState,
} from "./loopDetector";
import {
  autoSaveSessionMemory,
  mechanicalFallback,
  buildInternalMessagesFromSession,
} from "./contextManager";
import { DEFAULT_CONTEXT_WINDOW } from "./agentConfig";

// ── Re-exports for backward compatibility ──

export type {
  OpenAIContentPart,
  AgentCallbacks,
  LightweightAgentOptions,
} from "./types";
export type { ContentBlockAPI } from "../../types/chat";

import type { ContentBlockAPI } from "../../types/chat";
import type { AgentCallbacks, LightweightAgentOptions } from "./types";
import type { InternalMessage } from "./messageUtils";

// ── AgentService ──

class AgentService {
  private static instance: AgentService;

  private abortController: AbortController | null = null;
  private isRunning = false;
  private toolExecutor: ToolExecutor;
  private tools: OpenAIToolDefinition[];
  private agentType: string | null = null;
  private systemPrompt: string = "";
  // X-Request-Type header value sent with every API call. Sticky across turns
  // until the caller clears it (e.g. plan/debug/e2e/review commands set it
  // on entry and clear it on exit). Null means "omit the header".
  private requestType: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars

  private lightweightOptions: LightweightAgentOptions | null = null;
  private queryEngine: QueryEngine | null = null;
  // Dynamic toolset selector for the current run. Null for sub-agents
  // (lightweight) which use their own restricted tool set. Set per run in
  // runQueryEngineLoop; the createToolExecutorBridge reads it to intercept
  // the request_tools meta-tool.
  private currentToolsetSelector: ToolsetSelector | null = null;

  // Última resposta HTTP confirmou TM Speed (`X-TM-Speed-Applied: true`)?
  // Os headers chegam no início de cada resposta e o `message_stop` desse
  // mesmo turno chega depois (sequencial), por isso um campo simples por
  // resposta é suficiente para parear turno ↔ multiplicador de cobrança.
  // Só é atualizado em runs não-lightweight (lightweight não envia o header
  // X-TM-Speed nem liga onResponseHeaders) e é reposto no início de cada run.
  private lastResponseSpeedApplied = false;

  // ── BYOK direct-routing state (set per run in runQueryEngineLoop) ──
  // When byokActive, the run routes IDE → SDK → provider DIRECT (bypassing the
  // TM worker): resolveModel returns the BYOK model id, buildThinkingConfig
  // sends the provider-native thinking field, buildExtraHeaders drops the
  // worker-only headers, and the compact helpers use the BYOK client too.
  private byokActive = false;
  private byokSnapshot: ByokSessionSnapshot | null = null;

  // ── Delegated state ──
  private sessionState: SessionState;
  private loopState: LoopDetectorState = createLoopDetectorState();

  private constructor(options?: LightweightAgentOptions) {
    this.toolExecutor = ToolExecutor.getInstance();
    this.sessionState = new SessionState(DEFAULT_CONTEXT_WINDOW);

    if (options) {
      this.lightweightOptions = options;
      this.tools = options.tools || this.toolExecutor.getToolDefinitions();
      if (options.abortController)
        this.abortController = options.abortController;
    } else {
      this.tools = this.toolExecutor.getToolDefinitions();
    }
  }

  // ── Singleton ──

  static getInstance(): AgentService {
    if (!AgentService.instance) AgentService.instance = new AgentService();
    return AgentService.instance;
  }

  static createLightweight(options: LightweightAgentOptions): AgentService {
    return new AgentService(options);
  }

  // ── Configuration setters ──

  setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
  }
  getAgentType(): string | null {
    return this.agentType;
  }
  setAgentType(type: string | null) {
    this.agentType = type;
  }
  /**
   * Set the X-Request-Type header value for subsequent API calls. Sticky
   * across turns — call with `null` to clear. Used by /plan, /debug, /e2e,
   * /review to route the backend to a specialised model/prompt pipeline.
   */
  setRequestType(type: string | null) {
    this.requestType = type;
  }
  getRequestType(): string | null {
    return this.requestType;
  }

  isThinkingRequestedForNextTurn(): boolean {
    try {
      const plan = useBillingStore.getState().plan;
      const modelName = useAgentStore.getState().modelName;
      const profile =
        modelName && MODEL_PROFILES[modelName]
          ? MODEL_PROFILES[modelName]
          : getProfileForPlan(plan);
      return profile.supportsThinking === true;
    } catch {
      return false;
    }
  }

  refreshTools(): void {
    this.tools = this.toolExecutor.getToolDefinitions();
  }
  isAgentRunning(): boolean {
    return this.isRunning;
  }
  getAccessedFilePaths(): string[] {
    return this.sessionState.getAccessedFilePaths();
  }
  getAbortController(): AbortController | null {
    return this.abortController;
  }
  isAborted(): boolean {
    return this.abortController?.signal.aborted === true;
  }

  /** Expose the current QueryEngine (used by sub-agent runner for forking). */
  getQueryEngine(): QueryEngine | null {
    return this.queryEngine;
  }

  // ── Cancel ──

  cancelLoop(): void {
    // Cancel the query engine if active
    if (this.queryEngine) {
      this.queryEngine.cancel();
      this.queryEngine = null;
    }
    if (this.abortController) this.abortController.abort();
    if (!this.lightweightOptions) {
      useAgentStore.getState().setWorkerStatus(null);
    }
    resolveAllPendingDiffApprovals(false);
    import("../../stores/permissionStore")
      .then((m) => {
        // RACE FIX (2026-06-11): cancelar o loop tem de resolver + limpar o
        // prompt de permissão pendente E a fila. Sem isto, o stop do CMD
        // mode (stopAgent → cancelLoop) deixava o diálogo no ecrã; um
        // "Aprovar" tardio resolvia a Promise e a tool EXECUTAVA num run já
        // morto (escrita de ficheiro/comando com a UI em idle). O chat mode
        // já chamava clearPending no seu handleStop — isto centraliza para
        // todos os caminhos de cancelamento (stop, switch de projeto, erro).
        m.usePermissionStore.getState().clearPending();
        m.usePermissionStore.getState().resetAutoApprove();
      })
      .catch(() => {});
    import("../../stores/credentialRequestStore")
      .then((m) => m.useCredentialRequestStore.getState().clearAll())
      .catch(() => {});
    import("../../stores/askUserQuestionStore")
      .then((m) => m.useAskUserQuestionStore.getState().clearAll())
      .catch(() => {});
    import("../../stores/backgroundCommandStore")
      .then(async (m) => {
        const store = m.useBackgroundCommandStore.getState();
        const running = store.getAll().filter((c) => c.status === "running");
        for (const cmd of running) {
          try {
            await invoke("kill_process", { pid: cmd.pid });
          } catch {
            /* best effort */
          }
          store.cancelCommand(cmd.id);
        }
      })
      .catch(() => {});
    this.isRunning = false;
    if (!this.lightweightOptions) {
      getQueryGuard().forceEnd();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("agent-stop-requested"));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // runAgentLoop — the main orchestration method
  // ══════════════════════════════════════════════════════════════

  async runAgentLoop(
    userMessage: string | ContentPart[],
    conversationHistory: Array<{
      role: string;
      content: string | ContentBlockAPI[] | null;
    }>,
    callbacks: AgentCallbacks,
  ): Promise<void> {
    if (this.isRunning && !this.lightweightOptions) this.cancelLoop();
    this.isRunning = true;
    if (!this.lightweightOptions) {
      useAgentStore.getState().setWorkerStatus(null);
    }

    let myGeneration: number | null = null;
    if (!this.lightweightOptions) {
      this.abortController = new AbortController();
      myGeneration = getQueryGuard().tryStart();
      if (myGeneration === null) {
        logger.warn(
          "agent",
          "tryStart() returned null — concurrent runAgentLoop detected",
        );
        this.isRunning = false;
        useChatStore
          .getState()
          .addSystemMessage(t("chat.concurrencyGuard"), "warn", {
            ephemeral: true,
            timeoutMs: 8000,
          });
        return;
      }
    } else if (!this.abortController) {
      this.abortController = new AbortController();
    }

    // Reset state for new message
    this.sessionState.resetForNewMessage();

    // New session init
    if (!this.lightweightOptions) {
      try {
        const { markTurnStart } = await import("./memoryWriteTracker");
        const sessionId = useChatStore.getState().activeSessionId;
        if (sessionId) markTurnStart(sessionId);
      } catch {
        /* non-critical */
      }
    }

    const isMainAgentNewSession =
      !this.lightweightOptions && conversationHistory.length === 0;
    if (conversationHistory.length === 0) {
      try {
        useAgentStore.getState().clearTasks();
      } catch {
        /* non-critical */
      }
      this.sessionState.resetForNewSession();
      this.toolExecutor.resetSessionState();
    } else if (!this.lightweightOptions) {
      // ── State recovery from conversation history ───────────────────
      // When resuming an existing session, the ToolExecutor's read state
      // may be empty (fresh process) or stale (compact removed old turns).
      // Rebuild it from the conversation history so read-before-write
      // enforcement and dedup work correctly. Mirrors claude-vaz's
      // `extractReadFilesFromMessages` (queryHelpers.ts:346-501).
      try {
        this.toolExecutor.rebuildReadStateFromHistory(
          conversationHistory as Parameters<
            typeof this.toolExecutor.rebuildReadStateFromHistory
          >[0],
          async (p: string) => {
            const { invoke: inv } = await import("@/utils/invokeMetrics");
            return inv<string>("read_file", { path: p });
          },
        );
      } catch {
        /* non-critical — best-effort state recovery */
      }
    }
    if (isMainAgentNewSession) {
      try {
        useAgentStore.getState().resetPoolConflictsAvoided();
        useAgentStore.getState().resetToolCallCounters();
      } catch {
        /* non-critical */
      }
    }

    // Init context window from profile
    if (!this.lightweightOptions) {
      try {
        const { getProfileForPlan: gp, MODEL_PROFILES: MP } =
          await import("./modelProfiles");
        const plan = useBillingStore.getState().plan;
        const modelName = useAgentStore.getState().modelName;
        const profile = modelName && MP[modelName] ? MP[modelName] : gp(plan);
        this.sessionState.setContextWindowSize(profile.contextWindow);
        const storeCtx = useAgentStore.getState().modelContextWindow;
        if (storeCtx && storeCtx > 0)
          this.sessionState.setContextWindowSize(storeCtx);
      } catch {
        /* keep default */
      }
    }

    try {
      await this.runQueryEngineLoop(
        userMessage,
        conversationHistory,
        callbacks,
      );
    } catch (error) {
      if (this.abortController?.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ServiceError) callbacks.onError(error);
      else
        callbacks.onError(
          new ServiceError(
            error instanceof Error ? error.message : String(error),
            "UNKNOWN_ERROR",
            false,
          ),
        );
    } finally {
      this.isRunning = false;
      this.queryEngine = null;
      if (!this.lightweightOptions) {
        useAgentStore.getState().setWorkerStatus(null);
      }
      if (!this.lightweightOptions && myGeneration !== null)
        getQueryGuard().end(myGeneration);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // QueryEngine loop — replaces the old imperative loop
  // ══════════════════════════════════════════════════════════════

  private async runQueryEngineLoop(
    userMessage: string | ContentPart[],
    conversationHistory: Array<{
      role: string;
      content: string | ContentBlockAPI[] | null;
    }>,
    callbacks: AgentCallbacks,
  ): Promise<void> {
    // 1. Auth
    const authToken = await FirebaseAuthService.getInstance().getIdToken();
    if (!authToken) {
      callbacks.onError(
        new ServiceError(t("chat.authExpired"), "AUTH_EXPIRED", false),
      );
      return;
    }

    // 2. Create SDK client — BYOK routes IDE → provider DIRECT; managed routes
    //    through the TM worker. The active session's frozen BYOK snapshot wins
    //    so switching the active provider mid-conversation only affects new
    //    sessions.
    const activeSession = useChatStore.getState().getActiveSession();
    const snapshot = activeSession?.byokSnapshot ?? null;
    const byokActive = !!snapshot && useByokStore.getState().enabled;
    this.byokActive = byokActive;
    this.byokSnapshot = snapshot;

    let client: OpenAI;
    let refreshClient: () => Promise<OpenAI | null>;
    if (byokActive && snapshot) {
      const byokClient = await this.buildByokClient(snapshot, callbacks);
      if (!byokClient) return; // key missing for a cloud provider — error surfaced
      client = byokClient;
      // The BYOK key is static (no JWT to refresh); rebuild from the snapshot so
      // a user who fixes a bad key mid-session recovers on the next turn.
      refreshClient = async () => this.buildByokClient(snapshot, callbacks);
      // No X-Model-* headers exist under BYOK (the worker is bypassed) — seed
      // model info from the snapshot so the context pill, thinking toggle and
      // auto-compact have real values.
      if (!this.lightweightOptions) this.seedByokModelInfo(snapshot);
    } else {
      client = this.lightweightOptions
        ? createSubAgentClient(authToken)
        : createAgentClient(authToken);
      refreshClient = async (): Promise<OpenAI | null> => {
        const auth = FirebaseAuthService.getInstance();
        const refreshed = await auth.getIdToken(true)
          ?? (await auth.refreshLogin() ? await auth.getIdToken(true) : null);
        if (!refreshed) return null;
        return this.lightweightOptions
          ? createSubAgentClient(refreshed)
          : createAgentClient(refreshed);
      };
      // Managed run — clear any sticky BYOK marker left by a prior BYOK session
      // (the worker never emits X-BYOK-Active, so nothing else resets it).
      if (!this.lightweightOptions) useAgentStore.getState().setByokActive(false);
    }

    // 3. Build tool definitions in OpenAI format
    // web_search NUNCA vai no schema: modelos com pesquisa nativa
    // (supportsSearch, ex.: qwen3.7-max-2026-06-08) pesquisam SERVER-SIDE
    // via extraBody.enable_search injetado pelo worker — expor uma function
    // tool convidaria o modelo a chamá-la em vez de usar a capacidade
    // nativa. E o execute local desta tool aponta para o /v1/messages do
    // proxy ANTIGO (removido) — reativá-la seria um erro garantido.
    const filteredTools = this.tools.filter((t) => {
      if (t.function.name === "web_search") return false;
      return true;
    });
    const openaiTools: OpenAI.ChatCompletionTool[] = filteredTools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
      },
    }));

    // 4. Build thinking config
    const thinkingConfig = this.buildThinkingConfig();

    // 4.5. Dynamic toolset selector — starts with a CORE minimal toolset and
    // expands monotonically based on user-message keywords + the request_tools
    // meta-tool. Reduces tool-schema overhead (~10K tokens for 36 tools) to
    // the few the current task needs. Sub-agents (lightweight) skip selection
    // Wire auxiliary-context omissions + the Intent Router's profile/readOnly
    // into the selector. The selection was computed during buildSystemPrompt
    // (stored on the ContextBuilder singleton) — the profile + readOnly come
    // from the Intent Router (qwen3.7-plus) via the agentRunner call. We read
    // it BEFORE constructing the selector so the constructor can seed the
    // active set with the profile's base toolset (bugfix_local/analysis_readonly/…)
    // and bound request_tools/keywords to the profile's allowed set. Sub-agents
    // skip this (they already receive a restricted tool set from the subAgentRunner).
    let auxiliarySelection: import('./contextBuilder/auxiliaryRegistry').AuxiliarySelection | null = null;
    if (!this.lightweightOptions) {
      const ContextBuilder = (await import('./contextBuilder')).default;
      auxiliarySelection = ContextBuilder.getInstance().getLastAuxiliarySelection();
    }

    const toolsetSelector = this.lightweightOptions
      ? null
      : new ToolsetSelector(
          openaiTools.map((t) => t.function.name),
          auxiliarySelection?.profile ?? 'bugfix_local',
          auxiliarySelection?.readOnly ?? false,
        );
    this.currentToolsetSelector = toolsetSelector;

    if (toolsetSelector && auxiliarySelection) {
      toolsetSelector.setOmittedAuxiliaries(auxiliarySelection.omitted.length);
      toolsetSelector.setOmittedAuxiliaryIds(auxiliarySelection.omitted.map((o) => o.id));
    }

    // 5. Create tool executor bridge
    const executeTool = this.createToolExecutorBridge(callbacks);

    // 6. Build extra headers — X-Request-Type is sticky across turns
    const extraHeaders = this.buildExtraHeaders();

    // Reset por run: evita que um run anterior servido em speed "vaze" o
    // multiplicador para o primeiro turno deste run antes dos headers chegarem.
    this.lastResponseSpeedApplied = false;

    // 7. Create QueryEngine
    const engine = new QueryEngine({
      client,
      refreshClient,
      model: this.resolveModel(),
      systemPrompt: this.systemPrompt,
      tools: openaiTools,
      executeTool,
      thinkingConfig,
      maxTurns: this.lightweightOptions?.maxTurns,
      extraHeaders,
      onResponseHeaders: this.lightweightOptions
        ? undefined
        : (headers) => this.applyStreamingResponseHeaders(headers),
      // External-modification sweep between tool rounds (claude-vaz parity —
      // its query loop runs getAttachmentMessages after every tool batch).
      // Main agent only: the ToolExecutor read state is a shared singleton,
      // and a sub-agent draining the sweep would steal the notification from
      // the main conversation.
      collectInterTurnContext: this.lightweightOptions
        ? undefined
        : async () => {
            const { collectChangedFileContext } = await import("./atMentions");
            return collectChangedFileContext();
          },
      // Queued-message steering (claude-vaz parity). Main agent only: a
      // sub-agent must never drain the developer's queued messages — those
      // belong to the main conversation. The host (agentRunner) owns the
      // drain + transcript bookkeeping; we just bridge it into the loop.
      collectQueuedSteering: this.lightweightOptions
        ? undefined
        : callbacks.collectSteeringMessages
          ? () => callbacks.collectSteeringMessages!()
          : undefined,
      // Live active-model limits for auto-compact. modelContextWindow is the
      // real window learned from the response headers (X-Model-Context-Window);
      // MODEL_PROFILES is the fallback and the source of maxOutputTokens. Read
      // fresh each iteration because the active model is injected server-side
      // and only known after the first response.
      getContextLimits: () => {
        const { modelContextWindow, modelName } = useAgentStore.getState();
        // Resolve the window EXACTLY like the UI pill (ContextWindowIndicator /
        // TerminalStatusLine): server header → known profile → conservative
        // FALLBACK_CONTEXT_WINDOW (200K). Unknown model (no header, not in
        // MODEL_PROFILES) assumes 200K — NOT the plan profile's 1M — so a small
        // or unknown model compacts early instead of overflowing; the admin
        // publishes the real window via Settings → Admin to override it.
        const knownProfile = modelName ? MODEL_PROFILES[modelName] : undefined;
        const plan = useBillingStore.getState().plan;
        const profile = knownProfile ?? getProfileForPlan(plan);
        // The ADMIN-published window (modelContextWindow, from X-Model-Context-
        // Window) is authoritative for auto-compact AND the blocking limit (both
        // read this in query.ts). Never capped here — a 1M model compacts at ~1M,
        // a 256K model at ~256K. The admin tunes it in Settings → Admin.
        return {
          contextWindow: modelContextWindow ?? knownProfile?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
          maxOutputTokens: profile.maxOutputTokens ?? null,
        };
      },
      // Usage is reported via message_stop events — do NOT add onUsage
      // callback here or output tokens will be double-counted (SUM semantics).
      // onRequestUsage is distinct: it carries the payloadInspector breakdown
      // (not in message_stop) — pure observability, no double-counting.
      onRequestUsage: (entry) => callbacks.onRequestUsage?.(entry),
      // Dynamic toolset selector (null for sub-agents).
      toolsetSelector: toolsetSelector ?? undefined,
      // Auxiliary-context selection (core/auxiliary breakdown for the
      // payloadInspector; null for sub-agents).
      auxiliarySelection: auxiliarySelection ?? undefined,
    });
    this.queryEngine = engine;

    // 7. Convert conversation history
    const history = toQueryMessages(conversationHistory);

    // 8. Iterate the query engine's async generator
    let finalText = "";
    let turnNumber = 0;
    const toolNameCache = new Map<string, string>();
    const clearWorkerStatus = () => {
      if (!this.lightweightOptions) {
        useAgentStore.getState().setWorkerStatus(null);
      }
    };

    const generator = engine.submitMessage(
      userMessage as string | ContentBlockAPI[],
      history,
    );

    let result = await generator.next();
    while (!result.done) {
      const event = result.value as QueryStreamEvent;

      // Map QueryStreamEvent → AgentCallbacks
      switch (event.type) {
        case "text_delta":
          clearWorkerStatus();
          callbacks.onTextDelta(event.text);
          finalText += event.text;
          break;

        case "thinking_delta":
          clearWorkerStatus();
          callbacks.onReasoningDelta(event.thinking);
          break;

        case "tool_use_start":
          clearWorkerStatus();
          toolNameCache.set(event.id, event.name);
          // Announcement (onToolCallPending → the "Em fila" card) is DEFERRED
          // to the executeTool bridge, which fires as the serial loop reaches
          // each tool. Announcing here — eagerly, for every tool call the model
          // streamed — rendered the whole batch up-front, so when tool #1 hit a
          // permission gate the queued siblings stacked up and pushed the
          // authorization prompt out of view. With the announcement at
          // execution time, only the tool actually being run (and gated) is
          // shown; nothing behind it appears until the user authorizes.
          break;

        case "tool_use_delta": {
          // Accumulate args JSON — parse on tool_use_stop
          break;
        }

        case "tool_use_stop": {
          // Parse accumulated args from the stream
          // The query.ts loop will call executeTool next, which handles the rest
          break;
        }

        case "tool_result":
          clearWorkerStatus();
          callbacks.onToolResult(
            event.toolUseId,
            toolNameCache.get(event.toolUseId) ?? "",
            event.content,
            event.isError,
          );
          break;

        case "message_start":
          break;

        case "message_stop":
          clearWorkerStatus();
          turnNumber++;
          this.sessionState.setLastAssistantMessageAt(Date.now());
          if (event.usage) {
            // Coerce to 0 — partial-usage providers (DashScope GLM,
            // OpenRouter MiMo, …) can send `prompt_tokens` WITHOUT
            // `completion_tokens` (or vice-versa). The TS type says both are
            // required numbers, but at runtime either can be undefined, which
            // crashed `outputTokens.toLocaleString()` in agentRunner's
            // onUsageUpdate ("undefined is not an object").
            this.sessionState.setLastPromptTokens(event.usage.prompt_tokens ?? 0);
            callbacks.onUsageUpdate(
              event.usage.prompt_tokens ?? 0,
              event.usage.completion_tokens ?? 0,
              !this.lightweightOptions && this.lastResponseSpeedApplied,
            );
          }
          callbacks.onTurnComplete(turnNumber, event.providerState);
          break;

        case "compact_start":
          callbacks.onContextCompression?.({
            type: "compact_start",
            beforeTokens: event.beforeTokens,
            trigger: "auto",
          });
          break;

        case "compact_end":
          callbacks.onContextCompression?.({
            type: "compact_end",
            beforeTokens: event.beforeTokens,
            trigger: "auto",
            messagesSummarized: 0,
            summary: event.summary,
          });
          break;

        case "agent_status":
          if (!this.lightweightOptions) {
            useAgentStore.getState().setWorkerStatus(event.message);
          }
          break;

        case "error":
          clearWorkerStatus();
          callbacks.onError(
            new ServiceError(event.message, "QUERY_ERROR", false),
          );
          break;

        case "interrupted":
          clearWorkerStatus();
          break;
      }

      result = await generator.next();
    }

    // 9. Terminal result
    const terminal = result.value as QueryTerminal;

    // Loop detection on final text
    if (finalText && !this.lightweightOptions) {
      const loopResult = checkForLoop(finalText, this.loopState);
      if (loopResult.isLoop) {
        callbacks.onDone(finalText + "\n\n⚠️ [Loop detected and stopped]");
        return;
      }
    }

    // Post-turn memory extraction
    if (!this.lightweightOptions && typeof userMessage === "string") {
      void this.runMemoryExtractor(userMessage, finalText).catch(() => {});
    }

    if (terminal.reason === "error") {
      // Error already reported via event
      return;
    }

    callbacks.onDone(finalText);
  }

  // ══════════════════════════════════════════════════════════════
  // Private helpers
  // ══════════════════════════════════════════════════════════════

  /**
   * Resolve the placeholder model ID sent to the AI data-plane Worker.
   * The Worker always replaces this with the active Control Plane model.
   */
  private resolveModel(): string {
    // Under BYOK the IDE talks to the provider directly, so the real model id
    // must go on the wire. Managed routing keeps the placeholder the worker
    // maps to its active KV config.
    if (this.byokActive && this.byokSnapshot) return this.byokSnapshot.modelId;
    return "tm-active-model";
  }

  /**
   * Build the BYOK direct client for a session snapshot. Reads the user's key
   * from the OS keychain just-in-time. Cloud providers without a key surface a
   * BYOK_KEY_MISSING error (when callbacks are provided) and return null; local
   * providers route without auth. Returns null on any failure so callers fall
   * back gracefully (the main loop aborts the run; compact returns unchanged).
   */
  private async buildByokClient(
    snapshot: ByokSessionSnapshot,
    callbacks?: AgentCallbacks,
  ): Promise<OpenAI | null> {
    return buildByokClientFromSnapshot(snapshot, {
      lightweight: !!this.lightweightOptions,
      onKeyMissing: () =>
        callbacks?.onError(
          new ServiceError(
            `BYOK: no API key set for "${snapshot.providerId}". Add it in Settings → API Keys.`,
            "BYOK_KEY_MISSING",
            false,
          ),
        ),
    });
  }

  /**
   * Seed agentStore model info from the BYOK snapshot. Replaces the X-Model-*
   * response-header path (absent under BYOK) so the context-window pill, the
   * thinking toggle and the auto-compact limit reflect the user's model.
   */
  private seedByokModelInfo(snapshot: ByokSessionSnapshot): void {
    const supportsThinking = snapshot.supportsThinking === true;
    const thinkingMode = supportsThinking ? "toggleable" : "none";
    const cw =
      snapshot.contextWindow && snapshot.contextWindow > 0
        ? snapshot.contextWindow
        : undefined;
    useAgentStore
      .getState()
      .setModelInfo(snapshot.modelId, snapshot.providerId, thinkingMode, cw);
    useAgentStore.getState().setByokActive(true);
    if (cw) this.sessionState.setContextWindowSize(cw);
  }

  /**
   * Streaming responses expose safe metadata in HTTP headers. The AI
   * pass-through Worker emits X-Plan / X-Budget-* on every response (estado
   * de billing pré-voo — o worker é o único ponto de contabilidade); nada é
   * injetado no corpo do stream. Headers ausentes continuam tolerados (BYOK
   * bypassa o worker; BUDGET_ENFORCEMENT=off desliga o billing).
   */
  private applyStreamingResponseHeaders(headers: Headers): void {
    // Atualizado a CADA resposta (ausência do header ⇒ false), nunca latched —
    // o admin pode despublicar o speedModel a meio de um run e os turnos
    // seguintes devem voltar a cobrar 1x.
    this.lastResponseSpeedApplied =
      headers.get("X-TM-Speed-Applied") === "true";
    try {
      useTmSpeedStore.getState().setApplied(this.lastResponseSpeedApplied);
      // Id do modelo ativo (ex.: "mimo-v2.5-pro") — alimenta o gate de
      // visibilidade do /speed por modelo (tmSpeedStore.isSpeedModelEligible).
      const activeModel = headers.get("X-TM-Model");
      if (activeModel) {
        useTmSpeedStore.getState().setActiveModelId(activeModel);
      }
      // Always surface WHICH model + config actually served this response. The
      // worker injects the model server-side, so this is the only place the
      // client learns it. `config` = `active` for the main model, or `sidecar:*`
      // when a sidecar served (vision/web_search/utility/fim).
      logger.info(
        "model",
        `served: model=${activeModel ?? "?"} provider=${headers.get("X-TM-Provider") ?? "?"} ` +
          `config=${headers.get("X-TM-Config-Key") ?? "?"} teamByok=${headers.get("X-TM-Team-Byok") ?? "?"} ` +
          `speed=${this.lastResponseSpeedApplied}`,
      );
    } catch {
      /* non-critical */
    }

    try {
      useBillingStore.getState().updateFromHeaders(headers);
    } catch {
      /* non-critical */
    }

    try {
      // O data-plane atual envia X-TM-Model/X-TM-Provider (id do modelo da
      // config ativa); X-Model-Name/X-Model-Provider eram do gateway antigo.
      // O fallback liga o lookup de MODEL_PROFILES (context window, filtro
      // do web_search por supportsSearch) ao worker real.
      const modelName = headers.get("X-Model-Name") ?? headers.get("X-TM-Model");
      const modelProvider = headers.get("X-Model-Provider") ?? headers.get("X-TM-Provider");
      const thinkingModeRaw = headers.get("X-Model-Thinking-Mode");
      const contextWindowRaw = headers.get("X-Model-Context-Window");
      const byokActiveRaw = headers.get("X-BYOK-Active");
      // Team BYOK: the worker served this via the team's own provider/key
      // (config team:{teamId}). Emitted as true/false every response so a later
      // managed-path turn clears the indicator.
      const teamByokRaw = headers.get("X-TM-Team-Byok");

      const hasModelInfo =
        modelName !== null ||
        modelProvider !== null ||
        thinkingModeRaw !== null ||
        contextWindowRaw !== null;

      if (hasModelInfo) {
        const parsedContext =
          contextWindowRaw !== null ? Number.parseInt(contextWindowRaw, 10) : undefined;
        const contextWindow =
          parsedContext !== undefined && Number.isFinite(parsedContext) && parsedContext > 0
            ? parsedContext
            : contextWindowRaw !== null
              ? null
              : undefined;
        const thinkingMode =
          thinkingModeRaw === "none" ||
          thinkingModeRaw === "toggleable" ||
          thinkingModeRaw === "mandatory"
            ? thinkingModeRaw
            : thinkingModeRaw !== null
              ? null
              : undefined;

        useAgentStore.getState().setModelInfo(
          modelName,
          modelProvider,
          thinkingMode,
          contextWindow,
        );
        if (contextWindow && contextWindow > 0) {
          this.sessionState.setContextWindowSize(contextWindow);
        }
      }

      if (byokActiveRaw !== null) {
        useAgentStore.getState().setByokActive(byokActiveRaw.toLowerCase() === "true");
      }
      if (teamByokRaw !== null) {
        useAgentStore.getState().setTeamByokActive(teamByokRaw.toLowerCase() === "true");
      }
    } catch {
      /* non-critical */
    }
  }

  private buildExtraHeaders(): Record<string, string> | undefined {
    // BYOK talks to the provider directly — worker-contract headers
    // (X-Request-Type / X-TM-Speed) are meaningless there and some strict
    // OpenAI-compatible endpoints reject unknown headers. Auth goes via the
    // client's defaultHeaders, not here.
    if (this.byokActive) return undefined;
    const headers: Record<string, string> = {};
    if (this.requestType) headers["X-Request-Type"] = this.requestType;
    if (!this.lightweightOptions && useTmSpeedStore.getState().enabled) {
      headers["X-TM-Speed"] = "true";
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  /**
   * Thinking/reasoning config.
   *
   * MANAGED path: returns undefined. The TMS data plane is provider-agnostic
   * and the active model is a Control-Plane decision, so the IDE must not send
   * provider-specific thinking fields (enable_thinking / thinking / reasoning) —
   * strict OpenAI-compatible providers like Gemini reject them with 400.
   *
   * BYOK path: the IDE talks to the provider directly, so it MUST send the
   * provider-native field. We trust the baseURL host for the shape
   * (resolveThinkingHint — the host that actually receives the request is the
   * ground truth) and only emit when the catalog marks THIS model as a thinking
   * model (avoids enable_thinking 400s on non-reasoning Qwen SKUs). The
   * anthropic `thinking` object is translated to the Messages API by
   * anthropicAdapter. Default is thinking-ON for reasoning models (the user
   * picked one); a future toggle can flip this.
   */
  private buildThinkingConfig(): Record<string, unknown> | undefined {
    if (!this.byokActive || !this.byokSnapshot) return undefined;
    return buildByokThinkingConfig(this.byokSnapshot);
  }

  /**
   * Create the ToolExecutorFn bridge that connects the query loop's tool
   * execution to TM Code's ToolExecutor with diff approval support.
   */
  private createToolExecutorBridge(callbacks: AgentCallbacks): ToolExecutorFn {
    const WRITE_TOOLS = new Set(["write_file", "edit_file", "create_file"]);

    return async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolUseId: string,
      signal?: AbortSignal,
    ): Promise<{ content: string; isError: boolean }> => {
      // Intercept the request_tools meta-tool — it's not in the toolExecutor
      // registry. The agent calls it to ask for capabilities that aren't in the
      // current active toolset; we expand the selector so they're available on
      // the next turn. Never reaches the toolExecutor.
      if (toolName === REQUEST_TOOLS_NAME) {
        const requested = Array.isArray(toolInput.tools) ? (toolInput.tools as string[]) : [];
        const selector = this.currentToolsetSelector;
        if (!selector) {
          return {
            content: 'All tools are already available (no dynamic selection active).',
            isError: false,
          };
        }
        const result = selector.requestTools(requested);
        const parts: string[] = [];
        if (result.added.length) parts.push(`Activated for next turn: ${result.added.join(', ')}.`);
        if (result.alreadyActive.length) parts.push(`Already active: ${result.alreadyActive.join(', ')}.`);
        if (result.unknown.length) parts.push(`Unknown (not in registry): ${result.unknown.join(', ')}.`);
        if (result.denied.length) parts.push(`Denied (outside the current task profile — not available for this run): ${result.denied.join(', ')}.`);
        if (parts.length === 0) parts.push('No tools requested.');
        return { content: parts.join(' '), isError: false };
      }

      // Intercept the request_context meta-tool — fetches an auxiliary context
      // block that was omitted from the system prompt (publishing, scaffolding,
      // vision, auth/db — see auxiliaryRegistry). The content is returned as a
      // tool_result so the agent can use it this turn. Never reaches the
      // toolExecutor.
      if (toolName === REQUEST_CONTEXT_NAME) {
        const auxiliaryId = typeof toolInput.auxiliary === 'string' ? toolInput.auxiliary : '';
        if (!auxiliaryId) {
          return { content: 'No auxiliary id provided. Call request_context with an auxiliary id from the on-demand index.', isError: false };
        }
        const ContextBuilder = (await import('./contextBuilder')).default;
        const { content, name } = ContextBuilder.getInstance().loadAuxiliaryOnDemand(auxiliaryId);
        if (content === null) {
          const sel = ContextBuilder.getInstance().getLastAuxiliarySelection();
          const available = sel ? sel.omitted.map(o => o.id).join(', ') : '(none)';
          return {
            content: `Auxiliary "${auxiliaryId}" is not available on-demand. It may already be loaded inline, or be a phase-2 entry without a loader yet. Available: ${available}.`,
            isError: false,
          };
        }
        return {
          content: `# Auxiliary context: ${name}\n\n${content}`,
          isError: false,
        };
      }

      // Announce + start the tool at execution time. The query loop runs tools
      // serially, so doing the announcement here keeps later write calls out of
      // the UI while an earlier permission / diff / credential decision is
      // pending. onToolCallPending creates the card; onToolCallStart immediately
      // flips it to "running". Execution was already gated by the serial loop +
      // waitForUserGates; this only fixes the visual pile-up.
      callbacks.onToolCallPending(toolUseId, toolName);
      callbacks.onToolCallStart(toolUseId, toolName, toolInput);

      try {
        const raw = await this.toolExecutor.execute(
          toolName,
          toolInput,
          toolUseId,
          signal ?? undefined,
          this.agentType,
        );

        // Track file access
        this.sessionState.trackFileAccess(toolName, toolInput);

        // Diff approval for write/edit/create tools
        if (WRITE_TOOLS.has(toolName) && !this.lightweightOptions?.readOnly) {
          let parsedDiff: {
            type: string;
            path: string;
            isNewFile: boolean;
            newContent?: string;
          } | null = null;
          try {
            const parsed = JSON.parse(raw);
            if (parsed?.type === "diff") {
              parsedDiff = {
                type: parsed.type,
                path: parsed.path,
                isNewFile: !!parsed.isNewFile,
                newContent: parsed.newContent,
              };
            }
          } catch {
            /* not a diff JSON — return raw */
          }

          if (parsedDiff) {
            // Publish the diff before waiting. updateToolCallWithResult is the
            // code path that registers pendingDiffs, so waiting first deadlocks:
            // no approval UI exists yet to resolve createDiffApprovalPromise.
            callbacks.onToolResult(toolUseId, toolName, raw, false);
            const approved = await createDiffApprovalPromise(toolUseId);
            if (signal?.aborted) {
              return { content: "Aborted", isError: true };
            }
            if (approved) {
              this.sessionState.trackFileEdit(parsedDiff.path);
              if (parsedDiff.newContent !== undefined) {
                this.toolExecutor.updateReadStateAfterWrite(
                  parsedDiff.path,
                  parsedDiff.newContent,
                );
              }
              return {
                content: `File ${parsedDiff.isNewFile ? "created" : "updated"}: ${parsedDiff.path}`,
                isError: false,
              };
            }
            return {
              content: `User rejected: ${parsedDiff.path}`,
              isError: false,
            };
          }
        }

        return { content: raw, isError: false };
      } catch (err) {
        // formatError (not String(err)): a Tauri reject is usually a plain
        // object or serde-tagged enum — e.g. list_directory's build_file_tree
        // rejecting with {"PathNotFound":"…"} — which String() turns into the
        // literal "Error: [object Object]" the model (and the chat row) showed.
        const errorMsg = formatError(err);
        const failKey = `${toolName}:${String(toolInput.file_path || toolInput.command || "").slice(0, 80)}`;
        const count = this.sessionState.recordToolFailure(failKey, errorMsg);
        let content = `Error: ${errorMsg}`;
        if (count > 1)
          content = `[RETRY CONTEXT] Attempt #${count}. Consider a different approach.\n\nError: ${errorMsg}`;
        return { content, isError: true };
      }
    };
  }

  // ── Memory extraction (post-turn) ──

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
        { hasMemoryWriteSinceTurnStart },
      ] = await Promise.all([
        import("./memoryExtractor"),
        import("./memoryProposalsStore"),
        import("./memorySelector"),
        import("./memdir"),
        import("../../stores/projectStore"),
        import("./memoryWriteTracker"),
      ]);
      const sessionId = useChatStore.getState().activeSessionId;
      if (sessionId && hasMemoryWriteSinceTurnStart(sessionId)) return;
      const projectPath =
        useProjectStore.getState().currentProject?.path ?? null;
      const [userResult, projectResult] = await Promise.all([
        loadMemoryIndex("user"),
        projectPath
          ? loadMemoryIndex("project", projectPath)
          : Promise.resolve({ content: null }),
      ]);
      const existingNames: string[] = [];
      if (userResult.content)
        for (const e of parseIndexEntries(userResult.content))
          existingNames.push(e.name);
      if (projectResult.content)
        for (const e of parseIndexEntries(projectResult.content))
          existingNames.push(e.name);
      const result = await extractMemoriesFromTurn({
        userMessage,
        assistantText,
        existingNames,
      });
      if (result.proposals.length > 0) {
        await recordProposals(projectPath, result.proposals);
        invalidateMemorySelectorCache();
      }
    } catch {
      /* non-fatal */
    }
  }

  // ── Manual compact commands ──

  async runManualCompact(
    _customInstructions?: string,
    onProgress?: (event: import("@/types/agent").CompactProgressEvent) => void,
  ): Promise<{ beforeTokens: number; afterTokens: number }> {
    if (this.isRunning)
      throw new Error("Cannot compact while agent is running");
    const chatStore = useChatStore.getState();
    const session = chatStore.getActiveSession();
    if (!session || session.messages.length < 4)
      throw new Error("Not enough messages to compact");

    const anthropicMessages = buildInternalMessagesFromSession(session);
    if (anthropicMessages.length < 4)
      throw new Error("Not enough messages to compact");

    const beforeTokens = anthropicMessages.reduce(
      (s, m) =>
        s +
        Math.ceil(
          (typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content)
          ).length / 4,
        ),
      0,
    );
    onProgress?.({ type: "hooks_start", hookType: "pre_compact" });
    onProgress?.({ type: "compact_start", beforeTokens, trigger: "manual" });

    try {
      autoSaveSessionMemory(anthropicMessages);
      const compressed = await this.runCompactViaSDK(anthropicMessages);

      const { runPostCompactCleanup } = await import("./compactCleanup");
      await runPostCompactCleanup();

      const afterTokens = compressed.reduce(
        (s, m) =>
          s +
          Math.ceil(
            (typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content)
            ).length / 4,
          ),
        0,
      );

      const boundaryMessage: import("@/types/chat").ChatMessage = {
        id: generateId("msg"),
        role: "system",
        kind: "compact_boundary",
        compactBeforeTokens: beforeTokens,
        compactMetadata: {
          trigger: "manual",
          beforeTokens,
          messagesSummarized: anthropicMessages.length - compressed.length,
        },
        level: "info",
        content: `Conversa comprimida (${Math.round(beforeTokens / 1000)}K tokens).`,
        timestamp: Date.now(),
      };
      const summaryContent =
        compressed.find((m) => m.role === "user")?.content ??
        "Context was compressed.";
      const summaryMessage: import("@/types/chat").ChatMessage = {
        id: generateId("msg"),
        role: "assistant",
        content: `Contexto compactado de ${Math.round(beforeTokens / 1000)}K para ~${Math.round(afterTokens / 1000)}K tokens.\n\n${typeof summaryContent === "string" ? summaryContent : JSON.stringify(summaryContent)}`,
        timestamp: Date.now(),
      };
      chatStore.replaceMessages([boundaryMessage, summaryMessage]);
      chatStore.resetTokenCounters();
      chatStore.setPostCompactSurveyPending(true);

      onProgress?.({ type: "hooks_start", hookType: "post_compact" });
      onProgress?.({ type: "compact_end", beforeTokens, trigger: "manual" });
      return { beforeTokens, afterTokens };
    } catch (err) {
      onProgress?.({ type: "compact_end", beforeTokens, trigger: "manual" });
      throw err;
    }
  }

  async runPartialCompact(
    keepRecentCount?: number,
    onProgress?: (event: import("@/types/agent").CompactProgressEvent) => void,
  ): Promise<{ beforeTokens: number; afterTokens: number }> {
    if (this.isRunning)
      throw new Error("Cannot compact while agent is running");
    const chatStore = useChatStore.getState();
    const session = chatStore.getActiveSession();
    if (!session || session.messages.length < 4)
      throw new Error("Not enough messages to compact");

    const anthropicMessages = buildInternalMessagesFromSession(session);
    if (anthropicMessages.length < 4)
      throw new Error("Not enough messages to compact");

    const beforeTokens = anthropicMessages.reduce(
      (s, m) =>
        s +
        Math.ceil(
          (typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content)
          ).length / 4,
        ),
      0,
    );
    const defaultKeep = Math.max(10, Math.ceil(anthropicMessages.length * 0.3));
    const keep = keepRecentCount ?? defaultKeep;
    const splitPoint = Math.max(0, anthropicMessages.length - keep);
    const oldMessages = anthropicMessages.slice(0, splitPoint);
    const recentMessages = anthropicMessages.slice(splitPoint);

    if (oldMessages.length === 0) throw new Error("Nothing to compact");

    onProgress?.({ type: "hooks_start", hookType: "pre_compact" });
    onProgress?.({ type: "compact_start", beforeTokens, trigger: "manual" });

    try {
      autoSaveSessionMemory(oldMessages);

      let summary: string;
      if (this.sessionState.getSummarizationFailures() >= 3) {
        summary = mechanicalFallback(oldMessages);
      } else {
        try {
          summary = await this.runCompactSummaryViaSDK(oldMessages);
          this.sessionState.resetSummarizationFailures();
        } catch {
          this.sessionState.incrementSummarizationFailures();
          summary = mechanicalFallback(oldMessages);
        }
      }

      const systemMsg = anthropicMessages[0];
      const summaryMsg: InternalMessage = {
        role: "assistant",
        content: `[Partial compact — ${oldMessages.length} older messages summarized]\n\n${summary}`,
      };
      const compressed = [systemMsg, summaryMsg, ...recentMessages];

      const { runPostCompactCleanup } = await import("./compactCleanup");
      await runPostCompactCleanup();

      const afterTokens = compressed.reduce(
        (s, m) =>
          s +
          Math.ceil(
            (typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content)
            ).length / 4,
          ),
        0,
      );

      const boundaryMessage: import("@/types/chat").ChatMessage = {
        id: generateId("msg"),
        role: "system",
        kind: "compact_boundary",
        compactBeforeTokens: beforeTokens,
        compactMetadata: {
          trigger: "manual",
          beforeTokens,
          messagesSummarized: oldMessages.length,
        },
        level: "info",
        content: `Compactação parcial (${Math.round(beforeTokens / 1000)}K → ~${Math.round(afterTokens / 1000)}K tokens).`,
        timestamp: Date.now(),
      };
      const summaryMessage: import("@/types/chat").ChatMessage = {
        id: generateId("msg"),
        role: "assistant",
        content: `Compactação parcial: ${oldMessages.length} mensagens resumidas, ${recentMessages.length} preservadas.`,
        timestamp: Date.now(),
      };
      // Narrate structured content (tool_call/tool_result blocks) into
      // readable text instead of JSON.stringify-ing it. The stringified form
      // re-entered the next turn as literal `[{"type":"tool_call",...}]`
      // prose — pseudo-structure the model read as data, with tool_calls and
      // results no longer paired (context pollution audit, 2026-06-12).
      // contentAsText renders `[tool: name(args)]` + result text, the same
      // narration the mechanical compact fallback uses.
      const recentChatMessages: import("@/types/chat").ChatMessage[] =
        recentMessages.map((m) => ({
          id: generateId("msg"),
          role: m.role as "user" | "assistant",
          content:
            typeof m.content === "string"
              ? m.content
              : contentAsText(m.content),
          timestamp: Date.now(),
        }));
      chatStore.replaceMessages([
        boundaryMessage,
        summaryMessage,
        ...recentChatMessages,
      ]);
      chatStore.resetTokenCounters();
      chatStore.setPostCompactSurveyPending(true);

      onProgress?.({ type: "hooks_start", hookType: "post_compact" });
      onProgress?.({ type: "compact_end", beforeTokens, trigger: "manual" });
      return { beforeTokens, afterTokens };
    } catch (err) {
      onProgress?.({ type: "compact_end", beforeTokens, trigger: "manual" });
      throw err;
    }
  }

  // ── SDK-based compact helpers (replace old contextManager.compressContext) ──

  /**
   * Run full compact via SDK client — replaces the old compressContext()
   * that depended on the legacy contextManager summarization pipeline.
   */
  private async runCompactViaSDK(
    messages: InternalMessage[],
  ): Promise<InternalMessage[]> {
    const authToken = await FirebaseAuthService.getInstance().getIdToken();
    if (!authToken) return messages; // Can't compact without auth — return unchanged

    // Compaction must use the SAME carrier as the conversation — under BYOK
    // it runs on the user's key/model (free plan: their cost), never the worker.
    const client =
      this.byokActive && this.byokSnapshot
        ? await this.buildByokClient(this.byokSnapshot)
        : createAgentClient(authToken, { maxRetries: 0, timeout: 60_000 });
    if (!client) return messages; // BYOK key missing — skip compaction
    const model = this.resolveModel();

    // Build compact prompt
    const { getCompactPrompt } = await import("./compact/prompt");
    const systemPrompt = getCompactPrompt();

    // Narrate the full content (tool calls + bounded tool results) for the
    // compact call — NOT text-only. Stripping tool blocks before
    // summarization made the summarizer blind to every file edit, command
    // output and error it was then asked to preserve (context pollution
    // audit, 2026-06-12).
    const compactMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content:
          typeof m.content === "string"
            ? m.content
            : contentAsText(m.content as ContentBlockAPI[]),
      }))
      .filter((m) => m.content.length > 0);

    try {
      const extraHeaders: Record<string, string> | undefined =
        this.requestType ? { "X-Request-Type": this.requestType } : undefined;
      const response = await client.chat.completions.create(
        {
          model,
          max_tokens: 16384,
          messages: [
            { role: "system", content: systemPrompt },
            ...compactMessages.map(
              (m: any): OpenAI.ChatCompletionMessageParam => ({
                role: m.role as "user" | "assistant",
                content:
                  typeof m.content === "string"
                    ? m.content
                    : m.content.map((b: any) => b.text).join("\n"),
              }),
            ),
          ],
        },
        this.abortController
          ? { signal: this.abortController.signal, headers: extraHeaders }
          : { headers: extraHeaders },
      );
      const summary = response.choices[0]?.message?.content || "";

      if (!summary) return messages;

      // Return compressed form: system + summary
      return [
        { role: "user" as const, content: summary },
        {
          role: "assistant" as const,
          content: "I understand the context. Let me continue.",
        },
      ];
    } catch {
      return messages; // Fallback: return unchanged
    }
  }

  /**
   * Run summary-only compact via SDK — used by partial compact for older messages.
   */
  private async runCompactSummaryViaSDK(
    messages: InternalMessage[],
  ): Promise<string> {
    const authToken = await FirebaseAuthService.getInstance().getIdToken();
    if (!authToken) return mechanicalFallback(messages);

    // Same carrier as the conversation — BYOK summary runs on the user's key.
    const client =
      this.byokActive && this.byokSnapshot
        ? await this.buildByokClient(this.byokSnapshot)
        : createAgentClient(authToken, { maxRetries: 0, timeout: 60_000 });
    if (!client) return mechanicalFallback(messages); // BYOK key missing
    const model = this.resolveModel();
    const { getCompactPrompt } = await import("./compact/prompt");

    // Narrate full content (tool calls + bounded tool results) — see the
    // matching comment in runCompactViaSDK; text-only blinded the summarizer.
    const compactMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content:
          typeof m.content === "string"
            ? m.content
            : contentAsText(m.content as ContentBlockAPI[]),
      }))
      .filter((m) => m.content.length > 0);

    const extraHeaders: Record<string, string> | undefined =
      this.requestType ? { "X-Request-Type": this.requestType } : undefined;

    const response = await client.chat.completions.create(
      {
        model,
        max_tokens: 16384,
        messages: [
          { role: "system", content: getCompactPrompt() },
          ...compactMessages.map(
            (m: any): OpenAI.ChatCompletionMessageParam => ({
              role: m.role as "user" | "assistant",
              content:
                typeof m.content === "string"
                  ? m.content
                  : m.content.map((b: any) => b.text).join("\n"),
            }),
          ),
        ],
      },
      this.abortController
        ? { signal: this.abortController.signal, headers: extraHeaders }
        : { headers: extraHeaders },
    );
    return (
      response.choices[0]?.message?.content || mechanicalFallback(messages)
    );
  }
}

export default AgentService;
