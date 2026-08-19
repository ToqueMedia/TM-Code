jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn().mockResolvedValue(undefined),
}))

import { invoke } from '@/utils/invokeMetrics'
import { useTerminalPanelStore } from '../terminalPanelStore'

const mockInvoke = invoke as unknown as jest.Mock

describe('terminalPanelStore', () => {
  beforeEach(() => {
    mockInvoke.mockClear()
    useTerminalPanelStore.setState({
      isOpen: false,
      heightPx: 260,
      instances: [],
      activeInstanceId: null,
      focusNonce: 0,
      _nextTerminalNum: 1,
    })
  })

  it('open creates the first session and requests focus', () => {
    useTerminalPanelStore.getState().open()
    const s = useTerminalPanelStore.getState()
    expect(s.isOpen).toBe(true)
    expect(s.instances).toHaveLength(1)
    expect(s.activeInstanceId).toBe(s.instances[0].id)
    expect(s.focusNonce).toBeGreaterThan(0)
  })

  it('close hides the panel but keeps PTYs', () => {
    useTerminalPanelStore.getState().open()
    const id = useTerminalPanelStore.getState().activeInstanceId
    useTerminalPanelStore.getState().close()
    const s = useTerminalPanelStore.getState()
    expect(s.isOpen).toBe(false)
    expect(s.instances).toHaveLength(1)
    expect(s.activeInstanceId).toBe(id)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('toggle reopens the same session and bumps focus', () => {
    useTerminalPanelStore.getState().open()
    const first = useTerminalPanelStore.getState()
    useTerminalPanelStore.getState().toggle()
    useTerminalPanelStore.getState().toggle()
    const again = useTerminalPanelStore.getState()
    expect(again.isOpen).toBe(true)
    expect(again.instances[0].id).toBe(first.instances[0].id)
    expect(again.focusNonce).toBeGreaterThan(first.focusNonce)
  })

  it('removeTerminal kills that PTY and closes the panel when it was the last', () => {
    useTerminalPanelStore.getState().open()
    const id = useTerminalPanelStore.getState().activeInstanceId as string
    useTerminalPanelStore.getState().removeTerminal(id)
    const s = useTerminalPanelStore.getState()
    expect(s.instances).toHaveLength(0)
    expect(s.isOpen).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('kill_pty_session', { sessionId: id })
  })

  it('closeAll kills every session (project switch / tearDown)', () => {
    useTerminalPanelStore.getState().open()
    useTerminalPanelStore.getState().addTerminal()
    const ids = useTerminalPanelStore.getState().instances.map(i => i.id)
    expect(ids).toHaveLength(2)
    useTerminalPanelStore.getState().closeAll()
    expect(useTerminalPanelStore.getState().instances).toHaveLength(0)
    expect(useTerminalPanelStore.getState().isOpen).toBe(false)
    for (const id of ids) {
      expect(mockInvoke).toHaveBeenCalledWith('kill_pty_session', { sessionId: id })
    }
  })

  it('does not expose writeToPty — keystrokes go through xterm onData', () => {
    expect('writeToPty' in useTerminalPanelStore.getState()).toBe(false)
    expect('killAll' in useTerminalPanelStore.getState()).toBe(false)
  })
})
