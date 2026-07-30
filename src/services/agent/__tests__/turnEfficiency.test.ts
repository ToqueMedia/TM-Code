/**
 * Tests for turn-efficiency measurement — inferContinuationReason.
 *
 * Verifies that the loop can distinguish legitimate technical continuations
 * (build error, tool failure, insufficient context, edit failed) from
 * unjustified ones (no clear reason), using ONLY structural signals
 * (tool names + isError booleans) — no text/regex matching.
 */

import {
  inferContinuationReason,
  isLegitimateContinuationReason,
  EFFICIENCY_TARGET_TURNS,
  EFFICIENCY_NUDGE_CONFIG,
  createEfficiencyNudgeState,
  trackEfficiencyNudge,
  buildEfficiencyNudgeText,
  TASK_TRACKER_REMINDER_CONFIG,
  createTaskTrackerReminderState,
  shouldRemindTaskTracker,
  buildTaskTrackerReminderText,
  type TurnSnapshot,
} from '../turnEfficiency'

describe('inferContinuationReason', () => {
  it('flags a generic tool failure', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'delegate' }],
      toolResults: [{ content: 'sub-agent crashed', isError: true }],
    })
    expect(reason).toBe('tool failure — recovering')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  it('qualifies an edit_file failure specifically', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'edit_file' }],
      toolResults: [{ content: 'old_string not found', isError: true }],
    })
    expect(reason).toBe('edit failed — retrying with corrected content')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  it('classifies execute_command failure as build/test error (isError, not text)', () => {
    // No keyword matching — the toolExecutor's isError boolean is the signal.
    // The output text is irrelevant; even "timeout" or "segfault" classify
    // correctly because isError is the structural signal.
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'execute_command' }],
      toolResults: [{ content: 'timeout', isError: true }],
    })
    expect(reason).toBe('build/test/command error — fixing cascade')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  it('classifies a segfault exit as build/test error without keyword matching', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'execute_command' }],
      toolResults: [{ content: 'Segmentation fault (core dumped)', isError: true }],
    })
    expect(reason).toBe('build/test/command error — fixing cascade')
  })

  it('classifies a successful command run as "verifying via command"', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'execute_command' }],
      toolResults: [{ content: 'All tests passed. 12/12', isError: false }],
    })
    expect(reason).toBe('verifying via command')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  it('classifies read-only turns as "insufficient context"', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'read_file' }, { name: 'search_files' }],
      toolResults: [
        { content: 'file contents here', isError: false },
        { content: '3 matches found', isError: false },
      ],
    })
    expect(reason).toBe('insufficient context — gathering information')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  it('classifies ask_user_question as "ambiguity"', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'ask_user_question' }],
      toolResults: [{ content: 'user answered: use option B', isError: false }],
    })
    expect(reason).toBe('ambiguity — clarifying with developer')
  })

  it('classifies delegate as "sub-agent dispatched"', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'delegate' }],
      toolResults: [{ content: 'Explore task started', isError: false }],
    })
    expect(reason).toBe('sub-agent dispatched — collecting results')
  })

  // NOTE (2026-07): the 'classifies provision_* as "platform provisioning"'
  // test was removed with the MANAGED-PLATFORM layer — inferContinuationReason
  // no longer has a provisioning category; provision_* calls now fall through
  // to the generic patterns below.

  it('flags "no clear technical reason" for genuinely unrecognised tool patterns', () => {
    // Uma tool que não cai em nenhuma categoria produtiva (research, monitor,
    // bookkeeping, external…) — o fallback estreitado só dispara aqui.
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'some_unrecognised_tool' }],
      toolResults: [{ content: 'done', isError: false }],
    })
    expect(reason).toBe('no clear technical reason — consider wrapping up')
    expect(isLegitimateContinuationReason(reason)).toBe(false)
  })

  it('classifies successful edits as "applying edits" (nunca wrap-up a meio da entrega)', () => {
    // Auditoria 2026-07-28: EDIT_TOOLS só era consultado no ramo de ERRO, por
    // isso um turn de edições BEM-SUCEDIDAS caía no fallback e, ao fim de 3
    // seguidos, injetava o nudge de wrap-up no meio da implementação.
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'edit_file' }, { name: 'write_file' }],
      toolResults: [
        { content: 'File updated: /a.ts', isError: false },
        { content: 'File written: /b.ts', isError: false },
      ],
    })
    expect(reason).toBe('applying edits')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  // ── Categorias produtivas que ANTES caíam no fallback (falsos positivos
  //    da auditoria momenu) e agora são reconhecidas como legítimas ──
  it('classifies update_tasks/memória as "bookkeeping" (progresso, não giro)', () => {
    for (const name of ['update_tasks', 'update_session_memory', 'write_memory']) {
      const reason = inferContinuationReason({
        toolCalls: [{ name }],
        toolResults: [{ content: 'ok', isError: false }],
      })
      expect(reason).toBe('bookkeeping — tracking progress')
      expect(isLegitimateContinuationReason(reason)).toBe(true)
    }
  })

  it('classifies web_fetch/web_search as "researching"', () => {
    for (const name of ['web_fetch', 'web_search', 'capture_url_design']) {
      const reason = inferContinuationReason({
        toolCalls: [{ name }],
        toolResults: [{ content: 'fetched', isError: false }],
      })
      expect(reason).toBe('researching — gathering external context')
      expect(isLegitimateContinuationReason(reason)).toBe(true)
    }
  })

  it('classifies background monitoring as "monitoring background work"', () => {
    for (const name of ['agent_shell_read', 'check_background_commands', 'check_background_agents']) {
      const reason = inferContinuationReason({
        toolCalls: [{ name }],
        toolResults: [{ content: 'still running', isError: false }],
      })
      expect(reason).toBe('monitoring background work')
      expect(isLegitimateContinuationReason(reason)).toBe(true)
    }
  })

  it('classifies request_credentials as "ambiguity" (à espera do humano)', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'request_credentials' }],
      toolResults: [{ content: 'form shown', isError: false }],
    })
    expect(reason).toBe('ambiguity — clarifying with developer')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  it('classifies an MCP tool call as "external tool action"', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'mcp__github__create_issue' }],
      toolResults: [{ content: 'issue #12 created', isError: false }],
    })
    expect(reason).toBe('external tool action')
    expect(isLegitimateContinuationReason(reason)).toBe(true)
  })

  it('flags "no tool calls" for steering/max_tokens continuations', () => {
    const reason = inferContinuationReason({
      toolCalls: [],
      toolResults: [],
    })
    expect(reason).toBe('no tool calls — continued via steering or max_tokens recovery')
    expect(isLegitimateContinuationReason(reason)).toBe(false)
  })

  it('classifies execute_command error as build/test even when edit_file also ran', () => {
    // When both ran and one errored, execute_command takes precedence
    // (a failed build after an edit is the classic cascade scenario).
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'edit_file' }, { name: 'execute_command' }],
      toolResults: [
        { content: 'diff applied', isError: false },
        { content: 'tsc exited with 1', isError: true },
      ],
    })
    expect(reason).toBe('build/test/command error — fixing cascade')
  })

  it('EFFICIENCY_TARGET_TURNS is 4', () => {
    expect(EFFICIENCY_TARGET_TURNS).toBe(4)
  })

  it('empty snapshot returns a non-legitimate reason', () => {
    const snapshot: TurnSnapshot = { toolCalls: [], toolResults: [] }
    const reason = inferContinuationReason(snapshot)
    expect(isLegitimateContinuationReason(reason)).toBe(false)
  })
})

describe('task-tracker reconciliation reminder', () => {
  it('waits for the configured cadence after a successful mutation', () => {
    const state = createTaskTrackerReminderState()
    expect(shouldRemindTaskTracker(state, {
      turnCount: TASK_TRACKER_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS - 1,
      lastTaskUpdateTurn: 0,
      writesSinceTaskUpdate: 1,
      unfinishedTaskCount: 1,
    })).toBe(false)
    expect(shouldRemindTaskTracker(state, {
      turnCount: TASK_TRACKER_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
      lastTaskUpdateTurn: 0,
      writesSinceTaskUpdate: 1,
      unfinishedTaskCount: 1,
    })).toBe(true)
  })

  it('does not remind read-only work or a tracker with no unfinished tasks', () => {
    const state = createTaskTrackerReminderState()
    expect(shouldRemindTaskTracker(state, {
      turnCount: 20,
      lastTaskUpdateTurn: 0,
      writesSinceTaskUpdate: 0,
      unfinishedTaskCount: 3,
    })).toBe(false)
    expect(shouldRemindTaskTracker(state, {
      turnCount: 20,
      lastTaskUpdateTurn: 0,
      writesSinceTaskUpdate: 2,
      unfinishedTaskCount: 0,
    })).toBe(false)
  })

  it('resets its cadence after update_tasks and throttles repeated reminders', () => {
    const state = createTaskTrackerReminderState()
    expect(shouldRemindTaskTracker(state, {
      turnCount: 10,
      lastTaskUpdateTurn: 0,
      writesSinceTaskUpdate: 1,
      unfinishedTaskCount: 2,
    })).toBe(true)
    expect(shouldRemindTaskTracker(state, {
      turnCount: 19,
      lastTaskUpdateTurn: 10,
      writesSinceTaskUpdate: 1,
      unfinishedTaskCount: 2,
    })).toBe(false)
    expect(shouldRemindTaskTracker(state, {
      turnCount: 20,
      lastTaskUpdateTurn: 10,
      writesSinceTaskUpdate: 1,
      unfinishedTaskCount: 2,
    })).toBe(true)
  })

  it('uses a system reminder that reports only structural facts', () => {
    const text = buildTaskTrackerReminderText(2, 3)
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text.trimEnd().endsWith('</system-reminder>')).toBe(true)
    expect(text).toContain('2 file mutations')
    expect(text).toContain('3 unfinished tasks remain')
    expect(text).toContain('never mention this reminder')
  })
})

describe('trackEfficiencyNudge — decisor do nudge inter-turn', () => {
  const NO_REASON = 'no clear technical reason — consider wrapping up'
  const LEGIT = 'build/test/command error — fixing cascade'

  it('dispara exatamente na N-ésima ronda consecutiva sem razão, não antes', () => {
    const state = createEfficiencyNudgeState()
    const fired: boolean[] = []
    for (let turn = 5; turn < 5 + EFFICIENCY_NUDGE_CONFIG.CONSECUTIVE_NO_REASON; turn++) {
      fired.push(trackEfficiencyNudge(state, NO_REASON, turn))
    }
    expect(fired.slice(0, -1).every((f) => !f)).toBe(true)
    expect(fired[fired.length - 1]).toBe(true)
    expect(state.nudgeCount).toBe(1)
  })

  it('uma ronda legítima no meio zera a contagem consecutiva', () => {
    const state = createEfficiencyNudgeState()
    expect(trackEfficiencyNudge(state, NO_REASON, 5)).toBe(false)
    expect(trackEfficiencyNudge(state, NO_REASON, 6)).toBe(false)
    expect(trackEfficiencyNudge(state, LEGIT, 7)).toBe(false)
    // Recomeça do zero — precisa de novo de N consecutivas.
    expect(trackEfficiencyNudge(state, NO_REASON, 8)).toBe(false)
    expect(trackEfficiencyNudge(state, NO_REASON, 9)).toBe(false)
    expect(trackEfficiencyNudge(state, NO_REASON, 10)).toBe(true)
  })

  it('"no tool calls" também conta como não-legítima', () => {
    const state = createEfficiencyNudgeState()
    const reason = 'no tool calls — continued via steering or max_tokens recovery'
    let turn = 5
    for (let i = 0; i < EFFICIENCY_NUDGE_CONFIG.CONSECUTIVE_NO_REASON - 1; i++) {
      expect(trackEfficiencyNudge(state, reason, turn++)).toBe(false)
    }
    expect(trackEfficiencyNudge(state, reason, turn)).toBe(true)
  })

  it('throttle: o 2º nudge respeita TURNS_BETWEEN_NUDGES', () => {
    const state = createEfficiencyNudgeState()
    // 1º nudge nos turns 5-7.
    let turn = 5
    for (let i = 0; i < EFFICIENCY_NUDGE_CONFIG.CONSECUTIVE_NO_REASON; i++) {
      trackEfficiencyNudge(state, NO_REASON, turn++)
    }
    expect(state.nudgeCount).toBe(1)
    const firstNudgeTurn = state.lastNudgeTurn

    // Continua sem razão: acumula 3 consecutivas outra vez, mas ainda dentro
    // da janela de throttle — não dispara.
    let fired = false
    while (turn < firstNudgeTurn + EFFICIENCY_NUDGE_CONFIG.TURNS_BETWEEN_NUDGES) {
      fired = trackEfficiencyNudge(state, NO_REASON, turn++)
      expect(fired).toBe(false)
    }
    // Primeira ronda FORA da janela com ≥N consecutivas acumuladas → dispara.
    expect(trackEfficiencyNudge(state, NO_REASON, turn)).toBe(true)
    expect(state.nudgeCount).toBe(2)
  })

  it('o texto do nudge é um system-reminder com os factos estruturais', () => {
    const text = buildEfficiencyNudgeText(17)
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text.trimEnd().endsWith('</system-reminder>')).toBe(true)
    expect(text).toContain('17 provider rounds')
    // Maneirismos claude-vaz: heurístico + invisível na prosa do agente.
    expect(text).toContain('ignore it if the continued work is genuinely necessary')
    expect(text).toContain('never mention this reminder')
  })
})
