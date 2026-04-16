import { create } from 'zustand'
import type { SessionSummary } from '../types/chat'

/**
 * Lightweight ephemeral overlay state for CMD Mode. Used to surface
 * interactive pickers (session list, future confirmations) without
 * polluting chatStore or needing modal plumbing in the renderer.
 *
 * All state is in-memory and resets on reload — no persistence.
 */
interface CmdOverlayState {
  sessionPickerOpen: boolean
  sessionPickerItems: SessionSummary[]
  sessionPickerActiveId: string | null

  openSessionPicker: (items: SessionSummary[], activeId: string | null) => void
  closeSessionPicker: () => void
}

export const useCmdOverlayStore = create<CmdOverlayState>((set) => ({
  sessionPickerOpen: false,
  sessionPickerItems: [],
  sessionPickerActiveId: null,

  openSessionPicker: (items, activeId) =>
    set({ sessionPickerOpen: true, sessionPickerItems: items, sessionPickerActiveId: activeId }),

  closeSessionPicker: () =>
    set({ sessionPickerOpen: false, sessionPickerItems: [], sessionPickerActiveId: null }),
}))
