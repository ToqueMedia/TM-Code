import { create } from 'zustand'
import { invoke } from '@/utils/invokeMetrics'

// ── Types ──

interface TerminalInstance {
  id: string    // crypto.randomUUID() — PTY session id
  name: string  // "Terminal 1", "Terminal 2", etc.
}

interface TerminalPanelState {
  isOpen: boolean
  /** Altura do painel inferior (VS Code / Cursor). */
  heightPx: number
  instances: TerminalInstance[]
  activeInstanceId: string | null
  /** Bumped on open / tab switch so the visible xterm can fit + focus. */
  focusNonce: number
  _nextTerminalNum: number
}

interface TerminalPanelActions {
  toggle: () => void
  setOpen: (open: boolean) => void
  open: () => void
  close: () => void
  setHeight: (px: number) => void
  requestFocus: () => void

  addTerminal: () => void
  removeTerminal: (id: string) => void
  renameTerminal: (id: string, name: string) => void
  closeAll: () => void
  setActiveTerminal: (id: string) => void
}

// ── Helpers ──

const DEFAULT_HEIGHT_PX = 260
const MIN_HEIGHT_PX = 140
const MAX_HEIGHT_PX = 560
const MAX_TERMINALS = 5

function clampHeight(px: number): number {
  return Math.max(MIN_HEIGHT_PX, Math.min(MAX_HEIGHT_PX, px))
}

export { MIN_HEIGHT_PX as TERMINAL_PANEL_MIN_HEIGHT }

function killSession(id: string): void {
  invoke('kill_pty_session', { sessionId: id }).catch(() => {})
}

// ── Store ──

export const useTerminalPanelStore = create<TerminalPanelState & TerminalPanelActions>()((set, get) => ({
  isOpen: false,
  heightPx: DEFAULT_HEIGHT_PX,
  instances: [],
  activeInstanceId: null,
  focusNonce: 0,
  _nextTerminalNum: 1,

  toggle: () => {
    if (get().isOpen) get().close()
    else get().open()
  },

  setOpen: (open) => {
    if (open) get().open()
    else get().close()
  },

  open: () => {
    const { instances } = get()
    if (instances.length === 0) {
      const id = crypto.randomUUID()
      const num = get()._nextTerminalNum
      set({
        isOpen: true,
        instances: [{ id, name: `Terminal ${num}` }],
        activeInstanceId: id,
        _nextTerminalNum: num + 1,
        focusNonce: get().focusNonce + 1,
      })
      return
    }
    set({ isOpen: true, focusNonce: get().focusNonce + 1 })
  },

  close: () => {
    // Hide panel only — PTYs stay alive so reopen is instant.
    set({ isOpen: false })
  },

  setHeight: (px) => set({ heightPx: clampHeight(px) }),

  requestFocus: () => set({ focusNonce: get().focusNonce + 1 }),

  addTerminal: () => {
    const { instances, _nextTerminalNum } = get()
    if (instances.length >= MAX_TERMINALS) return
    const id = crypto.randomUUID()
    const num = _nextTerminalNum
    set({
      isOpen: true,
      instances: [...instances, { id, name: `Terminal ${num}` }],
      activeInstanceId: id,
      _nextTerminalNum: num + 1,
      focusNonce: get().focusNonce + 1,
    })
  },

  removeTerminal: (id) => {
    const { instances, activeInstanceId } = get()
    const remaining = instances.filter(i => i.id !== id)
    // Store owns PTY lifecycle — SingleTerminal only disposes xterm.
    killSession(id)
    if (remaining.length === 0) {
      set({ isOpen: false, instances: [], activeInstanceId: null, _nextTerminalNum: 1 })
      return
    }
    const newActiveId = activeInstanceId === id
      ? remaining[remaining.length - 1].id
      : activeInstanceId
    set({
      instances: remaining,
      activeInstanceId: newActiveId,
      focusNonce: get().focusNonce + 1,
    })
  },

  renameTerminal: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    set({
      instances: get().instances.map(i => i.id === id ? { ...i, name: trimmed } : i),
    })
  },

  closeAll: () => {
    for (const inst of get().instances) {
      killSession(inst.id)
    }
    set({ isOpen: false, instances: [], activeInstanceId: null, _nextTerminalNum: 1 })
  },

  setActiveTerminal: (id) => {
    if (get().activeInstanceId === id) {
      set({ focusNonce: get().focusNonce + 1 })
      return
    }
    set({ activeInstanceId: id, focusNonce: get().focusNonce + 1 })
  },
}))
