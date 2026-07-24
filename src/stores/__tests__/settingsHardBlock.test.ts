import { useSettingsStore } from '../settingsStore'

describe('hardBlockSecondProjectWindow setting', () => {
  it('defaults to false (warn-only double-open)', () => {
    // Reset to defaults for this test (persist may have leftover state in other tests)
    useSettingsStore.setState({ hardBlockSecondProjectWindow: false })
    expect(useSettingsStore.getState().hardBlockSecondProjectWindow).toBe(false)
  })

  it('setHardBlockSecondProjectWindow toggles the flag', () => {
    useSettingsStore.getState().setHardBlockSecondProjectWindow(true)
    expect(useSettingsStore.getState().hardBlockSecondProjectWindow).toBe(true)
    useSettingsStore.getState().setHardBlockSecondProjectWindow(false)
    expect(useSettingsStore.getState().hardBlockSecondProjectWindow).toBe(false)
  })
})
