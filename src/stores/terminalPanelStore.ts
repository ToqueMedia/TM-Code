import { create } from 'zustand'
import { invoke } from '@/utils/invokeMetrics'

// ── Types ──

interface TerminalInstance {
  id: string    // crypto.randomUUID() — PTY session id
  name: string  // "Terminal 1", "Terminal 2", etc.
}

interface TerminalPanelState {
  isOpen: boolean
  widthPx: number
  instances: TerminalInstance[]
  activeInstanceId: string | null
  _nextTerminalNum: number
}

interface TerminalPanelActions {
  toggle: () => void
  setOpen: (open: boolean) => void
  open: () => void
  close: () => void
  killAll: () => void
  setWidth: (px: number) => void

  addTerminal: () => void
  removeTerminal: (id: string) => void
  setActiveTerminal: (id: string) => void

  getActiveSessionId: () => string | null
  writeToPty: (data: string) => void
}

// ── Helpers ──

const DEFAULT_WIDTH_PX = 480
const MIN_WIDTH_PX = 320
const MAX_WIDTH_PX = 900
const MAX_TERMINALS = 3

function clampWidth(px: number): number {
  return Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, px))
}

export { MIN_WIDTH_PX as TERMINAL_PANEL_MIN_WIDTH }

// ── Store ──

export const useTerminalPanelStore = create<TerminalPanelState & TerminalPanelActions>()((set, get) => ({
  // ── State ──
  isOpen: false,
  widthPx: DEFAULT_WIDTH_PX,
  instances: [],
  activeInstanceId: null,
  _nextTerminalNum: 1,

  // ── Panel lifecycle ──
  toggle: () => {
    const { isOpen } = get()
    if (isOpen) {
      get().close()
    } else {
      get().open()
    }
  },

  setOpen: (open) => {
    if (open) get().open()
    else get().close()
  },

  open: () => {
    const { instances } = get()
    if (instances.length === 0) {
      // First open — create initial terminal
      const id = crypto.randomUUID()
      const num = get()._nextTerminalNum
      set({
        isOpen: true,
        instances: [{ id, name: `Terminal ${num}` }],
        activeInstanceId: id,
        _nextTerminalNum: num + 1,
      })
    } else {
      set({ isOpen: true })
    }
  },

  close: () => {
    // Hide panel only — PTYs stay alive. On reopen, open() reuses existing
    // instances. This is the default action for Esc, Ctrl+X, and toggle-close.
    set({ isOpen: false })
  },

  killAll: () => {
    // Hide panel + kill every PTY session. Use only on /exit (leaving CMD mode).
    const { instances } = get()
    for (const inst of instances) {
      invoke('kill_pty_session', { sessionId: inst.id }).catch(() => {})
    }
    set({ isOpen: false, instances: [], activeInstanceId: null })
  },

  setWidth: (px) => set({ widthPx: clampWidth(px) }),

  // ── Terminal instance management ──
  addTerminal: () => {
    const { instances, _nextTerminalNum } = get()
    if (instances.length >= MAX_TERMINALS) return
    const id = crypto.randomUUID()
    const num = _nextTerminalNum
    set({
      instances: [...instances, { id, name: `Terminal ${num}` }],
      activeInstanceId: id,
      _nextTerminalNum: num + 1,
    })
  },

  removeTerminal: (id) => {
    const { instances, activeInstanceId } = get()
    const remaining = instances.filter(i => i.id !== id)
    // Kill the PTY for this terminal. The store owns PTY lifecycle —
    // SingleTerminal's cleanup does NOT kill (it only disposes xterm).
    invoke('kill_pty_session', { sessionId: id }).catch(() => {})
    if (remaining.length === 0) {
      // Last terminal removed — close panel and reset counter
      set({ isOpen: false, instances: [], activeInstanceId: null, _nextTerminalNum: 1 })
      return
    }
    // If we removed the active terminal, select the last one
    const newActiveId = activeInstanceId === id
      ? remaining[remaining.length - 1].id
      : activeInstanceId
    set({ instances: remaining, activeInstanceId: newActiveId })
  },

  setActiveTerminal: (id) => {
    set({ activeInstanceId: id })
  },

  getActiveSessionId: () => {
    return get().activeInstanceId
  },

  // ── PTY I/O ──
  writeToPty: (data: string) => {
    const { activeInstanceId } = get()
    if (!activeInstanceId) return
    invoke('write_to_pty', { sessionId: activeInstanceId, data }).catch(() => {})
  },
}))
