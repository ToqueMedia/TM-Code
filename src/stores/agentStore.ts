import { create } from "zustand";
import { AgentStatus, type CompactPhase } from "../types/agent";

export type AgentTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTask {
  id: string;
  description: string;
  status: AgentTaskStatus;
  /** IDs of tasks that must complete before this one can start. */
  dependsOn?: string[];
  /** IDs of tasks currently blocking this one (stuck dependencies). */
  blockedBy?: string[];
  /** Files involved in this task — for prompt context and UI affordances. */
  files?: string[];
  /** How this task's acceptance criterion was verified (test output,
   *  endpoint response, build/typecheck pass). Required by `update_tasks`
   *  when flipping a task to `completed` — filesystem existence does not
   *  count. Persisted as an audit trail of why each task was marked done. */
  evidence?: string;
  /**
   * Multi-writer item board (Fase 6b residual): which agent owns this item.
   * `main` = interactive run; otherwise a parallel/session task id or a
   * stable session label. Empty/undefined = unclaimed (any agent may work).
   */
  claimedBy?: string | null;
  /** Epoch ms when the claim was taken (for UI + cross-window board). */
  claimedAt?: number | null;
}

interface AgentState {
  status: AgentStatus;
  compactPhase: CompactPhase;
  error: string | null;
  /** Latest non-model status emitted by the proxy/worker while awaiting upstream progress. */
  workerStatus: string | null;
  /**
   * TRACKER POR-SESSÃO (sem-deus, 2026-07-18): cada sessão tem o SEU tracker —
   * o "main" é apenas mais um sessionId, sem estatuto especial. Uma tarefa
   * paralela que chama update_tasks escreve no SEU balde, nunca no do chat
   * principal (era por isso que update_tasks estava excluída das tarefas).
   * Fonte de verdade única. `tasks` abaixo é só um espelho da sessão focada.
   */
  tasksBySession: Record<string, AgentTask[]>;
  /** Sessão cujo tracker está EM FOCO (a que o user está a ver). O espelho
   *  `tasks` segue-a; muda em focusTrackerSession (troca de sessão/vista). */
  focusedTrackerSessionId: string | null;
  /**
   * Espelho SÓ-LEITURA do tracker da sessão focada (= tasksBySession[focused]).
   * Existe para os leitores da UI (AgentTasksPanel/StatusBar/ToolCallDisplay)
   * continuarem a subscrever `s.tasks` sem saberem de sessões — mostram sempre
   * a sessão em foco. NÃO escrever aqui diretamente: usar setTasksForSession.
   */
  tasks: AgentTask[];
  /** Model name reported by the backend via X-Model-Name header. */
  modelName: string | null;
  /** Provider name reported by the backend via X-Model-Provider header. */
  modelProvider: string | null;
  /**
   * Reasoning capability of the active model, reported by the backend via
   * X-Model-Thinking-Mode header. Authoritative source for the toggle's
   * visibility — the frontend's per-plan profile is only a fallback for
   * pre-handshake state (before the first response arrives).
   */
  thinkingMode: "none" | "toggleable" | "mandatory" | null;
  /**
   * Context window size (tokens) reported by the backend via the
   * `X-Model-Context-Window` header. The agent's compression threshold uses
   * this exact value, so surfacing it here keeps the
   * ContextWindowIndicator's percentage in lockstep with reality — instead
   * of reading the plan profile's static value (1M for the GLM shape,
   * which is wrong for any BYOK model with a different window). Null until
   * the first response arrives.
   */
  modelContextWindow: number | null;
  /**
   * Teto de tokens de SAÍDA do modelo ativo, reportado em
   * `X-Model-Max-Output-Tokens`. Irmão do modelContextWindow e pela mesma
   * razão (auditoria 2026-07-28): a janela tinha header, o output não —
   * portanto um modelo novo publicado só no KV herdava o teto do perfil de
   * fallback local (32K) e ficava calado nesse limite mesmo sendo capaz de
   * gerar muito mais. Null até chegar a primeira resposta que o declare.
   */
  modelMaxOutputTokens: number | null;
  /**
   * Capacidades DECLARADAS pelo data-plane (`X-Model-Capabilities`).
   *
   * `null` = o servidor não declarou; quem lê cai no perfil local. Nunca
   * confundir com `false` (declarado como não-suportado). A distinção importa:
   * antes, um modelo que a tabela MODEL_PROFILES não conhecia herdava as flags
   * do perfil de FALLBACK — visão, pensamento e pesquisa de OUTRO modelo — e
   * publicar um modelo novo na KV dava-lhe silenciosamente essas capacidades
   * (auditoria 2026-07-29).
   */
  modelSupportsVision: boolean | null;
  modelSupportsSearch: boolean | null;
  /**
   * Whether the most recent response was actually served via BYOK (the
   * server-side X-BYOK-Active header). This is the authoritative source for
   * the chat-header pill — the byokStore.enabled toggle says what the user
   * configured, but only this header confirms what the server did. Drifts
   * back to false when a non-BYOK request follows a BYOK one.
   */
  byokActive: boolean;
  /**
   * Team BYOK served the most recent response (server-side X-TM-Team-Byok). The
   * team's own provider/key handled it — no TM metering. Like byokActive, drifts
   * back to false when a managed-path request follows.
   */
  teamByokActive: boolean;
  /**
   * Cumulative tool calls across the current agent run. Used by the Phase A
   * tool-call-pattern telemetry to calibrate when critical reminders should
   * be re-injected (Phase C). Reset on session start.
   */
  cumulativeToolCalls: number;
  /**
   * Number of write_file / edit_file / create_file calls since the agent
   * last invoked read_dev_server_logs while a dev server is active.
   * Surfaced so the status bar / debug overlay can flag the agent drifting
   * past the "check logs after writes" rule before it becomes a failure.
   */
  writesWithoutDevServerLogs: number;
}

interface AgentActions {
  setStatus: (status: AgentStatus) => void;
  setCompactPhase: (phase: CompactPhase) => void;
  setError: (error: string | null) => void;
  setWorkerStatus: (status: string | null) => void;
  // Model metadata from backend response headers
  setModelInfo: (
    name: string | null,
    provider: string | null,
    thinkingMode?: "none" | "toggleable" | "mandatory" | null,
    contextWindow?: number | null,
    maxOutputTokens?: number | null,
    capabilities?: { vision?: boolean | null; search?: boolean | null },
  ) => void;
  setByokActive: (active: boolean) => void;
  setTeamByokActive: (active: boolean) => void;
  // Task management (per-sessão)
  /** Foca o tracker de uma sessão (troca de vista); re-espelha `tasks`. */
  focusTrackerSession: (sessionId: string | null) => void;
  /** Escreve o tracker de UMA sessão; re-espelha `tasks` se for a focada. */
  setTasksForSession: (sessionId: string, tasks: AgentTask[]) => void;
  /** Lê o tracker de uma sessão (não-reativo — use getState). */
  getTasksForSession: (sessionId: string) => AgentTask[];
  /** Remove o tracker de uma sessão (novo run/sessão limpa). */
  clearTasksForSession: (sessionId: string) => void;
  /** Atalhos ligados à sessão FOCADA (compat + main). */
  setTasks: (tasks: AgentTask[]) => void;
  clearTasks: () => void;
  // Tool-call pattern counters (Phase A)
  bumpCumulativeToolCalls: (delta: number) => void;
  setWritesWithoutDevServerLogs: (n: number) => void;
  resetToolCallCounters: () => void;
  resetTransientState: () => void;
  reset: () => void;
}

export const useAgentStore = create<AgentState & AgentActions>()((set, get) => ({
  status: "idle",
  compactPhase: "idle",
  error: null,
  workerStatus: null,
  tasksBySession: {},
  focusedTrackerSessionId: null,
  tasks: [],
  modelName: null,
  modelProvider: null,
  thinkingMode: null,
  modelContextWindow: null,
  modelMaxOutputTokens: null,
  modelSupportsVision: null,
  modelSupportsSearch: null,
  byokActive: false,
  teamByokActive: false,
  cumulativeToolCalls: 0,
  writesWithoutDevServerLogs: 0,

  setStatus: (status: AgentStatus) => {
    set({ status });
  },

  setCompactPhase: (phase: CompactPhase) => {
    set({ compactPhase: phase });
  },

  setError: (error: string | null) => {
    set({ error });
  },

  setWorkerStatus: (workerStatus: string | null) => {
    set({ workerStatus });
  },

  setModelInfo: (name, provider, thinkingMode, contextWindow, maxOutputTokens, capabilities) => {
    set({
      modelName: name,
      modelProvider: provider,
      // Only overwrite thinkingMode when the caller actually passed one — keeps
      // a stale value alive across handshake-less updates rather than wiping
      // the toggle every refresh.
      ...(thinkingMode !== undefined ? { thinkingMode } : {}),
      // Same opt-in pattern for context window — only updates when the
      // caller provided a value (null is treated as "clear", undefined as
      // "leave alone"). Lets one header (X-Model-Context-Window) drive
      // both the agent's threshold AND the indicator pill from a single
      // source of truth.
      ...(contextWindow !== undefined
        ? { modelContextWindow: contextWindow }
        : {}),
      // Mesmo padrão opt-in do contextWindow.
      ...(maxOutputTokens !== undefined
        ? { modelMaxOutputTokens: maxOutputTokens }
        : {}),
      // Idem para as capacidades: `undefined` não toca, `null` limpa (volta a
      // "o servidor não declarou" → perfil local), booleano manda.
      ...(capabilities?.vision !== undefined ? { modelSupportsVision: capabilities.vision } : {}),
      ...(capabilities?.search !== undefined ? { modelSupportsSearch: capabilities.search } : {}),
    });
  },

  setByokActive: (active: boolean) => {
    set({ byokActive: active });
  },

  setTeamByokActive: (active: boolean) => {
    set({ teamByokActive: active });
  },

  focusTrackerSession: (sessionId: string | null) => {
    set((state) => ({
      focusedTrackerSessionId: sessionId,
      tasks: sessionId ? state.tasksBySession[sessionId] ?? [] : [],
    }));
  },

  setTasksForSession: (sessionId: string, tasks: AgentTask[]) => {
    if (!sessionId) return;
    set((state) => ({
      tasksBySession: { ...state.tasksBySession, [sessionId]: tasks },
      // Espelha só quando a sessão escrita é a que está em foco — escrever no
      // balde de uma tarefa de fundo não deve mexer no que o user vê.
      ...(sessionId === state.focusedTrackerSessionId ? { tasks } : {}),
    }));
  },

  getTasksForSession: (sessionId: string) => {
    return get().tasksBySession[sessionId] ?? [];
  },

  clearTasksForSession: (sessionId: string) => {
    if (!sessionId) return;
    set((state) => {
      const next = { ...state.tasksBySession };
      delete next[sessionId];
      return {
        tasksBySession: next,
        ...(sessionId === state.focusedTrackerSessionId ? { tasks: [] } : {}),
      };
    });
  },

  // Atalhos ligados à sessão focada (compat: main + caminhos que não passam
  // sessionId explícito). No-op silencioso sem foco — o foco é sempre posto
  // no carregamento do projeto / troca de sessão.
  setTasks: (tasks: AgentTask[]) => {
    const sid = get().focusedTrackerSessionId;
    if (sid) get().setTasksForSession(sid, tasks);
    else set({ tasks });
  },

  clearTasks: () => {
    const sid = get().focusedTrackerSessionId;
    if (sid) get().clearTasksForSession(sid);
    else set({ tasks: [] });
  },


  bumpCumulativeToolCalls: (delta: number) => {
    if (delta <= 0) return;
    set((state) => ({
      cumulativeToolCalls: state.cumulativeToolCalls + delta,
    }));
  },

  setWritesWithoutDevServerLogs: (n: number) => {
    set({ writesWithoutDevServerLogs: Math.max(0, n) });
  },

  resetToolCallCounters: () => {
    set({ cumulativeToolCalls: 0, writesWithoutDevServerLogs: 0 });
  },

  resetTransientState: () => {
    set({
      status: "idle",
      compactPhase: "idle",
      error: null,
      workerStatus: null,
      // A identidade do modelo NÃO é estado transiente (2026-07-29).
      //
      // Isto anulava modelName/modelContextWindow/modelMaxOutputTokens na
      // troca de projecto — mas o modelo gerido é global, não por projecto, e
      // estes campos só se repovoam com a PRÓXIMA resposta do worker
      // (X-Model-Context-Window). Sem próxima resposta — créditos esgotados,
      // por exemplo — a pill caía no FALLBACK de 200K e mostrava "252%
      // (overrun) / Compaction is overdue" para um modelo cuja janela real é
      // 1M (screenshot katondo, 29-07). E o save da sessão nesse estado
      // persistia um snapshot sem janela, envenenando o restore.
      //
      // A identidade fica; quando um modelo diferente responder, o update
      // opt-in (setModelInfo) substitui-a — que é o único momento em que ela
      // muda de facto. byokActive é decisão por sessão e esse continua a
      // limpar-se.
      byokActive: false,
      teamByokActive: false,
      cumulativeToolCalls: 0,
      writesWithoutDevServerLogs: 0,
    });
  },

  reset: () => {
    set({
      status: "idle",
      compactPhase: "idle",
      error: null,
      workerStatus: null,
      tasksBySession: {},
      focusedTrackerSessionId: null,
      tasks: [],
      modelName: null,
      modelProvider: null,
      thinkingMode: null,
      modelContextWindow: null,
      modelMaxOutputTokens: null,
  modelSupportsVision: null,
  modelSupportsSearch: null,
      byokActive: false,
      teamByokActive: false,
          cumulativeToolCalls: 0,
      writesWithoutDevServerLogs: 0,
    });
  },
}));
