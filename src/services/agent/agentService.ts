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
import { ServiceError } from "../../utils/errors";
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
import { getQueryGuard } from "./queryGuard";
import type { ContentPart } from "../../types/chat";

// ── Query engine ──

import type OpenAI from "openai";
import { createAgentClient, createSubAgentClient } from "./sdkClient";
import { QueryEngine, toQueryMessages } from "./queryEngine";
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
      .then((m) => m.usePermissionStore.getState().resetAutoApprove())
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

    // 2. Create SDK client
    const client = this.lightweightOptions
      ? createSubAgentClient(authToken)
      : createAgentClient(authToken);
    const refreshClient = async (): Promise<OpenAI | null> => {
      const auth = FirebaseAuthService.getInstance();
      const refreshed = await auth.getIdToken(true)
        ?? (await auth.refreshLogin() ? await auth.getIdToken(true) : null);
      if (!refreshed) return null;
      return this.lightweightOptions
        ? createSubAgentClient(refreshed)
        : createAgentClient(refreshed);
    };

    // 3. Build tool definitions in OpenAI format
    const filteredTools = this.tools.filter((t) => {
      if (t.function.name === "web_search") return false; // MiMo doesn't support native search
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

    // 5. Create tool executor bridge
    const executeTool = this.createToolExecutorBridge(callbacks);

    // 6. Build extra headers — X-Request-Type is sticky across turns
    const extraHeaders = this.buildExtraHeaders();

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
      // Usage is reported via message_stop events — do NOT add onUsage
      // callback here or output tokens will be double-counted (SUM semantics).
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
          callbacks.onToolCallPending(event.id, event.name);
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
            this.sessionState.setLastPromptTokens(event.usage.prompt_tokens);
            callbacks.onUsageUpdate(
              event.usage.prompt_tokens,
              event.usage.completion_tokens,
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
    return "tm-active-model";
  }

  /**
   * Streaming responses may expose safe metadata in HTTP headers. The
   * dedicated AI pass-through Worker does not inject billing events into the
   * stream, so missing budget headers are expected.
   */
  private applyStreamingResponseHeaders(headers: Headers): void {
    try {
      useBillingStore.getState().updateFromHeaders(headers);
    } catch {
      /* non-critical */
    }

    try {
      const modelName = headers.get("X-Model-Name");
      const modelProvider = headers.get("X-Model-Provider");
      const thinkingModeRaw = headers.get("X-Model-Thinking-Mode");
      const contextWindowRaw = headers.get("X-Model-Context-Window");
      const byokActiveRaw = headers.get("X-BYOK-Active");

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
    } catch {
      /* non-critical */
    }
  }

  private buildExtraHeaders(): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    if (this.requestType) headers["X-Request-Type"] = this.requestType;
    if (!this.lightweightOptions && useTmSpeedStore.getState().enabled) {
      headers["X-TM-Speed"] = "true";
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  /**
   * The TMS data plane is provider-agnostic. The active provider/model is a
   * Control Plane decision, so the IDE must not send provider-specific thinking
   * fields such as enable_thinking, thinking, or reasoning. Those fields caused
   * strict OpenAI-compatible providers like Gemini to reject otherwise valid
   * requests with 400.
   */
  private buildThinkingConfig(): Record<string, unknown> | undefined {
    return undefined;
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
      // Notify UI that tool execution is starting
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
        const errorMsg = err instanceof Error ? err.message : String(err);
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
      const recentChatMessages: import("@/types/chat").ChatMessage[] =
        recentMessages.map((m) => ({
          id: generateId("msg"),
          role: m.role as "user" | "assistant",
          content:
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content),
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

    const client = createAgentClient(authToken, {
      maxRetries: 0,
      timeout: 60_000,
    });
    const model = this.resolveModel();

    // Build compact prompt
    const { getCompactPrompt } = await import("./compact/prompt");
    const systemPrompt = getCompactPrompt();

    // Filter to text-only content for the compact call
    const compactMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content:
          typeof m.content === "string"
            ? m.content
            : (m.content as ContentBlockAPI[])
                .filter((b) => b.type === "text")
                .map((b) => ({
                  type: "text" as const,
                  text: (b as { type: "text"; text: string }).text,
                })),
      }))
      .filter((m) =>
        typeof m.content === "string"
          ? m.content.length > 0
          : (m.content as any[]).length > 0,
      );

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

    const client = createAgentClient(authToken, {
      maxRetries: 0,
      timeout: 60_000,
    });
    const model = this.resolveModel();
    const { getCompactPrompt } = await import("./compact/prompt");

    const compactMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content:
          typeof m.content === "string"
            ? m.content
            : (m.content as ContentBlockAPI[])
                .filter((b) => b.type === "text")
                .map((b) => ({
                  type: "text" as const,
                  text: (b as { type: "text"; text: string }).text,
                })),
      }))
      .filter((m) =>
        typeof m.content === "string"
          ? m.content.length > 0
          : (m.content as any[]).length > 0,
      );

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
