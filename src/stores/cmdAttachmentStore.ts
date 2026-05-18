import { create } from 'zustand'
import type { Attachment } from '../types/chat'

/**
 * Shared CMD-mode attachment state.
 *
 * Lives in its own store (instead of inside `useAttachments` as local React state)
 * so that BOTH TerminalView's outer drag-zone AND CmdModePromptInput's overlay
 * read/write the same attachments without a ref-dance or event delegation.
 *
 * Scoped separately from chatStore.draftAttachments so chat-mode and CMD-mode
 * drafts never leak into each other.
 */

const MAX_ATTACHMENTS = 10

interface CmdAttachmentState {
  attachments: Attachment[]
  isDragging: boolean
}

interface CmdAttachmentActions {
  addAttachment: (a: Attachment) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  setDragging: (v: boolean) => void
}

export const useCmdAttachmentStore = create<CmdAttachmentState & CmdAttachmentActions>()((set) => ({
  attachments: [],
  isDragging: false,
  addAttachment: (a) => set(state => {
    if (state.attachments.length >= MAX_ATTACHMENTS) return state
    // Dedupe by absolute path (pasted images have path='' so multiple pastes are allowed).
    if (a.path && state.attachments.some(x => x.path === a.path)) return state
    return { attachments: [...state.attachments, a] }
  }),
  removeAttachment: (id) => set(state => ({
    attachments: state.attachments.filter(a => a.id !== id),
  })),
  clearAttachments: () => set({ attachments: [] }),
  setDragging: (v) => set({ isDragging: v }),
}))
