/**
 * Background command auto-wake policy.
 *
 * Session momenu-fact 2026-07-24: yarn deploy failed (TS2739) but the agent
 * was not woken because the tracker was auto-closed on turn end. Policy:
 *   - failure → always wake
 *   - success + open tasks → wake
 *   - success + empty tracker → no wake
 */

import {
  shouldWakeForBackgroundCommands,
  type BackgroundCommandWake,
} from '../backgroundCommands/autoWake'

function cmd(
  status: BackgroundCommandWake['status'],
  exitCode: number | null = status === 'completed' ? 0 : 1,
): BackgroundCommandWake {
  return {
    id: 'cmd-1',
    command: 'yarn deploy',
    status,
    exitCode,
  }
}

describe('shouldWakeForBackgroundCommands', () => {
  it('ALWAYS wakes on failure even with empty tracker (deploy/build error case)', () => {
    const d = shouldWakeForBackgroundCommands([cmd('error', 1)], 0)
    expect(d.wake).toBe(true)
    expect(d.reason).toBe('failure')
  })

  it('wakes on failure even when tracker has open tasks', () => {
    const d = shouldWakeForBackgroundCommands([cmd('error', 2)], 3)
    expect(d.wake).toBe(true)
    expect(d.reason).toBe('failure')
  })

  it('wakes on success when tracker still has open work', () => {
    const d = shouldWakeForBackgroundCommands([cmd('completed', 0)], 1)
    expect(d.wake).toBe(true)
    expect(d.reason).toBe('open_tasks')
  })

  it('does NOT wake on success when tracker is empty (final report)', () => {
    const d = shouldWakeForBackgroundCommands([cmd('completed', 0)], 0)
    expect(d.wake).toBe(false)
    expect(d.reason).toBe('no_open_tasks_success')
  })

  it('does NOT wake on cancel alone with empty tracker', () => {
    const d = shouldWakeForBackgroundCommands([cmd('cancelled', null)], 0)
    expect(d.wake).toBe(false)
  })

  it('wakes on cancel when tracker has open work', () => {
    const d = shouldWakeForBackgroundCommands([cmd('cancelled', null)], 2)
    expect(d.wake).toBe(true)
    expect(d.reason).toBe('open_tasks')
  })

  it('failure in a mixed batch forces wake (success + fail)', () => {
    const d = shouldWakeForBackgroundCommands(
      [cmd('completed', 0), { ...cmd('error', 1), id: 'cmd-2' }],
      0,
    )
    expect(d.wake).toBe(true)
    expect(d.reason).toBe('failure')
  })
})

export {}
