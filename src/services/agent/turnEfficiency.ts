/**
 * Turn-efficiency measurement — infers WHY the agent loop continued past the
 * 3-4-request efficiency target for localized fixes.
 *
 * WHY THIS EXISTS
 * ─────────────
 * A simple bugfix that burns 7 provider round-trips without a technical reason
 * is a defect, not thoroughness. But the loop must NEVER block on turn count
 * alone — sometimes you genuinely need 6 turns (build cascade, tool failure,
 * discovered dependency). This module infers the continuation reason from what
 * actually happened in the turn so the loop can LOG it for debugging without
 * hard-blocking.
 *
 * DESIGN: structural signals only, no text/regex matching
 * ────────────────────────────────────────────────────────
 * The inference uses ONLY two structural facts the loop already knows:
 *   1. Which tools were called (by name — a stable enum, not free text).
 *   2. Whether each result flagged `isError: true` (a boolean the toolExecutor
 *      sets deterministically — exit code ≠ 0 for execute_command, exception
 *      thrown for others).
 *
 * It deliberately does NOT parse the result text for keywords like "error" or
 * "failed". Keyword matching is a gambiarra: compiler/linter/test-runner output
 * formats vary across providers and languages, new error phrasings silently
 * produce false negatives ("timeout", "segfault", "permission denied"), and
 * the keyword list rots without a test catching it. The `isError` boolean is
 * the toolExecutor's authoritative signal — it already did the work of
 * deciding whether the command failed; re-deriving that from text duplicates
 * the decision with a worse algorithm.
 *
 * The inferred reason is surfaced in two places:
 *   1. console.debug in query.ts when turnCount exceeds the target.
 *   2. The PayloadReport's `continuationReason` field (shown in the
 *      payload-inspector log + session export).
 *
 * Pure function — no imports beyond types — so it's unit-testable in isolation.
 */

/** Minimal snapshot of what happened in one turn. */
export interface TurnSnapshot {
  /** Tools the model called this turn (name only — args are irrelevant here). */
  toolCalls: ReadonlyArray<{ name: string }>
  /** Results of those tool calls. */
  toolResults: ReadonlyArray<{ content: string; isError: boolean }>
}

/** The efficiency target for localized fixes (guidance, not a hard limit). */
export const EFFICIENCY_TARGET_TURNS = 4

/** Tool names that indicate information-gathering (insufficient context). */
const READ_TOOLS = new Set([
  'read_file', 'read_around', 'search_files', 'glob', 'list_directory', 'read_large_result',
  'Read', 'Grep', 'Glob', 'LS',
  'read_skill', 'read_dev_server_logs',
])

/** Tool names that produce file edits. */
const EDIT_TOOLS = new Set([
  'edit_file', 'write_file', 'create_file',
])

/** Research/external-context gathering — legítimo como o READ local, mas contra
 *  fontes externas. Sem isto, uma ronda de pesquisa caía no fallback "sem razão
 *  técnica" (falso positivo — a auditoria momenu). */
const RESEARCH_TOOLS = new Set([
  'web_fetch', 'web_search', 'capture_url_design',
])

/** Monitorização de trabalho assíncrono (comandos/agentes em background) —
 *  verificação legítima, equivalente ao execute_command síncrono. */
const MONITOR_TOOLS = new Set([
  'agent_shell_start', 'agent_shell_read', 'agent_shell_stop',
  'check_background_commands', 'check_background_agents',
])

/** Bookkeeping — marcar progresso no tracker ou na memória. É progresso real
 *  (não giro improdutivo); classificá-lo como "sem razão" treinava o modelo a
 *  ignorar o nudge. */
const PROGRESS_TOOLS = new Set([
  'update_tasks',
  'update_session_memory', 'write_memory', 'update_memory', 'save_memory',
])

/**
 * Infer the technical reason the loop continued past the efficiency target.
 *
 * Uses ONLY structural signals (tool names + isError booleans). The order
 * matters: a tool failure is classified by WHICH tool failed (edit vs command
 * vs other), not by parsing its output text. The fallback "no clear technical
 * reason" is the signal that the agent is likely over-working a simple task.
 */
export function inferContinuationReason(snapshot: TurnSnapshot): string {
  const { toolCalls, toolResults } = snapshot
  const toolNames = toolCalls.map((tc) => tc.name)

  // 1. Tool failure — any result flagged as error. Classify by WHICH tool
  //    errored, using only the tool name (structural), not the result text.
  const hasError = toolResults.some((r) => r.isError)
  if (hasError) {
    if (toolNames.includes('execute_command')) {
      return 'build/test/command error — fixing cascade'
    }
    if (toolNames.some((n) => EDIT_TOOLS.has(n))) {
      return 'edit failed — retrying with corrected content'
    }
    return 'tool failure — recovering'
  }

  // 1b. Edições aplicadas com sucesso — é O trabalho, não giro.
  //     BUG (auditoria 2026-07-28): EDIT_TOOLS só era consultado no ramo de
  //     ERRO acima, portanto um turn de edições BEM-SUCEDIDAS caía no fallback
  //     "sem razão técnica" e, ao fim de 3 turns seguidos, injetava o nudge de
  //     wrap-up no meio da implementação — exatamente quando o agente estava a
  //     entregar. Também envenenava o continuationReason da telemetria.
  if (toolNames.some((n) => EDIT_TOOLS.has(n))) {
    return 'applying edits'
  }

  // 2. Successful command run — the agent ran a build/test/lint and it
  //    passed (isError would have been true above if it hadn't).
  if (toolNames.includes('execute_command')) {
    return 'verifying via command'
  }

  // 3. Insufficient context — the turn was spent reading/gathering info.
  if (toolNames.some((n) => READ_TOOLS.has(n))) {
    return 'insufficient context — gathering information'
  }

  // 3b. Research — gathering external context (web/design). Legítimo como o
  //     READ local; sem este ramo caía no fallback (falso positivo).
  if (toolNames.some((n) => RESEARCH_TOOLS.has(n))) {
    return 'researching — gathering external context'
  }

  // 3c. Monitoring — checking background commands/agents. Verificação legítima
  //     de trabalho assíncrono (equivalente ao execute_command síncrono).
  if (toolNames.some((n) => MONITOR_TOOLS.has(n))) {
    return 'monitoring background work'
  }

  // 4. Ambiguity — the agent asked the developer a question OR requested a
  //    credential (ambos ficam à espera do humano — não é giro improdutivo).
  if (toolNames.includes('ask_user_question') || toolNames.includes('request_credentials')) {
    return 'ambiguity — clarifying with developer'
  }

  // 5. Sub-agent dispatched — delegate/collect_results.
  if (toolNames.includes('delegate') || toolNames.includes('collect_results')) {
    return 'sub-agent dispatched — collecting results'
  }

  // 5b. Bookkeeping — tracker/memória. Progresso real, não giro.
  if (toolNames.some((n) => PROGRESS_TOOLS.has(n))) {
    return 'bookkeeping — tracking progress'
  }

  // 5c. External tool action — MCP ou browser. Ação legítima fora do editor.
  if (toolNames.some((n) => n.startsWith('mcp__') || n === 'browser_action')) {
    return 'external tool action'
  }

  // 6. No tool calls at all (continuation via steering/max_tokens) — unusual
  //    past the target; flag as no clear reason.
  if (toolCalls.length === 0) {
    return 'no tool calls — continued via steering or max_tokens recovery'
  }

  // Fallback: the turn produced tool calls but none fit a recognized
  // continuation pattern (progress, recovery, research, verification, waiting
  // on a human, delegation, bookkeeping, external action). This narrowed
  // fallback is the "consider wrapping up" signal — after 3b–5c, a turn here is
  // genuinely spinning, not a misclassified productive category.
  return 'no clear technical reason — consider wrapping up'
}

/**
 * True when the reason represents a legitimate technical continuation
 * (as opposed to the "no clear reason" fallback). Used by the caller to
 * decide warning severity.
 */
export function isLegitimateContinuationReason(reason: string): boolean {
  return !reason.startsWith('no clear technical reason') &&
    !reason.startsWith('no tool calls')
}

// ── Nudge de eficiência (inter-turn) ─────────────────────────────────────────
//
// PORQUÊ: na auditoria de 2026-07-22 (sessão momenu-fact) o loop marcou
// "no clear technical reason" 24 vezes num run de 151 requests — e o modelo
// nunca viu nenhuma delas, porque o sinal ia só para console.debug. O prompt
// tinha uma secção "When you exceed 4 requests" que o modelo ignorou; o
// claude-vaz não tem NENHUM pacing numérico no prompt (a única âncora
// numérica é um experimento ant-only) — o padrão dele é feedback ESTRUTURAL
// injetado no contexto entre turnos (system-reminder isMeta, canal dos
// stop-hooks/todo-reminders). Este módulo decide QUANDO injetar; o query loop
// injeta via o mesmo caminho dos inter-turn attachments.
//
// Disciplina de throttle (porte do todo-reminder do claude-vaz, que exige
// ≥10 turnos desde o último TodoWrite E ≥10 desde o último reminder):
//   - só dispara após CONSECUTIVE_NO_REASON rondas seguidas sem razão
//     técnica (uma ronda legítima zera a contagem — um build error no meio
//     de exploração improdutiva ainda é progresso);
//   - nudges seguintes exigem TURNS_BETWEEN_NUDGES rondas de distância
//     (anti-spam; repetir o reminder todos os turnos só queima contexto).
// Continua a NUNCA bloquear — o nudge informa, o modelo decide.

export const EFFICIENCY_NUDGE_CONFIG = {
  /** Rondas consecutivas sem razão técnica clara antes de nudgar. */
  CONSECUTIVE_NO_REASON: 3,
  /** Distância mínima (em rondas) entre nudges. */
  TURNS_BETWEEN_NUDGES: 10,
} as const

export interface EfficiencyNudgeState {
  consecutiveNoReason: number
  lastNudgeTurn: number
  nudgeCount: number
}

export function createEfficiencyNudgeState(): EfficiencyNudgeState {
  return { consecutiveNoReason: 0, lastNudgeTurn: 0, nudgeCount: 0 }
}

/**
 * Regista a razão de continuação desta ronda e decide se ela dispara o
 * nudge. Muta `state` (contadores) e devolve true exatamente na ronda em
 * que o caller deve injetar `buildEfficiencyNudgeText`. Sem side-effects
 * além do estado passado — testável em isolamento.
 */
export function trackEfficiencyNudge(
  state: EfficiencyNudgeState,
  reason: string,
  turnCount: number,
): boolean {
  if (isLegitimateContinuationReason(reason)) {
    state.consecutiveNoReason = 0
    return false
  }
  state.consecutiveNoReason += 1
  if (state.consecutiveNoReason < EFFICIENCY_NUDGE_CONFIG.CONSECUTIVE_NO_REASON) return false
  // O primeiro nudge não espera pela distância (lastNudgeTurn=0 tornaria a
  // condição vazia em runs curtos); os seguintes respeitam o intervalo.
  const farEnough = state.nudgeCount === 0 ||
    turnCount - state.lastNudgeTurn >= EFFICIENCY_NUDGE_CONFIG.TURNS_BETWEEN_NUDGES
  if (!farEnough) return false
  state.consecutiveNoReason = 0
  state.lastNudgeTurn = turnCount
  state.nudgeCount += 1
  return true
}

/**
 * Texto do nudge — factos estruturais + instrução de consolidar, no formato
 * system-reminder que o system prompt já explica ao modelo. Maneirismos do
 * claude-vaz preservados de propósito: "ignore if not applicable" (o sinal é
 * heurístico, trabalho legítimo pode continuar) e "never mention" (o
 * developer não deve ver o mecanismo refletido na prosa do agente).
 */
export function buildEfficiencyNudgeText(turnCount: number): string {
  return `<system-reminder>
Turn-efficiency check: this run is now ${turnCount} provider rounds in, and the last ${EFFICIENCY_NUDGE_CONFIG.CONSECUTIVE_NO_REASON} rounds had no clear technical reason to continue (no error being fixed, no verification pending, no new information required). If you already know what the outcome is, consolidate and finish now — apply the change or deliver your conclusion. If you are stuck or the task is ambiguous, ask the developer instead of exploring further. This is an automated structural signal, not a message from the developer — ignore it if the continued work is genuinely necessary, and never mention this reminder in your user-facing text.
</system-reminder>`
}
