import { useCallback, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useBillingStore } from '../stores/billingStore'
import { useCmdAttachmentStore } from '../stores/cmdAttachmentStore'
import { useToastStore } from '../stores/toastStore'
import { createAttachmentFromPath, createImageAttachmentFromClipboard } from '../services/attachmentService'
import { logger } from '../utils/logger'
import { t } from '../i18n'
import type { Attachment } from '../types/chat'

/** Attach failures used to die in the console — a >cap image just silently
 *  never produced a chip, reading as "the agent didn't get my image". */
function toastAttachError(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  useToastStore.getState().addToast('error', t('attachments.attachFailed').replace('{error}', detail))
}

/**
 * Centralized attachment handling — paste, drop, file picker, billing validation.
 * Shared by both prompt input surfaces.
 *
 * By default, delegates storage to chatStore.draftAttachments (same as before).
 * Pass `localState: true` to use hook-local state instead of chatStore.
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
  // TerminalView and CmdModePromptInput so drops on the outer frame end up in
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
    if (localState) {
      // Local input + imagem: paridade claude-vaz — atribui o número do chip
      // `[Image #N]` (estável; nunca renumera) e insere o MESMO texto no
      // input via evento (o estado do input vive em useCmdPromptLogic).
      // No submit, a imagem só é enviada se o placeholder ainda estiver no
      // texto — apagar o texto remove a imagem (handlePromptSubmit:178).
      if (att.type === 'image' && att.pasteMarker === undefined) {
        const existing = useCmdAttachmentStore.getState().attachments
        const next = existing.reduce((max, a) => Math.max(max, a.pasteMarker ?? 0), 0) + 1
        att = { ...att, pasteMarker: next }
        window.dispatchEvent(new CustomEvent('cmd-insert-text', { detail: `[Image #${next}] ` }))
      }
      cmdAddAttachment(att)
    } else {
      storeAdd(att)
    }
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
  // Local-state inputs use the shared attachment store so outer-frame drops
  // and inner-input pastes stay in sync. Store-backed inputs keep drag state
  // local to the component that owns the overlay.
  const dragCounterRef = useRef(0)
  const [chatDragging, setChatDragging] = useState(false)
  const isDragging = localState ? cmdIsDragging : chatDragging

  const setDragging = useCallback((v: boolean) => {
    if (localState) cmdSetDragging(v)
    else setChatDragging(v)
  }, [localState, cmdSetDragging])

  // ─── Paste handler ───
  // ORDER MATTERS: real files must outrank clipboard bitmaps. A Finder ⌘C of
  // an image file puts the file's ICON on the pasteboard as an image/* flavor
  // alongside the file URL — when the bitmap scan ran first, the model
  // received a generic "PNG document" icon instead of the user's actual file
  // (root-caused 2026-07-09: "o agente não recebeu a imagem").
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const dt = e.clipboardData
    if (!dt) return

    // 1. OS file paste via file:// URLs (how WKWebView exposes Finder copies —
    //    it does NOT populate clipboardData.files for them).
    const fileUrls = (dt.getData('text/uri-list') || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.toLowerCase().startsWith('file://'))
    if (fileUrls.length > 0) {
      e.preventDefault()
      for (const url of fileUrls) {
        try {
          // file:///C:/x on Windows → URL.pathname "/C:/x" — strip the slash.
          const raw = decodeURIComponent(new URL(url).pathname)
          const path = /^\/[A-Za-z]:[\\/]/.test(raw) ? raw.slice(1) : raw
          addAttachment(await createAttachmentFromPath(path))
        } catch (err) {
          logger.error('attachments', 'Failed to attach pasted file URL:', err)
          toastAttachError(err)
        }
      }
      return
    }

    // 2. Files exposed as File objects (WebView2/Chromium do this; a plain
    //    screenshot paste can also land here as a path-less "image.png").
    const files = dt.files
    if (files && files.length > 0) {
      let consumed = false
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string }
        try {
          if (file.path) {
            addAttachment(await createAttachmentFromPath(file.path))
            consumed = true
          } else if (file.type.startsWith('image/')) {
            addAttachment(await createImageAttachmentFromClipboard(file))
            consumed = true
          }
        } catch (err) {
          logger.error('attachments', 'Failed to attach pasted file:', err)
          toastAttachError(err)
        }
      }
      if (consumed) {
        e.preventDefault()
        return
      }
    }

    // 3. Raw bitmap on the clipboard (screenshot, "copy image" in a browser).
    //    Reached only when no real file was present — an icon flavor can't
    //    shadow a file anymore.
    const items = dt.items
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob) continue
          try {
            addAttachment(await createImageAttachmentFromClipboard(blob))
          } catch (err) {
            logger.error('attachments', 'Failed to paste image:', err)
            toastAttachError(err)
          }
          return
        }
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
        toastAttachError(err)
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
