import { useState, useCallback, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useBillingStore } from '../stores/billingStore'
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

  // ─── Local state (used when localState=true) ───
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>([])

  // ─── Store state ───
  // When localState=true, inert selectors return frozen constants so Zustand
  // never triggers a re-render from chatStore changes. The hook still calls
  // useChatStore (React rules), but the subscription becomes effectively free.
  const storeAttachments = useChatStore(localState ? selectEmptyAttachments : selectDraftAttachments)
  const storeAdd = useChatStore(localState ? selectNoop : selectAddDraft) as (att: Attachment) => void
  const storeRemove = useChatStore(localState ? selectNoop : selectRemoveDraft) as (id: string) => void
  const storeClear = useChatStore(localState ? selectNoop : selectClearDraft) as () => void

  // ─── Unified accessors ───
  const attachments = localState ? localAttachments : storeAttachments

  const addAttachment = useCallback((att: Attachment) => {
    if (localState) {
      setLocalAttachments(prev => {
        if (prev.length >= 10) return prev
        if (att.path && prev.some(a => a.path === att.path)) return prev
        return [...prev, att]
      })
    } else {
      storeAdd(att)
    }
  }, [localState, storeAdd])

  const removeAttachment = useCallback((id: string) => {
    if (localState) {
      setLocalAttachments(prev => prev.filter(a => a.id !== id))
    } else {
      storeRemove(id)
    }
  }, [localState, storeRemove])

  const clearAttachments = useCallback(() => {
    if (localState) {
      setLocalAttachments([])
    } else {
      storeClear()
    }
  }, [localState, storeClear])

  // ─── Billing check ───
  const billingPlan = useBillingStore(s => s.plan)
  const supportsImages = billingPlan !== 'explorer'
  const hasImages = attachments.some(a => a.type === 'image')
  const showImageWarning = hasImages && !supportsImages

  // ─── Drag state ───
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  // ─── Paste handler ───
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

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
  }, [addAttachment])

  // ─── Drag-and-drop ───
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.type.startsWith('image/')) {
        try {
          const attachment = await createImageAttachmentFromClipboard(file)
          addAttachment(attachment)
        } catch (err) {
          logger.error('attachments', 'Failed to attach dropped image:', err)
        }
      }
    }
    textareaRef?.current?.focus()
  }, [addAttachment, textareaRef])

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
