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
  generateId,
  resolveAllPendingDiffApprovals,
  useChatStore,
} from "../../stores/chatStore";
import { markWriteBatchDecision, writeBatchSiblings } from "./writeBatch";
import { markProjectEdited, startDiagnosticsBaseline } from "./editDiagnostics";
import { getProjectStateDir } from "../projectStatePaths";
import { useBillingStore } from "../../stores/billingStore";
import { useAgentStore } from "../../stores/agentStore";
import { getPersonaFallbackModelId, getPersonaFallbackContextWindow } from "../../stores/activeModelStore";
import {
  currentPublishedEffortOptions,
  parseReasoningEffortsHeader,
  resolveEffectiveEffort,
  resolveEffortModelId,
  resolveEffortTurnStamp,
  shouldSendEffort,
} from "./reasoningEffortModels";
import { useTmSpeedStore } from "../../stores/tmSpeedStore";
import { usePersonaStore } from "../../stores/personaStore";
import { useReasoningEffortStore } from "../../stores/reasoningEffortStore";
import { runHooks, appendHookContext, takeHookContext } from "./hooks";
import { invoke } from "@/utils/invokeMetrics";
import { logger } from "../../utils/logger";
import {
  FALLBACK_CONTEXT_WINDOW,
  getPostCompactRecoveryMaxChars,
} from "../../utils/contextWindow";
import { rememberServedWindow } from "./servedWindowMemory";
import { getQueryGuard } from "./queryGuard";
import { beginMainRunClaims, endMainRunClaims } from "./fileClaims";
import type { ContentPart, ByokSessionSnapshot } from "../../types/chat";

// ── Query engine ──

import type OpenAI from "openai";
import { createAgentClient } from "./sdkClient";
import { buildRunClient } from "./runClient";
import { useByokStore } from "../../stores/byokStore";
import { buildByokClientFromSnapshot, buildByokThinkingConfig, resolveByokSnapshotForSession } from "./byokRouting";
import { getActiveContextWindow } from "./activeContextWindow";
import { contentAsText } from "./promptValueHelpers";
import { QueryEngine, toQueryMessages } from "./queryEngine";
import {
  resolveQueryOccupancySeed,
  resolveSeedMessageCount,
} from "../../utils/sessionOccupancy";
import { TOOL_SEARCH_NAME, toolSearchDefinition, searchDeferredTools } from "./toolPolicy";
import { emitAgentStopRequested } from "./host/hostBus";
import { windowBudgetHooks } from "./host/windowHost";
import { getAgentHost } from "./host/agentHost";
import { processRegistry } from "./processRegistry";
import { buildAppliedEditResultText } from "./toolExecutor/changedFileSnippet";
import type { QueryStreamEvent, QueryTerminal, ToolExecutorFn } from "./query";
import { classifyExecuteCommandPurpose, convertShellReadCommand } from "./commandPurpose";
import { canonicalToolName } from "./toolNames";
import { formatShellReadRedirect } from "./shellReadRedirect";
import {
  decorateTmsRequestUsage,
  getTmsTurnTelemetry,
  markExecuteCommandPurpose,
  markOriginalTaskCompleted,
  markOriginalTaskFailed,
  markOriginalTaskStarted,
  markOriginalTaskWriteStats,
  markShellReadBlocked,
  markTmsBootstrapFailed,
  markTmsCreated,
  markTmsWriteAttempt,
  setTmsTurnTelemetry,
} from "./tmsContext";

// ── Extracted services ──

import { SessionState } from "./sessionState";
import {
  checkForLoop,
  createLoopDetectorState,
  resetLoopDetector,
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

/** Tools cujo resultado é um DIFF pendente de aprovação (nomes canónicos).
 *  Partilhado entre o bridge (abre o portão de aprovação) e o predicado
 *  isWriteTool do query loop (batching de writes do mesmo turno). */
const WRITE_TOOLS = new Set(["write_file", "edit_file", "create_file"]);

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
  // Fase do run corrente, para o bridge do executor. `executionPhase` é local
  // ao runQueryEngineLoop e o bridge é outro método — sem este campo o portão
  // de confinação de escrita do bootstrap não tinha como ver a fase.
  private currentExecutionPhase: 'project_bootstrap' | 'original_task' = 'original_task';
  // Última resposta HTTP confirmou TM Speed (`X-TM-Speed-Applied: true`)?
  // Os headers chegam no início de cada resposta e o `message_stop` desse
  // mesmo turno chega depois (sequencial), por isso um campo simples por
  // resposta é suficiente para parear turno ↔ multiplicador de cobrança.
  // Só é atualizado em runs não-lightweight (lightweight não envia o header
  // X-TM-Speed nem liga onResponseHeaders) e é reposto no início de cada run.
  private lastResponseSpeedApplied = false;

  // Array de tool defs do RUN CORRENTE — a mesma referência que o QueryEngine
  // envia em cada pedido (query.ts usa `activeTools = tools` sem cópia). O
  // bridge do `load_tools` empurra defs MCP diferidos para aqui a meio do
  // run; do turno seguinte em diante seguem nos pedidos. Reatribuído no
  // início de cada run (runQueryEngineLoop), nunca mutado fora do bridge.
  private activeRunTools: OpenAI.ChatCompletionTool[] | null = null;

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
      // `getAllToolDefinitions`, NÃO `getToolDefinitions` — e a diferença é
      // uma capacidade perdida em silêncio. Um run lightweight não leva o
      // `ToolSearch` (ver a injecção mais abaixo, atrás de
      // `!this.lightweightOptions`), portanto o que não vier no schema à
      // partida é INALCANÇÁVEL para ele. Com as nativas situacionais a serem
      // diferidas desde 2026-08-12, o método normal deixava um sub-agente sem
      // 15 tools e sem via de as carregar — deferral a remover capacidade em
      // vez de a adiar, que é exactamente o modo de falha desta família.
      // Mantém verdadeiro o contrato do tipo: "if omitted, uses all tools".
      this.tools = options.tools || this.toolExecutor.getAllToolDefinitions();
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
    this.toolExecutor.setRequestType(type);
  }
  getRequestType(): string | null {
    return this.requestType;
  }

  isThinkingRequestedForNextTurn(): boolean {
    try {
      // Managed path: o seletor de effort manda no UI de reasoning.
      // none/minimal → esconde blocos; high/max → mostra se o modelo emitir.
      // (Antes só olhávamos MODEL_PROFILES[modelName] e, sem X-TM-Model ainda,
      //  caíamos num fallback que podia esconder reasoning legítimo.)
      if (!this.byokActive) {
        const modelId = resolveEffortModelId(
          getPersonaFallbackModelId(),
          useAgentStore.getState().modelName,
        );
        const published = currentPublishedEffortOptions();
        if (shouldSendEffort(modelId, published)) {
          const selected = useReasoningEffortStore.getState().selected;
          const effort = resolveEffectiveEffort(modelId, selected, published);
          return effort !== "none" && effort !== "minimal";
        }
        // Id ainda null → seletor usa fallback GLM; assume thinking ON até
        // Firestore/header revelarem o modelo.
        if (modelId == null) return true;
      }

      const plan = useBillingStore.getState().plan;
      const modelName = resolveEffortModelId(
        getPersonaFallbackModelId(),
        useAgentStore.getState().modelName,
      );
      const profile =
        modelName && MODEL_PROFILES[modelName]
          ? MODEL_PROFILES[modelName]
          : getProfileForPlan(plan);
      return profile.supportsThinking === true;
    } catch {
      return false;
    }
  }

  /**
   * Carimbo de effort para o próximo turno (valor efetivo + se o header sai).
   * Só no caminho managed; BYOK devolve null (usa byokSnapshot.reasoningEffort).
   */
  getEffortStampForNextTurn(): { effort: string; sent: boolean } | null {
    if (this.byokActive) return null;
    try {
      const modelId = resolveEffortModelId(
        getPersonaFallbackModelId(),
        useAgentStore.getState().modelName,
      );
      const selected = useReasoningEffortStore.getState().selected;
      return resolveEffortTurnStamp(modelId, selected, currentPublishedEffortOptions());
    } catch {
      return null;
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
        // prompt de permissão pendente E a fila. Sem isto, stopAgent →
        // cancelLoop deixava o diálogo no ecrã; um
        // "Aprovar" tardio resolvia a Promise e a tool EXECUTAVA num run já
        // morto (escrita de ficheiro/comando com a UI em idle). Isto centraliza para
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
    void (async () => {
      // F2 MDI: kill ONLY this (main) run's own background processes. A
      // parallel task's background process (owner = its runId) belongs to a
      // different project's live run — the main run's cancel/restart/budget
      // stop must not tear it down. The task kills its own on its abort.
      // (P3.1: registry do motor, não a store.)
      const running = processRegistry
        .getAll()
        .filter((c) => c.status === "running" && c.owner === "main");
      for (const cmd of running) {
        try {
          await invoke("kill_process", { pid: cmd.pid });
        } catch {
          /* best effort */
        }
        processRegistry.cancelCommand(cmd.id);
      }
    })().catch(() => {});
    this.isRunning = false;
    if (!this.lightweightOptions) {
      getQueryGuard().forceEnd();
      // P1 headless: o CustomEvent 'agent-stop-requested' no window virou
      // hostBus — o único listener (reviewCommand) subscreve o bus, e um
      // hospedeiro sem DOM continua a conseguir cancelar sub-agentes.
      emitAgentStopRequested();
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
    // ANTI-RESSURREIÇÃO (par da guarda do agentRunner): o Stop pode aterrar
    // na fronteira await entre a verificação do runner e esta entrada. Antes
    // de criar o controller NOVO (que o cancelLoop já não apanharia) e do
    // tryStart, confirma que a generation não avançou desde o dispatch.
    if (
      !this.lightweightOptions &&
      callbacks.dispatchGeneration !== undefined &&
      getQueryGuard().generation !== callbacks.dispatchGeneration
    ) {
      // Stop durante a prep (ou na fronteira await runner→service): a generation
      // avançou via forceEnd. NÃO criar controller/tryStart. O stopAgentRun já
      // limpou UI na maior parte dos casos; re-aplicar status/finalize é
      // idempotente e evita tips/`awaiting_response` presos se a corrida
      // só aterra aqui.
      logger.info(
        "agent",
        "Stop durante a preparação — loop não arranca (zombie morto na entrada)",
      );
      // Limpeza de UI SÓ se nenhum run mais novo ocupou o guard — um reenvio
      // já em prep/streaming é o dono do status e da bolha; este zombie não
      // pode fechá-los por cima dele.
      if (!getQueryGuard().isActive) {
        try {
          useAgentStore.getState().setStatus("cancelled");
          // `interrupted: true` — este ramo SÓ existe porque houve Stop (a
          // generation avançou via forceEnd). Quando o stopAgentRun já
          // carimbou, repetir é inofensivo: o finalize só espalha
          // `wasInterrupted` quando é true, portanto o carimbo existente
          // sobrevive. Quando a corrida aterra só aqui, era este o único
          // sítio que podia carimbar — e não carimbava.
          useChatStore.getState().finalizeAssistantMessage({ interrupted: true });
        } catch {
          /* non-critical */
        }
      }
      return;
    }
    this.isRunning = true;
    if (!this.lightweightOptions) {
      useAgentStore.getState().setWorkerStatus(null);
    }

    let myGeneration: number | null = null;
    if (!this.lightweightOptions) {
      this.abortController = new AbortController();
      myGeneration = getQueryGuard().tryStart();
      if (myGeneration !== null) {
        // Registry único de claims (Fase 4b): o run principal regista e
        // respeita propriedade de ficheiros como qualquer tarefa.
        beginMainRunClaims();
      }
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
      // TRACKER POR-SESSÃO: nada a limpar — cada sessão tem o seu balde e um
      // run de história vazia é uma sessão nova, cujo balde já nasce vazio.
      // O antigo clearTasks() global aqui APAGARIA o tracker da sessão FOCADA
      // (que pode ainda ser a anterior se o foco não migrou), destruindo o
      // trabalho dela. O foco/hidratação vivem no trackerFocusSync.
      this.sessionState.resetForNewSession();
      this.toolExecutor.resetSessionState();
      // Detector de loop CROSS-RUN: o estado é do singleton e sobrevivia a
      // trocas de sessão/projecto (auditoria 2026-07-28) — três respostas
      // finais parecidas em SESSÕES diferentes ganhavam um "[Loop detected]"
      // colado a uma resposta legítima. O reset por sessão preserva o caso
      // que o guard existe para apanhar (auto-wake/fila a gerar runs
      // idênticos em série DENTRO da mesma sessão) e mata o vazamento.
      resetLoopDetector(this.loopState);
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
      if (!this.lightweightOptions && myGeneration !== null) {
        getQueryGuard().end(myGeneration);
        endMainRunClaims();
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // QueryEngine loop — replaces the old imperative loop
  // ══════════════════════════════════════════════════════════════

  /**
   * Contexto comum aos hooks. Devolve null quando não há projecto aberto —
   * sem projecto não há `.toquemedia/hooks.json` para ler, e correr comandos
   * do developer fora de um projecto seria executar config de ninguém.
   */
  private async hookContext(): Promise<
    { projectPath: string; sessionId: string; fsVersion: number } | null
  > {
    try {
      const { useProjectStore } = await import("../../stores/projectStore");
      const projectPath = useProjectStore.getState().currentProject?.path;
      if (!projectPath) return null;
      const { useChatStore } = await import("../../stores/chatStore");
      const chat = useChatStore.getState();
      const { getFsVersion } = await import("../fsVersion");
      return {
        projectPath,
        sessionId: chat.streamingSessionId ?? chat.activeSessionId ?? "",
        fsVersion: getFsVersion(),
      };
    } catch {
      return null;
    }
  }

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

    // FUSÃO F3: cliente + closure de refresh no NÚCLEO partilhado (runClient.ts)
    // — a mesma função que serve as tarefas paralelas e os sub-agentes. Só os
    // efeitos colaterais ESPECÍFICOS do principal ficam aqui (seed de model-info
    // BYOK; limpar o marcador BYOK preso numa rota gerida).
    const runClient = await buildRunClient({
      authToken,
      snapshot,
      byokActive,
      lightweight: !!this.lightweightOptions,
      // Chave de afinidade do Workers AI — a sessão do RUN, não o utilizador.
      // Ver sdkClient.createAgentClient para os números que motivaram isto.
      sessionId: useChatStore.getState().streamingSessionId
        ?? useChatStore.getState().activeSessionId
        ?? undefined,
      onByokKeyMissing: () =>
        callbacks.onError(
          new ServiceError(
            `BYOK: no API key set for "${snapshot?.providerId ?? "provider"}". Add it in Settings → API Keys.`,
            "BYOK_KEY_MISSING",
            false,
          ),
        ),
    });
    if (!runClient) return; // BYOK key missing — erro já reportado via onError
    const { client, refreshClient } = runClient;
    if (byokActive && snapshot) {
      // Sem headers X-Model-* em BYOK (worker bypassed) — semeia model info do
      // snapshot para o ctx pill / toggle de thinking / auto-compact.
      if (!this.lightweightOptions) this.seedByokModelInfo(snapshot);
    } else if (!this.lightweightOptions) {
      // Rota gerida — limpa marcador BYOK preso de uma sessão BYOK anterior
      // (o worker nunca emite X-BYOK-Active, nada mais o reset­aria).
      useAgentStore.getState().setByokActive(false);
    }

    // 3. Build tool definitions in OpenAI format
    // web_search NUNCA vai no schema: modelos com pesquisa nativa
    // (supportsSearch, ex.: qwen3.8-max) pesquisam SERVER-SIDE
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

    // 4.5. Dynamic toolset selector — starts with the model-selected profile
    // base plus model-planned groups, then expands on demand through the
    // request_tools meta-tool. Reduces tool-schema overhead (~10K tokens for
    // 36 tools) to the few the current task needs. Sub-agents skip selection.
    // Wire auxiliary-context omissions + profile/readOnly into the selector.
    // A seleção foi calculada durante o buildSystemPrompt (guardada no
    // singleton do ContextBuilder) por heurística LOCAL — não há Intent Router
    // (removido; ver a nota no contextBuilder). Lemos antes de construir o
    // selector para o construtor poder semear o
    // active set with the profile's base toolset (default_task/analysis_readonly/…).
    // Profiles are starters, not authorization ceilings. Sub-agents skip this
    // (they already receive a restricted tool set from the subAgentRunner).
    let auxiliarySelection: import('./contextBuilder/auxiliaryRegistry').AuxiliarySelection | null = null;
    if (!this.lightweightOptions) {
      const ContextBuilder = (await import('./contextBuilder')).default;
      auxiliarySelection = ContextBuilder.getInstance().getLastAuxiliarySelection();
    }

    const executionPhase = auxiliarySelection?.profile === "project_bootstrap"
      ? "project_bootstrap"
      : "original_task";
    const enforceReadOnly = auxiliarySelection?.readOnly === true &&
      auxiliarySelection.routerSource === "keyword";
    // O `mutableTask` que era calculado aqui (e o guard anti-adiamento que o
    // consumia no loop) foi APAGADO a 2026-07-31: `requiresMutation` só era
    // produzido pelo Intent Router, removido na auditoria de 2026-07-28,
    // portanto o guard nunca armava. O cli-vaz não tem equivalente — a
    // cobertura estrutural do mesmo risco é o guard de reconciliação do task
    // tracker no stop path do query loop.

    // FASE A (recalibração de cache 2026-07-17): toolset CONGELADO por run —
    // schemas completos e estáveis do 1º ao último turno. A seleção dinâmica
    // custava caro em cadeia: cada request_tools invalidava o PREFIXO inteiro
    // do cache do provider (tools→system→histórico re-faturados a 100%) e
    // cada misclassificação do router custava turnos de auto-correção. Com a
    // cobrança de cache a 50%, o conjunto estável vence.
    //
    // ESTADO REAL, medido na auditoria de 2026-07-29: este selector é `null`
    // em TODOS os runs. `enforceReadOnly` exige `auxiliarySelection.readOnly`,
    // que só ficaria true com o perfil `analysis_readonly` ou com um
    // `intentOverride.readOnly` — e o classificador local devolve apenas
    // `vision`/`default_task`, enquanto os dois únicos produtores de
    // intentOverride (/init e o preflight de TMS) passam `readOnly: false`.
    // Não vou ressuscitar o caminho com matching de texto: foi assim que uma
    // classificação read-only errada negou create/edit num run inteiro, e a
    // doutrina do turnEfficiency.ts deste repo proíbe-o.
    //
    // O que era ERRADO era deixar os PORTÕES pendurados nele. Os dois que
    // valem alguma coisa saíram daqui: a confinação de escrita do
    // project_bootstrap passa a olhar para `executionPhase` (alcançável) e o
    // bloqueio de tools destrutivas passa a olhar para `readOnlyRun`
    // (alcançável pelos sub-agentes read-only). O selector fica só com o que
    // é otimização de custo — e essa, se nunca correr, não mente a ninguém.
    this.currentExecutionPhase = executionPhase;

    if (!this.lightweightOptions) {
      if (executionPhase === "original_task") {
        markOriginalTaskStarted();
      } else {
        setTmsTurnTelemetry({ executionPhase: "project_bootstrap" });
      }
    }
    // As pré-activações determinísticas que viviam aqui (EDIT_FILE quando a
    // tarefa é mutável, WEB_FETCH quando o utilizador colou um URL) saíram
    // com o ToolsetSelector a 2026-07-30: eram ambas `if (toolsetSelector &&
    // …)` sobre um objecto que é null em todos os runs, portanto nunca
    // correram — e não fazem falta nenhuma, porque sem selector o toolset vai
    // COMPLETO desde o turno 1. Garantiam acesso a ferramentas que já lá
    // estão.

    // O meta-tool `request_context` e o índice on-demand que o alimentava foram
    // REMOVIDOS a 2026-08-05. Medido: 0 chamadas em 34 e em 114 pedidos, e o
    // índice que as anunciava custava 786-1247 tokens POR PEDIDO — mais do que
    // as secções que retinha. A referência é o cli-vaz: não há catálogo de
    // contexto a pedir; o que o projecto justifica vai inline, o resto o modelo
    // descobre com as ferramentas normais (ler, procurar, listar, LSP).
    if (!this.lightweightOptions) {

      // Defs MCP DIFERIDOS (2026-08-03): getToolDefinitions() já não os
      // inclui — o modelo procura/carrega os schemas de que precisa via
      // `ToolSearch` (uma quebra de cache no momento da necessidade, em vez
      // de todos os schemas MCP em todos os pedidos). Os nomes diferidos
      // vivem na secção MCP do prompt; o def do ToolSearch é byte-estável
      // (sem interpolações), portanto o prefixo de cache fica intacto até o
      // modelo DECIDIR carregar.
      // Optional-chaining defensivo (estilo getProjectRootForDiagnostics): um
      // executor sem esta capacidade nunca pode abortar o arranque do run.
      const deferredIndex = this.toolExecutor.getDeferredToolIndex?.() ?? [];
      if (deferredIndex.length > 0) {
        openaiTools.push(toolSearchDefinition());
      }
    }

    // Array VIVO do run: o query loop envia `activeTools` por referência em
    // cada pedido, portanto o bridge do load_tools pode empurrar defs para
    // aqui a meio do run e eles seguem do turno seguinte em diante.
    this.activeRunTools = openaiTools;

    // 5. Create tool executor bridge
    const executeTool = this.createToolExecutorBridge(callbacks);
    this.toolExecutor.clearDelegateTelemetry();
    // Baseline de diagnósticos é POR RUN e arranca AQUI, em background: um
    // `tsc` frio leva ~10s e a fase de exploração do agente leva mais do que
    // isso antes do primeiro edit. Sem o arranque antecipado, o primeiro turn
    // boundary com edições pagaria a passagem fria inteira.
    // try/catch: um guarda de diagnósticos NUNCA pode impedir um run de
    // arrancar. Sem isto, um toolExecutor sem esta capacidade (ou uma raiz
    // irresolúvel) atirava um TypeError daqui e abortava o loop inteiro antes
    // sequer de o QueryEngine ser construído.
    try {
      const diagRoot = this.toolExecutor.getProjectRootForDiagnostics?.() ?? "";
      if (diagRoot) {
        // O `.tsbuildinfo` do --incremental vai para o estado gerido da app,
        // NUNCA para a raiz do developer: sem isto ficava lá um ficheiro de
        // ~0,5 MB (medido) só por termos verificado tipos, visível no git
        // status de quem não o tenha ignorado.
        void getProjectStateDir(diagRoot)
          .then((dir: string) => startDiagnosticsBaseline(diagRoot, dir))
          .catch(() => startDiagnosticsBaseline(diagRoot));
      }
    } catch {
      /* sem baseline: a recolha desiste sozinha */
    }

    // 6. Build extra headers — X-Request-Type is sticky across turns
    const extraHeaders = this.buildExtraHeaders();

    // Reset por run: evita que um run anterior servido em speed "vaze" o
    // multiplicador para o primeiro turno deste run antes dos headers chegarem.
    this.lastResponseSpeedApplied = false;

    // GUARDA DE CANCELAMENTO PRÉ-VOO: o Stop durante a preparação (token,
    // system prompt, router de perfil, planner de contexto — facilmente
    // vários segundos) abortava this.abortController mas NADA aqui o lia; o
    // run continuava, criava o engine (com AbortController PRÓPRIO, novo) e
    // fazia streaming até ao diálogo de permissão num run já morto — o
    // "cancelei e segundos depois veio o pedido de autorização" do developer.
    if (this.abortController?.signal.aborted) {
      logger.info("agent", "Run cancelled during prep — skipping engine start");
      return;
    }

    // 7. Create QueryEngine
    const engine = new QueryEngine({
      // P1 headless: hooks de orçamento da janela (billingStore) — o loop
      // deixou de conhecer a store; ver windowHost.windowBudgetHooks.
      ...windowBudgetHooks(),
      client,
      refreshClient,
      byokDirect: this.byokActive,
      model: this.resolveModel(),
      systemPrompt: this.systemPrompt,
      tools: openaiTools,
      executeTool,
      // Liga o status 'compressing' no momento da DECISÃO, não no fim do
      // trabalho — é o que faz a barra de progresso aparecer durante a espera.
      // Marco do orçamento de tool results — atravessa até ao chatStore.
      onContextBudgetApplied: callbacks.onContextBudgetApplied,
      onCompactionPhaseStart: () => {
        try {
          useAgentStore.getState().setCompactPhase("compressing");
          useAgentStore.getState().setStatus("compressing");
        } catch { /* observability never blocks */ }
      },
      // Execução em streaming (query.ts): só tools concurrencySafe (read-only
      // por definição do flag) podem começar durante o SSE. Canonicaliza
      // porque o modelo chama aliases (Read/Grep/...) e o registry pode ter
      // o flag na entrada canónica. Meta-tools (request_tools/context) não
      // estão no registry → false → nunca pre-despacham.
      isStreamSafeTool: (name) =>
        this.toolExecutor.isConcurrencySafe(name) ||
        this.toolExecutor.isConcurrencySafe(canonicalToolName(name)),
      // Batching de writes (query.ts): identifica os tools cujo resultado é
      // um diff pendente de aprovação, para runs consecutivas de writes num
      // turno serem despachadas em lote (aprovação única). Sub-agentes
      // read-only nunca chegam cá (readOnlyRun bloqueia antes).
      isWriteTool: (name) => WRITE_TOOLS.has(canonicalToolName(name)),
      // O prompt do main contém o reminder; os sub-agentes (lightweight) não.
      reinjectCriticalReminder: !this.lightweightOptions,
      // Só o agente principal é dono do tracker visível no chat. Sub-agentes
      // usam o mesmo QueryEngine, mas não devem receber pendências alheias.
      enableTaskTrackerReminder: !this.lightweightOptions,
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
            const changed = await collectChangedFileContext();
            // Diagnósticos NOVOS introduzidos pelas edições deste turno
            // (porte do diagnosticTracking do claude-vaz — ver
            // editDiagnostics.ts). Vai pelo MESMO canal da varredura de
            // modificações externas: o modelo não tem de chamar nada.
            let diagnostics = "";
            try {
              const { collectNewDiagnostics, formatDiagnosticsReminder } =
                await import("./editDiagnostics");
              const root = this.toolExecutor.getProjectRootForDiagnostics();
              const found = await collectNewDiagnostics(root);
              diagnostics = formatDiagnosticsReminder(found, root);
            } catch {
              /* nunca bloqueia o turno */
            }
            return [changed, diagnostics].filter(Boolean).join("\n\n");
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
        // A janela é a MESMA que o pill e o `/context` mostram — uma só
        // definição, em utils/contextWindow.resolveContextWindow. Modelo
        // desconhecido (sem header, fora de MODEL_PROFILES) assume 200K e NÃO
        // o 1M do perfil do plano, para compactar cedo em vez de estourar; o
        // admin publica a janela real em Settings → Admin.
        // Cadeia ÚNICA (05-08): byok(do run) → header → persona → perfil →
        // fallback. Antes não lia o snapshot BYOK: quando o snapshot não
        // trazia janela, o auto-compact decidia pela janela da PERSONA gerida,
        // que pode ser muito maior que a do modelo BYOK — e estourava no
        // provedor. O header manda sobre o perfil no tecto de output: um
        // modelo publicado só no KV herdava o teto do fallback (MiMo, 32K) e
        // calava-se aí, e esse valor é também o teto da escalada
        // anti-truncagem em query.ts (auditoria 2026-07-28).
        return getActiveContextWindow({
          byokContextWindow: this.byokSnapshot?.contextWindow ?? null,
        });
      },
      // Mesmo prato: um follow-up ("continue") depois de Stop não zera o
      // medidor. Sub-agentes ficam de fora — o histórico deles é outro.
      ...(!this.lightweightOptions
        ? (() => {
            const seed = resolveQueryOccupancySeed(
              useChatStore.getState().getActiveSession(),
            );
            if (!seed) return {};
            return {
              initialRealOccupancyTokens: seed.tokens,
              initialRealOccupancyMessageCount: resolveSeedMessageCount(
                seed.messageCount,
                conversationHistory.length,
              ),
            };
          })()
        : {}),
      // ── Compactação: arquivo + recuperação (paridade claude-vaz) ──
      // Ambos vivem aqui porque o loop (query.ts) não conhece stores nem o
      // SessionState — e não deve. Sub-agentes ficam de fora dos dois: escrevem
      // na sessão do agente principal (o arquivo colidiria) e o seu contexto é
      // a tarefa que receberam, não o working set do developer.
      archivePreCompact: this.lightweightOptions
        ? undefined
        : async (older) => {
            try {
              const { archivePreCompactTranscript } = await import(
                "./compactTranscriptArchive"
              );
              const chatState = useChatStore.getState();
              // streamingSessionId primeiro, e o projectPath vem da MESMA
              // sessão (não de getActiveSession): trocar de sessão a meio de um
              // run punha o arquivo na pasta do projeto errado — o mesmo bug
              // que a persistência das skills invocadas já teve.
              const sessionId =
                chatState.streamingSessionId ?? chatState.activeSessionId;
              if (!sessionId) return null;
              const projectPath = chatState.sessions.get(sessionId)?.projectPath;
              if (!projectPath) return null;
              return await archivePreCompactTranscript(
                projectPath,
                sessionId,
                older as import("./compactTranscriptArchive").ArchivedMessage[],
              );
            } catch {
              return null;
            }
          },
      buildPostCompactRecovery: this.lightweightOptions
        ? undefined
        : async (maxChars?: number) => {
            try {
              const { buildPostCompactRecoveryBlock } = await import(
                "./contextManager"
              );
              return await buildPostCompactRecoveryBlock(
                this.sessionState,
                undefined,
                maxChars ?? this.resolveRecoveryMaxChars(),
              );
            } catch {
              return null;
            }
          },
      // Usage is reported via message_stop events — do NOT add onUsage
      // callback here or output tokens will be double-counted (SUM semantics).
      // onRequestUsage is distinct: it carries the payloadInspector breakdown
      // (not in message_stop) — pure observability, no double-counting.
      onRequestUsage: (entry) => callbacks.onRequestUsage?.(decorateTmsRequestUsage(entry, this.systemPrompt)),
      // Dynamic toolset selector (null for sub-agents).
      // Política de read-only, separada do selector: cobre os sub-agentes
      // lightweight (verify, /review) que antes não tinham bloqueio nenhum.
      readOnlyRun: this.lightweightOptions?.readOnly === true || enforceReadOnly,
      // Auxiliary-context selection (core/auxiliary breakdown for the
      // payloadInspector; null for sub-agents).
      auxiliarySelection: auxiliarySelection ?? undefined,
      executionPhase,
      // Delegate telemetry — read from the toolExecutor's last delegate call.
      getDelegateTelemetry: () => this.toolExecutor.consumeDelegateTelemetry(),
    });
    this.queryEngine = engine;

    // Fecha a race restante: Stop entre a guarda acima e esta atribuição
    // (cancelLoop viu queryEngine=null e não teve nada para cancelar).
    if (this.abortController?.signal.aborted) {
      this.queryEngine = null;
      logger.info("agent", "Run cancelled between prep and engine start");
      return;
    }

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
            // Vem do autoCompact (`older.length`). Era a constante 0, e o marco
            // anunciava "0 mensagens sumarizadas" numa compactação que libertou
            // 65% do contexto — telemetria que ensina a desconfiar do marco.
            messagesSummarized: event.messagesSummarized ?? 0,
            summary: event.summary,
            recovery: event.recovery,
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

    // Stamp write-stats + outcome telemetry onto the last requestUsageLog
    // entry so the session export shows the final decision explicitly.
    // Best-effort — never blocks.
    if (terminal.reason === "completed") {
      try {
        if (!this.lightweightOptions && executionPhase === "original_task") {
          markOriginalTaskWriteStats(
            terminal.originalTaskWriteActionCount ?? terminal.writeActionCount ?? 0,
            terminal.originalTaskFirstWriteTurn ?? terminal.firstWriteTurn,
          );
          markOriginalTaskCompleted();
        }
        useChatStore.getState().updateLastRequestUsage({
          ...getTmsTurnTelemetry(),
          executionPhase,
          runHasEdited: terminal.runHasEdited,
          firstWriteTurn: terminal.firstWriteTurn,
          writeActionCount: terminal.writeActionCount,
          originalTaskWriteActionCount: terminal.originalTaskWriteActionCount ?? terminal.writeActionCount,
          originalTaskFirstWriteTurn: terminal.originalTaskFirstWriteTurn ?? terminal.firstWriteTurn,
        });
      } catch { /* telemetry never blocks */ }
    }
    if (terminal.reason !== "completed" && !this.lightweightOptions && executionPhase === "original_task") {
      try {
        markOriginalTaskWriteStats(
          terminal.originalTaskWriteActionCount ?? terminal.writeActionCount ?? 0,
          terminal.originalTaskFirstWriteTurn ?? terminal.firstWriteTurn,
        );
        markOriginalTaskFailed(terminal.reason);
        useChatStore.getState().updateLastRequestUsage({
          ...getTmsTurnTelemetry(),
          executionPhase,
          originalTaskFailedReason: terminal.reason,
          originalTaskWriteActionCount: terminal.originalTaskWriteActionCount ?? terminal.writeActionCount ?? 0,
          originalTaskFirstWriteTurn: terminal.originalTaskFirstWriteTurn ?? terminal.firstWriteTurn,
        });
      } catch { /* telemetry never blocks */ }
    }

    if (auxiliarySelection?.profile === "project_bootstrap") {
      let bootstrapFailureText: string | null = null;
      try {
        const telemetryBefore = getTmsTurnTelemetry();
        if (telemetryBefore.tmsBootstrapTriggered) {
          setTmsTurnTelemetry({
            tmsBootstrapOutputTokens: terminal.totalOutputTokens ?? 0,
          });
          const latest = getTmsTurnTelemetry();
          if (!latest.tmsCreated && !latest.tmsAlreadyExists) {
            const reason =
              terminal.reason === "max_turns"
                ? "project_bootstrap atingiu o limite de turnos antes de criar TMS.md"
                : latest.tmsWriteAttempted
                  ? "foi feita uma tentativa de escrita, mas TMS.md não foi confirmado como criado"
                  : "o agente terminou o bootstrap antes de tentar escrever TMS.md";
            markTmsBootstrapFailed(reason);
            bootstrapFailureText = `Não consegui criar TMS.md: ${reason}.`;
          }
          useChatStore.getState().updateLastRequestUsage({
            ...getTmsTurnTelemetry(),
          });
        }
      } catch {
        /* telemetry must never hide the model response */
      }
      if (bootstrapFailureText) {
        finalText = finalText
          ? `${finalText}\n\n${bootstrapFailureText}`
          : bootstrapFailureText;
      }
    }

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

    // Resposta cortada e sem forma de retomar: dizê-lo. O silêncio aqui é o
    // pior dos dois mundos — o utilizador lê uma frase a meio e não tem como
    // saber se aquilo era o fim. `incomplete` só chega aqui depois de a
    // retoma ter sido tentada e esgotada (ver query.ts).
    if (terminal.reason === "incomplete") {
      const note = "⚠️ A resposta ficou cortada: o modelo parou a meio e as tentativas de retoma esgotaram-se. Pede para continuar se faltar informação.";
      callbacks.onDone(finalText ? `${finalText}\n\n${note}` : note);
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
      // `vision=1;search=0;thinking=toggleable` — declarado na config KV e
      // emitido pelo data-plane. Existe porque a tabela MODEL_PROFILES local é
      // fixa e, para um modelo que ela não conhece, a IDE herdava as flags do
      // perfil de FALLBACK: visão, pensamento e pesquisa de OUTRO modelo. Num
      // desenho em que publicar um modelo é editar a KV, isso significa que o
      // modelo novo ganhava capacidades que não tem — imagens enviadas a quem
      // não as lê (auditoria 2026-07-29). Chaves desconhecidas são ignoradas
      // de propósito, para o header crescer sem quebrar clientes antigos.
      const capabilitiesRaw = headers.get("X-Model-Capabilities");
      const declaredCapabilities = (() => {
        if (capabilitiesRaw === null) return undefined;
        const map = new Map<string, string>();
        for (const pair of capabilitiesRaw.split(";")) {
          const [k, v] = pair.split("=");
          if (k && v !== undefined) map.set(k.trim().toLowerCase(), v.trim().toLowerCase());
        }
        const bool = (key: string): boolean | null | undefined => {
          const v = map.get(key);
          if (v === undefined) return undefined;
          return v === "1" || v === "true";
        };
        return { vision: bool("vision"), search: bool("search"), thinking: map.get("thinking") };
      })();
      const contextWindowRaw = headers.get("X-Model-Context-Window");
      const maxOutputRaw = headers.get("X-Model-Max-Output-Tokens");
      const byokActiveRaw = headers.get("X-BYOK-Active");
      // Team BYOK: the worker served this via the team's own provider/key
      // (config team:{teamId}). Emitted as true/false every response so a later
      // managed-path turn clears the indicator.
      const teamByokRaw = headers.get("X-TM-Team-Byok");

      const effortsRaw = headers.get("X-Model-Reasoning-Efforts");
      const hasModelInfo =
        modelName !== null ||
        modelProvider !== null ||
        thinkingModeRaw !== null ||
        contextWindowRaw !== null ||
        maxOutputRaw !== null ||
        capabilitiesRaw !== null ||
        effortsRaw !== null;

      if (hasModelInfo) {
        const parsedContext =
          contextWindowRaw !== null ? Number.parseInt(contextWindowRaw, 10) : undefined;
        const contextWindow =
          parsedContext !== undefined && Number.isFinite(parsedContext) && parsedContext > 0
            ? parsedContext
            : contextWindowRaw !== null
              ? null
              : undefined;
        // O `thinking` das capacidades vale como o header dedicado: é o mesmo
        // dado, publicado no mesmo sítio. O header antigo mantém precedência
        // para não mudar o comportamento de quem já o emitia.
        const thinkingRaw = thinkingModeRaw ?? declaredCapabilities?.thinking ?? null;
        const thinkingMode =
          thinkingRaw === "none" ||
          thinkingRaw === "toggleable" ||
          thinkingRaw === "mandatory"
            ? thinkingRaw
            : thinkingRaw !== null
              ? null
              : undefined;

        // Mesma tolerância do contextWindow: número válido → usa; header
        // presente mas inválido → null (limpa); ausente → undefined (não toca).
        const parsedMaxOutput =
          maxOutputRaw !== null ? Number.parseInt(maxOutputRaw, 10) : undefined;
        const maxOutputTokens =
          parsedMaxOutput !== undefined && Number.isFinite(parsedMaxOutput) && parsedMaxOutput > 0
            ? parsedMaxOutput
            : maxOutputRaw !== null
              ? null
              : undefined;

        // Lembra a janela POR CONFIG (provider+modelo), não por modelo: o mesmo
        // glm-5.2 vem do z.AI, do DashScope e do Cloudflare Workers AI (262k),
        // e a tabela de perfis, indexada só pelo id, não distingue os três.
        // Sem isto, o 1º turno de cada arranque calcula limiares contra a
        // janela errada até o header chegar. Best-effort, nunca bloqueia.
        rememberServedWindow(modelProvider, modelName, contextWindow, maxOutputTokens);

        const parsedEfforts = parseReasoningEffortsHeader(effortsRaw);
        useAgentStore.getState().setModelInfo(
          modelName,
          modelProvider,
          thinkingMode,
          contextWindow,
          maxOutputTokens,
          declaredCapabilities
            ? { vision: declaredCapabilities.vision, search: declaredCapabilities.search }
            : undefined,
          parsedEfforts,
        );
        // O modelo SERVIDO vive só no agentStore.modelName (setModelInfo acima)
        // — desde 05-08 é ele que manda no resolveEffortModelId (served-first);
        // o activeModelStore passou a guardar o mapa persona→modelo do admin.
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
    // Persona (Escolha do Modelo): roteia o main loop para a config
    // `persona:*` publicada pelo admin, com multiplicador de custo próprio.
    // Sempre enviada no caminho gerido (default 'standard'); pedidos com
    // X-Request-Type são sidecar-first no worker, portanto o header é
    // inofensivo nos auxiliares. Persona não publicada degrada para a ativa.
    if (!this.lightweightOptions) {
      headers["X-TM-Persona"] = usePersonaStore.getState().selected;
    }
    // Reasoning-effort EFETIVO — mesma resolução de modelId que o seletor e o
    // carimbo da mensagem (Firestore → fallback X-TM-Model em agentStore).
    // Antes só lia activeModelStore: se o Firestore atrasasse e o header já
    // tivesse revelado grok-4.5, o UI mostrava Low e o header NÃO saía →
    // Grok caía no default high (lento). `shouldSendEffort` evita 400 em
    // modelos não-mapeados.
    if (!this.lightweightOptions) {
      const modelId = resolveEffortModelId(
        getPersonaFallbackModelId(),
        useAgentStore.getState().modelName,
      );
      const published = currentPublishedEffortOptions();
      if (shouldSendEffort(modelId, published)) {
        const selected = useReasoningEffortStore.getState().selected;
        headers["X-TM-Reasoning-Effort"] = resolveEffectiveEffort(modelId, selected, published);
      }
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

  private getToolInputPath(toolInput: Record<string, unknown>): string | null {
    const value = toolInput.file_path ?? toolInput.path ?? toolInput.directory;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private async getCurrentProjectRootPath(): Promise<string | null> {
    try {
      const { useProjectStore } = await import("../../stores/projectStore");
      return useProjectStore.getState().currentProject?.path ?? null;
    } catch {
      return null;
    }
  }

  private async markProjectTmsPresent(): Promise<void> {
    try {
      const { useProjectStore } = await import("../../stores/projectStore");
      useProjectStore.getState().setNoTmsFile(false);
    } catch {
      /* non-critical outside the full Tauri app */
    }
  }

  private async isProjectRootTmsPath(rawPath: string | null): Promise<boolean> {
    if (!rawPath) return false;
    const normalizedPath = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalizedPath === "TMS.md" || normalizedPath === "./TMS.md") return true;

    const projectRoot = (await this.getCurrentProjectRootPath())
      ?.replace(/\\/g, "/")
      .replace(/\/+$/, "");
    if (!projectRoot) return /(^|\/)TMS\.md$/i.test(normalizedPath);

    return normalizedPath.toLowerCase() === `${projectRoot}/TMS.md`.toLowerCase();
  }

  /**
   * Create the ToolExecutorFn bridge that connects the query loop's tool
   * execution to TM Code's ToolExecutor with diff approval support.
   */
  private createToolExecutorBridge(callbacks: AgentCallbacks): ToolExecutorFn {
    return async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolUseId: string,
      signal?: AbortSignal,
    ): Promise<{ content: string; isError: boolean }> => {

      // Intercepta o meta-tool ToolSearch (contrato de treino do cli-vaz) —
      // o modelo procura/seleciona tools MCP diferidas; o bridge devolve os
      // schemas no bloco <functions> E empurra os defs para o array vivo do
      // run (this.activeRunTools). Nunca chega ao toolExecutor. Ver a nota
      // no toolPolicy.ts sobre a diferença face ao request_tools morto.
      if (toolName === TOOL_SEARCH_NAME) {
        const queryStr = typeof toolInput.query === 'string' ? toolInput.query : '';
        const maxResults = typeof toolInput.max_results === 'number' && toolInput.max_results > 0
          ? toolInput.max_results
          : 5;
        if (!queryStr.trim()) {
          return {
            content: 'No query provided. Use "select:<tool_name>" (comma-separated for several) or keywords to search the deferred tool list.',
            isError: false,
          };
        }
        const index = this.toolExecutor.getDeferredToolIndex();
        const matches = searchDeferredTools(queryStr, index, maxResults);
        if (matches.length === 0) {
          return { content: 'No matching deferred tools found', isError: false };
        }
        const { defs } = this.toolExecutor.getDeferredToolDefinitions(matches);
        const target = this.activeRunTools;
        for (const def of defs) {
          if (target && !target.some((t) => t.function.name === def.function.name)) {
            target.push({
              type: 'function' as const,
              function: {
                name: def.function.name,
                description: def.function.description,
                parameters: def.function.parameters as Record<string, unknown>,
              },
            });
          }
        }
        // Formato do contrato: uma linha <function>{...}</function> por match
        // — o mesmo encoding da lista de tools do topo do prompt.
        const lines = defs.map((d) =>
          `<function>${JSON.stringify({
            description: d.function.description,
            name: d.function.name,
            parameters: d.function.parameters,
          })}</function>`,
        );
        return { content: `<functions>\n${lines.join('\n')}\n</functions>`, isError: false };
      }

      // DUAS variáveis, de propósito — e a distinção é cara.
      //
      // `canonicalName` serve as comparações LOCAIS desta função: o
      // `WRITE_TOOLS.has(...)` que abre o portão de aprovação de diffs, o
      // desvio de leituras-por-shell, os gates do selector. Sem canonizar,
      // comparavam o nome do dialecto de treino (`Edit`, `Bash`) contra nomes
      // canónicos e devolviam sempre false — foi assim que o portão dos diffs
      // esteve morto e o agente seguiu para a tool seguinte com o utilizador
      // ainda a olhar para os botões Accept/Reject (sessão momenu-fact 29-07).
      //
      // `effectiveToolName` fica RAW porque é o que segue para o
      // `toolExecutor.execute`, e o executor precisa de saber o que o MODELO
      // escreveu: `normalizeToolInputForCanonical` e `routeTrainedToolCall`
      // (toolExecutor.ts:1147-1152) derivam do nome pedido, não do canónico.
      // Canonizar aqui matava os dois em silêncio — `Grep({pattern})` perdia o
      // mapeamento para `query`, `Grep` perdia o default de regex, `Bash` com
      // `run_in_background` deixava de ser reencaminhado para background e
      // bloqueava o turno, `Glob({path})` passava a varrer a raiz do projecto.
      // Os caminhos de sub-agente e de tarefa paralela sempre passaram o nome
      // raw; era só o agente principal que ficava sem normalização.
      const canonicalName = canonicalToolName(toolName);
      let effectiveToolName = toolName;
      let effectiveToolInput = toolInput;

      // Canónico: com o dialecto de treino chega `Bash`, e a comparação crua
      // deixava a redirecção de leituras-por-shell (`cat`, `head` → Read) sem
      // efeito nenhum.
      if (canonicalName === "execute_command") {
        const command = typeof toolInput.command === "string" ? toolInput.command : "";
        const converted = convertShellReadCommand(command);
        const purpose = converted ? "file_read" : classifyExecuteCommandPurpose(command);
        markExecuteCommandPurpose(purpose);
        if (converted) {
          markShellReadBlocked(false);
          return {
            content: formatShellReadRedirect(command, converted),
            isError: true,
          };
          // O ramo "file_read SEM conversão" foi removido (auditoria
          // 2026-07-28): classificava pelo PRIMEIRO token e bloqueava
          // `cat a.sql b.sql > merged.sql`, `sed -i …`, `find … -delete`
          // como "inspeção", apontando para Read/Grep — que não fazem esses
          // trabalhos. Regra: só se redireciona quando há um SUBSTITUTO real
          // (converted); o resto segue para o fluxo normal, onde os gates de
          // permissão/perigo continuam a valer.
        }
      }

      // `executionPhase`, não `selector.getProfile()`: o selector é null em
      // todos os runs (ver a nota na sua construção), e com ele morria a
      // confinação de escrita do /init — que podia escrever qualquer ficheiro
      // do projecto na fase de bootstrap. Pior: `markTmsWriteAttempt` vivia
      // dentro deste mesmo ramo, portanto o diagnóstico de falha do bootstrap
      // afirmava sempre "terminou antes de tentar escrever TMS.md", mesmo
      // quando havia tentativa. `executionPhase` deriva do perfil da seleção
      // auxiliar e é `project_bootstrap` de facto quando o /init corre.
      if (this.currentExecutionPhase === "project_bootstrap" && WRITE_TOOLS.has(canonicalName)) {
        const targetPath = this.getToolInputPath(effectiveToolInput);
        if (!(await this.isProjectRootTmsPath(targetPath))) {
          return {
            content: `Tool blocked: project_bootstrap may only write the root TMS.md file. Requested path: ${targetPath ?? "(missing)"}.`,
            isError: true,
          };
        }
        markTmsWriteAttempt(toolUseId, targetPath ?? undefined);
      }

      // Announce + start the tool at execution time. onToolCallPending creates
      // the card; onToolCallStart immediately flips it to "running". Reads e
      // afins continuam gated pelo loop serial + waitForUserGates; writes do
      // MESMO lote aparecem todos de uma vez — é intencional: os diffs do
      // turno são publicados em conjunto e aprovados como lote na
      // DiffApprovalPanel, não pingados um a um.
      callbacks.onToolCallPending(toolUseId, effectiveToolName);
      callbacks.onToolCallStart(toolUseId, effectiveToolName, effectiveToolInput);

      // ── HOOKS do developer (porte cli-vaz) ────────────────────────────
      // O NOME passado ao matcher é o que o MODELO vê (`Write`, `Bash`), não o
      // id canónico: é assim no cli-vaz, e é o que faz um hook escrito para o
      // Claude Code casar aqui sem reescrita.
      const hookCtx = await this.hookContext();
      if (hookCtx) {
        const pre = await runHooks("PreToolUse", {
          toolName,
          toolInput: effectiveToolInput,
          ...hookCtx,
        });
        if (pre.blocked) {
          // Bloqueio entra como RESULTADO da tool, com a razão: é o único
          // canal que o modelo lê no mesmo turno e no qual pode agir.
          return {
            content: `Blocked by a PreToolUse hook: ${pre.blockReason ?? "(no reason given)"}`,
            isError: true,
          };
        }
        if (pre.additionalContext) {
          appendHookContext(toolUseId, pre.additionalContext);
        }
      }

      try {
        const raw = await this.toolExecutor.execute(
          effectiveToolName,
          effectiveToolInput,
          toolUseId,
          signal ?? undefined,
          this.agentType,
        );
        let content = raw;

        // PostToolUse: o `additionalContext` vai colado ao resultado da tool.
        // Não usa o canal inter-turno do editDiagnostics de propósito — este
        // feedback é sobre ESTA escrita, e chegar um turno depois já era tarde.
        if (hookCtx) {
          const post = await runHooks("PostToolUse", {
            toolName,
            toolInput: effectiveToolInput,
            toolResponse: raw,
            ...hookCtx,
          });
          // Exit 2 no PostToolUse é IMPOSIÇÃO, não conselho. A escrita já
          // aconteceu (o Post corre depois), portanto não se pode desfazer —
          // mas o resultado vai como ERRO, e um erro o modelo tem de tratar.
          // Medido a 2026-08-06: `additionalContext` sozinho não muda
          // comportamento (5/10, igual a não haver hook).
          //
          // Este ramo faltava: o `blocked` era calculado e deitado fora, ou
          // seja um hook de Post com exit 2 não fazia NADA. Mecanismo que
          // parece vivo e não está — o padrão que esta casa já catalogou.
          if (post.blocked) {
            takeHookContext(toolUseId); // não deixar contexto órfão no buffer
            return {
              content:
                `The tool ran and its result was REJECTED by a PostToolUse hook: ` +
                `${post.blockReason ?? "(no reason given)"}\n\n` +
                `The change is already on disk. Fix it — do not repeat the same write.`,
              isError: true,
            };
          }
          if (post.additionalContext) {
            appendHookContext(toolUseId, post.additionalContext);
          }
        }
        const pendingHookContext = takeHookContext(toolUseId);
        if (pendingHookContext) {
          content = `${content}\n\n<system-reminder>\n${pendingHookContext}\n</system-reminder>`;
        }

        // Track file access
        this.sessionState.trackFileAccess(effectiveToolName, effectiveToolInput);

        // Diff approval for write/edit/create tools
        if (WRITE_TOOLS.has(canonicalName) && !this.lightweightOptions?.readOnly) {
          let parsedDiff: {
            type: string;
            path: string;
            isNewFile: boolean;
            newContent?: string;
          } | null = null;
          try {
            const parsed = JSON.parse(content);
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
            // FASE, não perfil do selector (auditoria 2026-07-30). Este era o
            // TERCEIRO portão pendurado no ToolsetSelector — que é null em
            // todos os runs — e escapou à migração de 07-29 porque a asserção
            // negativa do deadGateRewiring.test.ts procura `selector?.` em
            // minúsculas e aqui está `currentToolsetSelector?.`. Enquanto
            // esteve morto, o /init nunca auto-aplicava o TMS.md: a escrita do
            // ficheiro que o /init existe para criar caía no diálogo de diff.
            const autoApplyTmsBootstrap =
              this.currentExecutionPhase === "project_bootstrap" &&
              /[\\/]TMS\.md$/i.test(parsedDiff.path) &&
              parsedDiff.newContent !== undefined;
            if (autoApplyTmsBootstrap) {
              const newContent = parsedDiff.newContent as string;
              await invoke("write_file", {
                path: parsedDiff.path,
                content: newContent,
              });
              const appliedRaw = JSON.stringify({
                ...JSON.parse(content),
                alreadyApplied: true,
              });
              callbacks.onToolResult(toolUseId, effectiveToolName, appliedRaw, false);
              this.sessionState.trackFileEdit(parsedDiff.path);
              markTmsCreated(parsedDiff.path);
              await this.markProjectTmsPresent();
              this.toolExecutor.updateReadStateAfterWrite(
                parsedDiff.path,
                newContent,
              );
              return {
                content: `File ${parsedDiff.isNewFile ? "created" : "updated"}: ${parsedDiff.path}\nProject bootstrap is complete. Stop this phase; the host will resume the original user request.`,
                isError: false,
              };
            }

            // Publish the diff before waiting. updateToolCallWithResult is the
            // code path that registers pendingDiffs, so waiting first deadlocks:
            // no approval UI exists yet to resolve createDiffApprovalPromise.
            callbacks.onToolResult(toolUseId, effectiveToolName, content, false);
            // P2 headless: a espera pela decisão humana do diff vive no
            // hospedeiro (janela: createDiffApprovalPromise do chatStore).
            const approved = await getAgentHost().approveDiff(toolUseId);
            if (signal?.aborted) {
              return { content: "Aborted", isError: true };
            }
            markWriteBatchDecision(toolUseId, approved);
            if (approved) {
              // Escrita APLICADA: só agora vale a pena pagar a passagem do
              // `tsc` no turn boundary. Um diff rejeitado não muda o disco.
              markProjectEdited();
              this.sessionState.trackFileEdit(parsedDiff.path);
              if (/[\\/]TMS\.md$/i.test(parsedDiff.path)) {
                markTmsCreated(parsedDiff.path);
                await this.markProjectTmsPresent();
              }
              if (parsedDiff.newContent !== undefined) {
                this.toolExecutor.updateReadStateAfterWrite(
                  parsedDiff.path,
                  parsedDiff.newContent,
                );
              }
              return {
                // Mesmo formato do caminho directo (query.ts). O diff já está
                // disponível na UI; não repetir o ficheiro no transcript.
                content: buildAppliedEditResultText(parsedDiff),
                isError: false,
              };
            }
            // Aviso de estado MISTO. Tem de cobrir os dois lados do lote, não
            // só o que já foi aprovado: se ainda houver membros por decidir,
            // podem ser aplicados DEPOIS desta rejeição (o developer navega a
            // lista pela ordem que quiser). Sem o segundo ramo, rejeitar
            // primeiro e aprovar depois deixava o modelo a assumir um disco
            // intacto que já não era.
            const siblings = writeBatchSiblings(toolUseId);
            const mixedStateWarning = siblings.approvedOthers
              ? " Other edits from this batch were applied — re-read affected files before assuming a consistent state."
              : siblings.undecidedOthers
                ? " Other edits from this batch are still awaiting a decision and may be applied — re-read affected files before assuming a consistent state."
                : "";
            return {
              content: `User rejected: ${parsedDiff.path}` + mixedStateWarning,
              isError: false,
            };
          }
        }

        return { content, isError: false };
      } catch (err) {
        // formatError (not String(err)): a Tauri reject is usually a plain
        // object or serde-tagged enum — e.g. list_directory's build_file_tree
        // rejecting with {"PathNotFound":"…"} — which String() turns into the
        // literal "Error: [object Object]" the model (and the chat row) showed.
        const errorMsg = formatError(err);
        const failKey = `${effectiveToolName}:${String(effectiveToolInput.file_path || effectiveToolInput.command || "").slice(0, 80)}`;
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
      // Sessão do RUN, não a activa (P1 headless, portão nº9): o extractor
      // corre no FIM do run — se o utilizador trocou de sessão a meio,
      // activeSessionId aponta à sessão errada e o guard/propostas iam para
      // o balde errado. streaming-primeiro é o idioma já usado pelo arquivo
      // pré-compactação e pelo taskOps (getTaskOrigin ?? streaming ?? activa).
      const chatState = useChatStore.getState();
      const sessionId =
        chatState.streamingSessionId ?? chatState.activeSessionId;
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

  /**
   * A compactação manual escreve no store DEPOIS de esperar pelo sumarizador
   * (até 240s, SUMMARIZE_TIMEOUT_MS). `replaceMessages` resolve a sessão ativa
   * no momento da ESCRITA, não no da leitura — e como o agente não está a
   * correr, nada impede o developer de trocar de sessão ou de projeto durante
   * essa espera.
   *
   * Isso sempre foi uma janela de escrita cruzada; passou a ser pior quando a
   * compactação deixou de ser destrutiva, porque o que se escreve agora é o
   * HISTÓRICO INTEIRO da sessão de origem em vez de duas mensagens. Transplante
   * silencioso de uma conversa para cima de outra.
   *
   * Fixa-se a sessão à entrada e confirma-se à saída. Divergiu → não se escreve
   * nada; a compactação perde-se, que é o resultado correto (o developer mudou
   * de assunto).
   */
  private assertSameSession(pinnedSessionId: string): void {
    if (useChatStore.getState().activeSessionId !== pinnedSessionId) {
      throw new Error(
        "A sessão mudou durante a compactação — nada foi escrito. Volte à sessão e repita.",
      );
    }
  }

  /**
   * Teto do bloco de recuperação para a janela ATIVA. A janela é publicada por
   * modelo (X-Model-Context-Window) e pode ser 128K ou 2M — um teto fixo em
   * caracteres significava coisas opostas nos dois extremos.
   */
  private resolveRecoveryMaxChars(): number {
    const { modelContextWindow, modelMaxOutputTokens, modelName } =
      useAgentStore.getState();
    const known = modelName ? MODEL_PROFILES[modelName] : undefined;
    const window =
      modelContextWindow ?? getPersonaFallbackContextWindow() ?? known?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
    return getPostCompactRecoveryMaxChars(
      window,
      modelMaxOutputTokens ?? known?.maxOutputTokens ?? null,
    );
  }

  /**
   * Arquiva o bloco que a compactação manual vai substituir e devolve o
   * caminho. Mesmo contrato do `archivePreCompact` do loop: best-effort, nunca
   * lança. Duplicado em vez de partilhado porque o caminho do loop só existe
   * quando há um QueryEngine vivo, e a compactação manual corre parada.
   */
  private async archiveForManualCompact(
    older: InternalMessage[],
  ): Promise<string | null> {
    try {
      const { archivePreCompactTranscript } = await import(
        "./compactTranscriptArchive"
      );
      const chatState = useChatStore.getState();
      const sessionId = chatState.activeSessionId;
      if (!sessionId) return null;
      const projectPath = chatState.sessions.get(sessionId)?.projectPath;
      if (!projectPath) return null;
      return await archivePreCompactTranscript(
        projectPath,
        sessionId,
        older as import("./compactTranscriptArchive").ArchivedMessage[],
      );
    } catch {
      return null;
    }
  }

  /**
   * Os dois payloads que a fronteira de compactação manual leva consigo — é
   * ISTO que `rebuildConversationHistory` volta a emitir para o modelo, e a
   * única coisa do lado manual que sobrevive à compactação.
   *
   * `summary` é narrativa (embrulhada com o enquadramento de continuação e o
   * caminho do arquivo) e vai ao cartão expansível da UI; `recovery` é material
   * (conteúdo de ficheiros, skills) e nunca é mostrado.
   */
  private async buildManualCompactBoundaryPayload(
    summary: string,
    transcriptPath: string | null,
    recentMessagesPreserved: boolean,
  ): Promise<{ summary: string; recovery?: string }> {
    const { getCompactUserSummaryMessage } = await import("./compact/prompt");
    const wrapped = getCompactUserSummaryMessage(
      summary,
      true,
      recentMessagesPreserved,
      transcriptPath,
    );
    try {
      const { buildPostCompactRecoveryBlock } = await import("./contextManager");
      const recovery = await buildPostCompactRecoveryBlock(
        this.sessionState,
        undefined,
        this.resolveRecoveryMaxChars(),
      );
      return { summary: wrapped, recovery: recovery ?? undefined };
    } catch {
      // Recuperação é bónus — nunca impede a compactação.
      return { summary: wrapped };
    }
  }

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
    // Fixa a sessão: a escrita acontece depois de esperar pelo sumarizador.
    const pinnedSessionId = chatStore.activeSessionId!;

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
      // Arquivo em paralelo com a sumarização — a escrita passa pelo IPC e é a
      // segunda operação mais lenta deste caminho.
      const archivePromise = this.archiveForManualCompact(anthropicMessages);
      const compressed = await this.runCompactViaSDK(anthropicMessages, pinnedSessionId);

      const { runPostCompactCleanup } = await import("./compactCleanup");
      await runPostCompactCleanup();

      const rawSummary =
        compressed.find((m) => m.role === "user")?.content ??
        "Context was compressed.";
      const summaryText =
        typeof rawSummary === "string" ? rawSummary : JSON.stringify(rawSummary);

      // A fronteira é o ÚNICO canal do lado manual: rebuildConversationHistory
      // re-emite `compactSummary` (+ `compactRecovery`) e ignora tudo o resto
      // que seja `system`. Antes ficava vazia e o resumo vivia só na bolha de
      // assistant — o modelo lia-o como palavras SUAS de um turno anterior,
      // sem o enquadramento ("continua sem perguntar"), sem o caminho do
      // arquivo e sem o estado de trabalho recuperado.
      const boundaryPayload = await this.buildManualCompactBoundaryPayload(
        summaryText,
        await archivePromise,
        false,
      );

      // Conta o que a conversa passa REALMENTE a ocupar — os dois payloads da
      // fronteira. Contar `compressed` media o intermediário do
      // runCompactViaSDK, que nem sequer é o que fica no store: dizia "de 120K
      // para 2K" enquanto a recuperação injetava mais 15K.
      const afterTokens = Math.ceil(
        (boundaryPayload.summary.length +
          (boundaryPayload.recovery?.length ?? 0)) /
          4,
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
        compactSummary: boundaryPayload.summary,
        ...(boundaryPayload.recovery
          ? { compactRecovery: boundaryPayload.recovery }
          : {}),
        level: "info",
        content: `Conversa comprimida (${Math.round(beforeTokens / 1000)}K → ~${Math.round(afterTokens / 1000)}K tokens).`,
        timestamp: Date.now(),
      };
      // ACRESCENTA, não substitui (2026-07-31). `replaceMessages([boundary])`
      // apagava o transcript do disco; agora a fronteira é um marcador e o
      // corte é um filtro de leitura (rebuildConversationHistory + o slice do
      // ChatView), portanto o histórico anterior continua exportável e o
      // "mostrar histórico anterior" tem o que mostrar.
      //
      // A bolha visível de assistant desapareceu: o sumário vive no cartão
      // expansível da fronteira (MessageBubble lê `compactSummary`). Tê-lo nos
      // dois sítios mandava-o DUAS vezes para o modelo.
      this.assertSameSession(pinnedSessionId);
      chatStore.replaceMessages([...session.messages, boundaryMessage]);
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
    // Fixa a sessão: a escrita acontece depois de esperar pelo sumarizador.
    const pinnedSessionId = chatStore.activeSessionId!;

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

    // O corte é feito nas MENSAGENS DO STORE, não na forma interna.
    //
    // Antes cortava-se `anthropicMessages` e depois re-renderizavam-se os
    // turnos preservados para texto (`contentAsText`) antes de os escrever de
    // volta no store — ou seja, a "parte preservada" perdia a estrutura:
    // tool_calls e tool_results deixavam de estar emparelhados e passavam a ser
    // prosa. Agora que a fronteira é um filtro de leitura, os turnos recentes
    // ficam onde estão, intactos, e a fronteira entra ANTES deles.
    //
    // Cortar em qualquer índice de ChatMessage é seguro: os tool_calls vivem NA
    // mensagem de assistant e rebuildConversationHistory emite o par
    // assistant+tool_results a partir dela, portanto um par nunca fica a cavalo
    // de duas mensagens.
    const storeMessages = session.messages;
    const defaultKeep = Math.max(10, Math.ceil(storeMessages.length * 0.3));
    const keep = keepRecentCount ?? defaultKeep;
    const splitIdx = Math.max(0, storeMessages.length - keep);
    const olderChat = storeMessages.slice(0, splitIdx);
    const recentChat = storeMessages.slice(splitIdx);

    if (olderChat.length === 0) throw new Error("Nothing to compact");

    // Só o bloco ANTIGO vai ao sumarizador — o recente continua literal no
    // contexto, resumi-lo seria duplicá-lo.
    const oldMessages = buildInternalMessagesFromSession({
      ...session,
      messages: olderChat,
    });
    if (oldMessages.length === 0) throw new Error("Nothing to compact");

    onProgress?.({ type: "hooks_start", hookType: "pre_compact" });
    onProgress?.({ type: "compact_start", beforeTokens, trigger: "manual" });

    try {
      autoSaveSessionMemory(oldMessages);
      const archivePromise = this.archiveForManualCompact(oldMessages);

      let summary: string;
      if (this.sessionState.getSummarizationFailures() >= 3) {
        summary = mechanicalFallback(oldMessages);
      } else {
        try {
          summary = await this.runCompactSummaryViaSDK(oldMessages, pinnedSessionId);
          this.sessionState.resetSummarizationFailures();
        } catch {
          this.sessionState.incrementSummarizationFailures();
          summary = mechanicalFallback(oldMessages);
        }
      }

      const { runPostCompactCleanup } = await import("./compactCleanup");
      await runPostCompactCleanup();

      // O sumário SÓ vivia num array local usado para contar tokens — nunca
      // chegava ao store, portanto a compactação parcial sumarizava e deitava
      // fora o resultado: o modelo ficava com os turnos recentes e ZERO do que
      // foi resumido. Agora vai na fronteira, que é o canal que
      // rebuildConversationHistory lê.
      const boundaryPayload = await this.buildManualCompactBoundaryPayload(
        summary,
        await archivePromise,
        recentChat.length > 0,
      );

      // O que a conversa passa a ocupar: os payloads da fronteira + os turnos
      // que ficaram preservados.
      const afterTokens =
        Math.ceil(
          (boundaryPayload.summary.length +
            (boundaryPayload.recovery?.length ?? 0)) /
            4,
        ) +
        buildInternalMessagesFromSession({
          ...session,
          messages: recentChat,
        }).reduce(
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
          messagesSummarized: olderChat.length,
        },
        compactSummary: boundaryPayload.summary,
        ...(boundaryPayload.recovery
          ? { compactRecovery: boundaryPayload.recovery }
          : {}),
        level: "info",
        content: `Compactação parcial (${Math.round(beforeTokens / 1000)}K → ~${Math.round(afterTokens / 1000)}K tokens).`,
        timestamp: Date.now(),
      };
      // Antigo + fronteira + recente INTACTO. Os turnos preservados já não são
      // re-renderizados para texto: ficam as mensagens reais, com os tool_calls
      // e resultados emparelhados como sempre estiveram. O antigo fica no store
      // (invisível por causa do filtro de leitura) em vez de ser apagado.
      this.assertSameSession(pinnedSessionId);
      chatStore.replaceMessages([...olderChat, boundaryMessage, ...recentChat]);
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
    sessionId?: string,
  ): Promise<InternalMessage[]> {
    // Compaction must use the SAME carrier as the conversation — under BYOK
    // it runs on the user's key/model (free plan: their cost), never the worker.
    // Resolvido POR SESSÃO e POR CHAMADA (auditoria BYOK 05-08): os campos de
    // instância (this.byokActive/byokSnapshot) só são escritos dentro de
    // runQueryEngineLoop — um /compact antes de qualquer envio (campos frios)
    // mandava um transcript BYOK para o worker gerido (medido/faturado), e um
    // /compact depois de trocar de sessão usava a chave/provider da ANTERIOR.
    const { snapshot: byokSnapshot, byokActive } =
      resolveByokSnapshotForSession(sessionId);
    let client: OpenAI | null;
    if (byokActive && byokSnapshot) {
      client = await this.buildByokClient(byokSnapshot);
    } else {
      // Token TM só é necessário no caminho gerido — exigi-lo no BYOK fazia a
      // compactação virar no-op silencioso com sessão TM expirada/offline.
      const authToken = await FirebaseAuthService.getInstance().getIdToken();
      if (!authToken) return messages; // Can't compact without auth — return unchanged
      client = createAgentClient(authToken, { maxRetries: 0, timeout: 60_000 });
    }
    if (!client) return messages; // BYOK key missing — skip compaction
    const model = byokActive && byokSnapshot ? byokSnapshot.modelId : "tm-active-model";

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
      // Compact na PERSONA do run (ronda-2 #12): alinha modelo, janela e
      // billing — na `active` (ex.: 200K) uma conversa dimensionada p/ 1M
      // dava 400 upstream e "Conversa comprimida (0K → 0K)".
      // Headers TM SÓ no caminho gerido — na rota BYOK directa iam no fio para
      // o provider do user (gateways estritos rejeitam headers desconhecidos →
      // compact falhava em silêncio; e vazava metadata TM a um terceiro).
      const extraHeaders: Record<string, string> | undefined =
        byokActive && byokSnapshot
          ? undefined
          : {
              ...(this.requestType ? { "X-Request-Type": this.requestType } : {}),
              "X-TM-Persona": usePersonaStore.getState().selected,
            };
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
    sessionId?: string,
  ): Promise<string> {
    // Same carrier as the conversation — BYOK summary runs on the user's key.
    // Resolução por sessão/chamada + token só no gerido: ver o comentário em
    // runCompactViaSDK (auditoria BYOK 05-08, mesmo par de fugas).
    const { snapshot: byokSnapshot, byokActive } =
      resolveByokSnapshotForSession(sessionId);
    let client: OpenAI | null;
    if (byokActive && byokSnapshot) {
      client = await this.buildByokClient(byokSnapshot);
    } else {
      const authToken = await FirebaseAuthService.getInstance().getIdToken();
      if (!authToken) return mechanicalFallback(messages);
      client = createAgentClient(authToken, { maxRetries: 0, timeout: 60_000 });
    }
    if (!client) return mechanicalFallback(messages); // BYOK key missing
    const model = byokActive && byokSnapshot ? byokSnapshot.modelId : "tm-active-model";
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

    // Headers TM só no caminho gerido (ver runCompactViaSDK).
    const extraHeaders: Record<string, string> | undefined =
      !byokActive && this.requestType
        ? { "X-Request-Type": this.requestType }
        : undefined;

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
