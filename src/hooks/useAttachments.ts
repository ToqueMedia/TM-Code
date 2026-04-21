import { useCallback, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useBillingStore } from '../stores/billingStore'
import { useCmdAttachmentStore } from '../stores/cmdAttachmentStore'
import { createAttachmentFromPath, createImageAttachmentFromClipboard } from '../services/attachmentService'
import { logger } from '../utils/logger'
import type { Attachment } from '../types/chat'

/**
 * Centralized attachment handling — paste, drop, file picker, billing validation.
 * Shared by both the regular PromptBar (chat mode) and CmdModePromptInput (CMD mode).
 *
 * By default, delegates storage to chatStore.draftAttachments (same as before).
 * Pass `localState: true` to use hook-local state instead (for CMD mode, which
 * manages its own attachment lifecycle independently of chatStore).
 */
interface UseAttachmentsOptions {
  /** Use hook-local state instead of chatStore.draftAttachments. */
  localState?: boolean
  /** Ref to the textarea to restore focus after file picker. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
}

// ─── Stable selectors (defined outside to prevent allocation churn) ───
//
// When `localState: true`, the hook still calls useChatStore (hooks can't
// be conditional), but these inert selectors return a frozen empty array /
// noop function so Zustand's shallow compare short-circuits the re-render.
const EMPTY_ATTACHMENTS: Attachment[] = Object.freeze([] as Attachment[]) as unknown as Attachment[]
const noop = () => {}

const selectDraftAttachments = (s: { draftAttachments: Attachment[] }) => s.draftAttachments
const selectAddDraft = (s: { addDraftAttachment: (a: Attachment) => void }) => s.addDraftAttachment
const selectRemoveDraft = (s: { removeDraftAttachment: (id: string) => void }) => s.removeDraftAttachment
const selectClearDraft = (s: { clearDraftAttachments: () => void }) => s.clearDraftAttachments

const selectEmptyAttachments = () => EMPTY_ATTACHMENTS
const selectNoop = () => noop

export function useAttachments(options: UseAttachmentsOptions = {}) {
  const { localState = false, textareaRef } = options

  // ─── Store subscriptions ───
  // When localState=true, we read from useCmdAttachmentStore (shared across
  // CmdModeView and CmdModePromptInput so drops on the outer frame end up in
  // the same list as pastes in the input). Otherwise we go through chatStore.
  const cmdAttachments = useCmdAttachmentStore(s => s.attachments)
  const cmdAddAttachment = useCmdAttachmentStore(s => s.addAttachment)
  const cmdRemoveAttachment = useCmdAttachmentStore(s => s.removeAttachment)
  const cmdClearAttachments = useCmdAttachmentStore(s => s.clearAttachments)
  const cmdIsDragging = useCmdAttachmentStore(s => s.isDragging)
  const cmdSetDragging = useCmdAttachmentStore(s => s.setDragging)

  // Inert selectors return frozen constants when localState=true so Zustand
  // short-circuits re-renders from chatStore.draftAttachments changes.
  const storeAttachments = useChatStore(localState ? selectEmptyAttachments : selectDraftAttachments)
  const storeAdd = useChatStore(localState ? selectNoop : selectAddDraft) as (att: Attachment) => void
  const storeRemove = useChatStore(localState ? selectNoop : selectRemoveDraft) as (id: string) => void
  const storeClear = useChatStore(localState ? selectNoop : selectClearDraft) as () => void

  // ─── Unified accessors ───
  const attachments = localState ? cmdAttachments : storeAttachments

  const addAttachment = useCallback((att: Attachment) => {
    if (localState) cmdAddAttachment(att)
    else storeAdd(att)
  }, [localState, cmdAddAttachment, storeAdd])

  const removeAttachment = useCallback((id: string) => {
    if (localState) cmdRemoveAttachment(id)
    else storeRemove(id)
  }, [localState, cmdRemoveAttachment, storeRemove])

  const clearAttachments = useCallback(() => {
    if (localState) cmdClearAttachments()
    else storeClear()
  }, [localState, cmdClearAttachments, storeClear])

  // ─── Billing check ───
  const billingPlan = useBillingStore(s => s.plan)
  const supportsImages = billingPlan !== 'explorer'
  const hasImages = attachments.some(a => a.type === 'image')
  const showImageWarning = hasImages && !supportsImages

  // ─── Drag state ───
  // CMD mode uses the shared store (outer frame + inner input must stay in sync).
  // Chat mode uses local React state — a single component owns the overlay.
  const dragCounterRef = useRef(0)
  const [chatDragging, setChatDragging] = useState(false)
  const isDragging = localState ? cmdIsDragging : chatDragging

  const setDragging = useCallback((v: boolean) => {
    if (localState) cmdSetDragging(v)
    else setChatDragging(v)
  }, [localState, cmdSetDragging])

  // ─── Paste handler ───
  // Attaches images (native paste) and file-like clipboard items (Finder/Explorer
  // copy-paste of a file, which arrives via clipboardData.files with a real path
  // on platforms that expose it).
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    const files = e.clipboardData?.files

    // 1. Native image paste (screenshot, cmd+c on an image in a browser, etc.)
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob) continue
          try {
            const attachment = await createImageAttachmentFromClipboard(blob)
            addAttachment(attachment)
          } catch (err) {
            logger.error('attachments', 'Failed to paste image:', err)
          }
          return
        }
      }
    }

    // 2. File-as-file paste (Finder/Explorer copy-paste). Only hits in Tauri when
    // the OS exposes the file via clipboardData.files. We don't preventDefault
    // unless we actually consume something, so a user pasting text still sees text.
    if (files && files.length > 0) {
      let consumed = false
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string }
        try {
          // Tauri exposes a `path` on File when the drop/paste originates from the OS.
          if (file.path) {
            const attachment = await createAttachmentFromPath(file.path)
            addAttachment(attachment)
            consumed = true
          } else if (file.type.startsWith('image/')) {
            const attachment = await createImageAttachmentFromClipboard(file)
            addAttachment(attachment)
            consumed = true
          }
        } catch (err) {
          logger.error('attachments', 'Failed to attach pasted file:', err)
        }
      }
      if (consumed) e.preventDefault()
    }
  }, [addAttachment])

  // ─── Drag-and-drop ───
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setDragging(true)
  }, [setDragging])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setDragging(false)
  }, [setDragging])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragging(false)

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File & { path?: string }
      try {
        // Prefer the Tauri-exposed path — keeps non-image files attachable by reference.
        if (file.path) {
          const attachment = await createAttachmentFromPath(file.path)
          addAttachment(attachment)
        } else if (file.type.startsWith('image/')) {
          const attachment = await createImageAttachmentFromClipboard(file)
          addAttachment(attachment)
        }
      } catch (err) {
        logger.error('attachments', 'Failed to attach dropped file:', err)
      }
    }
    textareaRef?.current?.focus()
  }, [addAttachment, setDragging, textareaRef])

  // ─── File picker ───
  const handleAttachFiles = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: true,
        title: 'Attach files',
      })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      for (const p of paths) {
        try {
          const attachment = await createAttachmentFromPath(p as string)
          addAttachment(attachment)
        } catch (err) {
          logger.error('attachments', 'Failed to attach file:', err)
        }
      }
    } catch (err) {
      logger.error('attachments', 'Failed to open file dialog:', err)
    }
    textareaRef?.current?.focus()
  }, [addAttachment, textareaRef])

  return {
    attachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    // Billing
    supportsImages,
    showImageWarning,
    billingPlan,
    // Paste / Drop
    handlePaste,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    isDragging,
    // File picker
    handleAttachFiles,
  }
}
