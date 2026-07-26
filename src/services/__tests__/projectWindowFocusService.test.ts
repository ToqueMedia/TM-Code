/**
 * Cross-window focus: foreign detection + second-click open.
 */

import {
  isForeignAgentStatus,
  focusForeignOrOpen,
  stopFocusRequestConsumer,
  SECOND_CLICK_OPEN_MS,
} from '../projectWindowFocusService'

const mockInvoke = jest.fn()

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}))

jest.mock('@/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

describe('projectWindowFocusService', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    stopFocusRequestConsumer()
  })

  it('isForeignAgentStatus accepts running/done/error with pid', () => {
    expect(isForeignAgentStatus({ state: 'running', pid: 42, updatedAt: 1 })).toBe(true)
    expect(isForeignAgentStatus({ state: 'done', pid: 42, updatedAt: 1 })).toBe(true)
    expect(isForeignAgentStatus({ state: 'idle', pid: 42, updatedAt: 1 })).toBe(false)
    expect(isForeignAgentStatus({ state: 'running', pid: 0, updatedAt: 1 })).toBe(false)
  })

  it('opens immediately when no foreign status', async () => {
    const onOpen = jest.fn()
    const r = await focusForeignOrOpen('/proj', null, onOpen)
    expect(r).toBe('opened')
    expect(onOpen).toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('requests focus on first foreign click; second click opens', async () => {
    mockInvoke.mockResolvedValue(true)
    const onOpen = jest.fn()
    const onFocusRequested = jest.fn()
    const status = { state: 'running' as const, pid: 99, updatedAt: Date.now() }

    const r1 = await focusForeignOrOpen('/proj', status, onOpen, { onFocusRequested })
    expect(r1).toBe('focused')
    expect(onOpen).not.toHaveBeenCalled()
    expect(onFocusRequested).toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith('request_project_window_focus', {
      projectPath: '/proj',
    })

    const r2 = await focusForeignOrOpen('/proj', status, onOpen)
    expect(r2).toBe('opened')
    expect(onOpen).toHaveBeenCalled()
  })

  it('opens when request returns false (no foreign owner)', async () => {
    mockInvoke.mockResolvedValue(false)
    const onOpen = jest.fn()
    const r = await focusForeignOrOpen(
      '/proj',
      { state: 'running', pid: 1, updatedAt: 1 },
      onOpen,
    )
    expect(r).toBe('opened')
    expect(onOpen).toHaveBeenCalled()
  })
})

// Keep SECOND_CLICK_OPEN_MS referenced so renames fail tests loudly.
void SECOND_CLICK_OPEN_MS
