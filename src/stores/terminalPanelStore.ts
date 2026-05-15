import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '../utils/logger'

const DEFAULT_WIDTH_PX = 480
const MIN_WIDTH_PX = 320

interface TerminalPanelState {
  isOpen: boolean
  /** User-preferred width. Clamped at render time to min(MIN_WIDTH_PX, 50% of IDE width). */
  widthPx: number
  /** Active PTY session id when the panel is open. */
  ptySessionId: string | null
}

interface TerminalPanelActions {
  toggle: () => void
  setOpen: (open: boolean) => void
  /** Closes the panel and kills the active PTY (idempotent on Rust side). */
  close: () => void
  setWidth: (px: number) => void
  setSessionId: (id: string | null) => void
}

export const useTerminalPanelStore = create<TerminalPanelState & TerminalPanelActions>((set, get) => ({
  isOpen: false,
  widthPx: DEFAULT_WIDTH_PX,
  ptySessionId: null,
  toggle: () => {
    if (get().isOpen) {
      get().close()
    } else {
      set({ isOpen: true })
    }
  },
  setOpen: (open) => set({ isOpen: open }),
  close: () => {
    const id = get().ptySessionId
    if (id) {
      invoke('kill_pty_session', { sessionId: id }).catch((err) => {
        logger.warn('terminal-panel', 'kill_pty_session failed:', err)
      })
    }
    set({ isOpen: false, ptySessionId: null })
  },
  setWidth: (px) => set({ widthPx: Math.max(MIN_WIDTH_PX, px) }),
  setSessionId: (id) => set({ ptySessionId: id }),
}))

export const TERMINAL_PANEL_MIN_WIDTH = MIN_WIDTH_PX
