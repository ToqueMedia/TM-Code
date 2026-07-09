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

  it('flags "no clear technical reason" for unrecognised tool patterns', () => {
    const reason = inferContinuationReason({
      toolCalls: [{ name: 'update_tasks' }],
      toolResults: [{ content: 'tasks updated', isError: false }],
    })
    expect(reason).toBe('no clear technical reason — consider wrapping up')
    expect(isLegitimateContinuationReason(reason)).toBe(false)
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
