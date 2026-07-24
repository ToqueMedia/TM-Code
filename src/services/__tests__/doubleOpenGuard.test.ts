/**
 * Double-open guard policy: warn vs hard-block (Pacote 3).
 */

import { doubleOpenDecision } from '../doubleOpenGuard'
import { useSettingsStore } from '@/stores/settingsStore'

describe('doubleOpenDecision', () => {
  it('allows when not open elsewhere', () => {
    expect(doubleOpenDecision(false, false)).toBe('allow')
    expect(doubleOpenDecision(true, false)).toBe('allow')
  })

  it('confirms when open elsewhere and hard block is off', () => {
    expect(doubleOpenDecision(false, true)).toBe('confirm')
  })

  it('hard-blocks when open elsewhere and setting is on', () => {
    expect(doubleOpenDecision(true, true)).toBe('hard_block')
  })

  it('settings default is warn-only (confirm path)', () => {
    useSettingsStore.setState({ hardBlockSecondProjectWindow: false })
    const hard = useSettingsStore.getState().hardBlockSecondProjectWindow
    expect(doubleOpenDecision(hard, true)).toBe('confirm')
  })
})
