/**
 * e2eService tests — picker preference + ensureTestBrowser fallthrough.
 *
 * Mocks the Tauri invoke so we can drive arbitrary detection results
 * without spawning a real browser scan.
 */

const mockInvoke = jest.fn()
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))

const mockPrompt = jest.fn()
jest.mock('../../stores/e2eStore', () => ({
  useE2EStore: { getState: () => ({ promptBrowserMissing: mockPrompt }) },
}))

import { detectTestBrowsers, pickPreferredBrowser, ensureTestBrowser, type BrowserInfo } from '../e2eService'

const chromeChannel: BrowserInfo = {
  id: 'chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app',
  channel: 'chrome', executable_path: null,
}
const braveExe: BrowserInfo = {
  id: 'brave', name: 'Brave', path: '/Applications/Brave.app',
  channel: null, executable_path: '/Applications/Brave.app',
}

describe('pickPreferredBrowser', () => {
  it('prefers a browser with a Playwright channel over executable_path-only', () => {
    expect(pickPreferredBrowser([braveExe, chromeChannel])).toBe(chromeChannel)
  })

  it('falls back to the first entry if none has a channel', () => {
    expect(pickPreferredBrowser([braveExe])).toBe(braveExe)
  })

  it('returns null on empty list', () => {
    expect(pickPreferredBrowser([])).toBeNull()
  })
})

describe('detectTestBrowsers', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('forwards to detect_test_browsers and returns the array', async () => {
    mockInvoke.mockResolvedValueOnce([chromeChannel])
    const result = await detectTestBrowsers(true)
    expect(mockInvoke).toHaveBeenCalledWith('detect_test_browsers')
    expect(result).toEqual([chromeChannel])
  })
})

describe('ensureTestBrowser', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockPrompt.mockReset()
  })

  it('returns the preferred browser without prompting when one is detected', async () => {
    mockInvoke.mockResolvedValue([chromeChannel])
    const result = await ensureTestBrowser()
    expect(result).toBe(chromeChannel)
    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it('prompts and returns null when user declines after empty detection', async () => {
    mockInvoke.mockResolvedValue([])
    mockPrompt.mockResolvedValue(false)
    const result = await ensureTestBrowser()
    expect(result).toBeNull()
    expect(mockPrompt).toHaveBeenCalled()
  })

  it('re-detects after user accepts the install prompt', async () => {
    mockInvoke
      .mockResolvedValueOnce([])           // first detect: nothing
      .mockResolvedValueOnce([chromeChannel]) // second detect (after accept): chrome
    mockPrompt.mockResolvedValue(true)
    const result = await ensureTestBrowser()
    expect(result).toBe(chromeChannel)
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })
})
