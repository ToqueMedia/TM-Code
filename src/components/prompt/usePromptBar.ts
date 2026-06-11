import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@/utils/invokeMetrics'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, resolveAllPendingDiffApprovals, generateId } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore, selectIsPreviewServerRunning } from '../../stores/layoutStore'
import { useBillingStore } from '../../stores/billingStore'
import { useAuthStore } from '../../stores/authStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useCredentialRequestStore } from '../../stores/credentialRequestStore'
import { useProblemsStore } from '../../stores/problemsStore'
import { devServerManager } from '../../services/devServerManager'
import { activatePreview } from '../../services/previewActivation'
import AgentService from '../../services/agent/agentService'
import ToolExecutor from '../../services/agent/toolExecutor'
import ContextBuilder from '../../services/agent/contextBuilder'
import MCPService from '../../services/mcp/mcpService'
import { browserSession } from '../../services/browserSessionManager'
import { isSlashCommandAllowedForPlan, slashCommandRegistry, type SlashCommand } from '../../services/agent/slashCommandRegistry'
import QuickOpenService, { type QuickOpenItem } from '../../services/quickOpenService'
import { findMentionAtCursor, findMentionTokenEnd } from '../../utils/mentionParser'
import { preprocessHashtags } from '../../services/agent/hashtagRegistry'
import { useHashtagMenu } from './useHashtagMenu'
import { guardScaffoldReapply } from './scaffoldReapplyGuard'
import { scaffoldKeyLabel, type ScaffoldKey } from '../../services/scaffoldingDetector'
import { t } from '@/i18n'
import { runAuthFlow, runDesignFlow } from '../../services/agent/commands/authCommand'
import { createAttachmentFromPath, createImageAttachmentFromClipboard, resolveAttachments, resolveImageToDataUri } from '../../services/attachmentService'
import { resolveMentionContext, collectChangedFileContext, applyMentionResolution } from '../../services/agent/atMentions'
import {
  enqueue as enqueueMessage,
  clearCommandQueue as clearMessageQueue,
  joinPromptValues,
} from '../../services/agent/messageQueue'
import type { OpenAIContentPart } from '../../services/agent/agentService'
// getModelProfile removed — model decided by backend based on plan
import {
  buildAugmentedPrompt,
  buildContentParts,
  downgradeHistoryToText,
  extractDisplayFromValue,
} from '../../services/agent/promptValueHelpers'
// useSettingsStore removed — agentModel no longer in settings
import { getQueryGuard } from '../../services/agent/queryGuard'
import type { ContentBlock, PromptValue, QueuedCommand } from '../../types/messageQueueTypes'
import { useQueueProcessor } from '../../hooks/useQueueProcessor'
import { classifyPendingPlanIntent } from '../../services/agent/planResumeIntent'

/**
 * ServiceError codes that mean "transient upstream / network problem the user
 * can recover from by re-sending Continue". When `agentService.runAgentLoop`
 * fires onError with one of these, we add a recovery-hint system message to
 * the transcript so the user knows what to do — and so the hint persists
 * across reloads (chat-store messages are sanitized + saved).
 *
 * Pure code-based detection — no string matching. New error sources should
 * extend this set rather than reach for a regex on the human message.
 */
const RECOVERABLE_UPSTREAM_CODES = new Set<string>([
  'SERVER_ERROR',     // 5xx from worker / cloud BYOK
  'NETWORK_ERROR',    // fetch retry exhausted
  'BYOK_LOCAL_ERROR', // local provider (Ollama / LM Studio) unreachable
  'STREAM_ERROR',     // SSE error event mid-turn
])

/**
 * Detect the dev command for a project by checking manifest and package.json.
 * Extracted as a standalone function so it can be called both from the
 * useEffect (periodic re-detection) AND from togglePreview (just-in-time
 * when the user clicks the preview button before detection ran).
 */
async function detectDevCommand(projectPath: string): Promise<string | null> {
  // 1. Check .toquemedia-template manifest
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/.toquemedia-template` })
    if (raw) {
      const manifest = JSON.parse(raw)
      if (manifest.devCommand) return manifest.devCommand
    }
  } catch { /* no manifest */ }

  // 2. Check package.json for "dev" or "start" script
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/package.json` })
    if (raw) {
      const pkg = JSON.parse(raw)
      if (pkg.scripts?.dev) return 'npm run dev'
      if (pkg.scripts?.start) return 'npm start'
    }
  } catch { /* no package.json */ }

  return null
}
import { logger } from '../../utils/logger'

export function usePromptBar() {
  // Boolean-only selector. The full string used to live here (`s.draftInput`)
  // which forced PromptBar + every sibling rendered by this hook to
  // re-render per keystroke. We only need to know whether there IS input for
  // the send-button gate; the actual text lives inside PromptTextarea, which
  // subscribes to `draftInput` itself. Boolean re-render fires once when
  // the user types the first char and once when they clear the buffer.
  const hasInputContent = useChatStore(s => s.draftInput.trim().length > 0)
  const setInput = useChatStore(s => s.setDraftInput)
  const [devCommand, setDevCommand] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyIndexRef = useRef(-1)
  const savedDraftRef = useRef('')
  const navigatingHistoryRef = useRef(false)
  const isStreaming = useChatStore(s => s.isStreaming)
  const hasPendingPermission = usePermissionStore(s => !!s.pendingPermission)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const hasPendingCredential = useCredentialRequestStore(s => s.pending.size > 0)
  // Subscribe to the QueryGuard via useSyncExternalStore — same pattern
  // Claude Code uses. Re-renders when reserve/tryStart/end/forceEnd fires.
  const queryGuard = getQueryGuard()
  const isAgentBusy = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)
  const currentProject = useProjectStore(s => s.currentProject)
  const viewMode = useLayoutStore(s => s.viewMode)
  const isPreviewServerRunning = useLayoutStore(selectIsPreviewServerRunning)
  const previewHtmlContent = useLayoutStore(s => s.previewHtmlContent)
  const scaffoldPhase = useLayoutStore(s => s.scaffoldPhase)
  const isScaffolding = scaffoldPhase === 'installing' || scaffoldPhase === 'starting'
  // Input is always active — user can type and enqueue while agent is busy.
  // Only disable during permission or credential dialogs (user must respond first).
  const isDisabled = hasPendingPermission || hasPendingCredential
  // Blocking limit: when context is nearly full, block input until compaction runs.
  const currentPromptTokens = useChatStore(s => s.currentPromptTokens)
  const headerContextWindow = useAgentStore(s => s.modelContextWindow)
  const isContextBlocked = currentPromptTokens > 0 && (headerContextWindow ?? 0) > 0
    && currentPromptTokens >= (headerContextWindow ?? 0) - 3000
  // Send is blocked during scaffolding or when context is at the blocking limit.
  const isSendBlocked = isScaffolding || isContextBlocked
  // Preview button is ALWAYS visible when a project is open.
  // It serves dual purpose:
  //   - If dev server is running: switches to preview/HTTP client view
  //   - If dev server is NOT running: starts the server (if devCommand detected)
  //   - If no devCommand: switches to preview view (shows "Waiting..." with instructions)
  // This ensures the user can always manually initiate the dev server.
  const hasPreview = !!currentProject?.path || isPreviewServerRunning || !!previewHtmlContent || !!devCommand

  // Slash command menu state
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  // True when the menu is in arg-suggestion mode (after `<cmd> `). Drives
  // the SlashCommandMenu footer hint about free-form text after args.
  const [isArgMode, setIsArgMode] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)

  // @mention menu state
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [filteredMentions, setFilteredMentions] = useState<QuickOpenItem[]>([])
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const mentionStartRef = useRef(-1)

  // #hashtag menu — closed-vocabulary skill triggers (e.g. #auth-google).
  // State + handlers live in the shared hook (also used by cmd-mode).
  const hashtagMenu = useHashtagMenu({
    textareaRef,
    setInputValue: (next) => useChatStore.getState().setDraftInput(next),
    getInputValue: () => useChatStore.getState().draftInput,
  })

  // Drag-and-drop visual state (local, NOT in Zustand store)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  // Draft attachments from store
  const draftAttachments = useChatStore(s => s.draftAttachments)
  const addDraftAttachment = useChatStore(s => s.addDraftAttachment)
  const removeDraftAttachment = useChatStore(s => s.removeDraftAttachment)
  const clearDraftAttachments = useChatStore(s => s.clearDraftAttachments)

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    }
  }, [])

  // Detect if project can run a dev server
  useEffect(() => {
    if (!currentProject?.path) {
      setDevCommand(null)
      return
    }

    let cancelled = false

    detectDevCommand(currentProject.path).then(cmd => {
      if (!cancelled) setDevCommand(cmd)
    })

    return () => { cancelled = true }
    // Re-run when agent finishes a session — the agent may have created
    // package.json with a "dev" script during scaffolding.
  }, [currentProject?.path, isAgentBusy])

  // ── Already-applied scaffolding hints ─────────────────────────────
  // Powers the "já aplicado" badge in HashtagMenu / SlashCommandMenu and
  // the smart-router branch in handleSend below. Re-runs on project change
  // and on agent-idle transitions (an agent turn may have just provisioned
  // auth or scaffolded /payments). The detector caches per-projectPath so
  // multiple subscribers don't re-scan the filesystem.
  const [appliedHints, setAppliedHints] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (!currentProject?.path) {
      setAppliedHints(new Map())
      return
    }
    let cancelled = false
    Promise.all([
      import('../../services/scaffoldingDetector'),
    ]).then(async ([{ detectScaffolding, scaffoldFixHint, scaffoldUITrigger }]) => {
      const state = await detectScaffolding(currentProject.path)
      if (cancelled) return
      const next = new Map<string, string>()
      for (const key of state.applied) {
        next.set(scaffoldUITrigger(key), scaffoldFixHint(key))
      }
      setAppliedHints(next)
    }).catch(() => { /* non-critical — UI just shows no hints */ })
    return () => { cancelled = true }
  }, [currentProject?.path, isAgentBusy])

  // Auto-resize lived here when `input` was a reactive read on this hook.
  // Now that PromptTextarea owns the live subscription, it also owns the
  // height measurement (useLayoutEffect inside PromptTextarea). Leaving the
  // useEffect here would force the hook back into reactive-input territory
  // and reintroduce the per-keystroke re-render of every consumer.

  // Preserve focus across view switches (e.g. chat → preview).
  // When the PromptBar remounts with draft text, the user was typing — refocus.
  useEffect(() => {
    const draft = useChatStore.getState().draftInput
    if (draft && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  // Restore focus when permission dialog closes.
  // PromptBar is unmounted while PermissionDialog is shown (conditional render
  // in MainLayout). When the dialog closes and PromptBar remounts, we need to
  // restore focus so the user can continue typing without clicking.
  const prevPendingPermissionRef = useRef(pendingPermission)
  useEffect(() => {
    const wasBlocked = prevPendingPermissionRef.current
    prevPendingPermissionRef.current = pendingPermission
    if (wasBlocked && !pendingPermission) {
      const t = setTimeout(() => textareaRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [pendingPermission])

  // Slash command input handler — detect "/" prefix and filter commands
  const handleInputChange = useCallback((value: string) => {
    setInput(value)

    // Don't reset history index when the change came from history navigation
    if (navigatingHistoryRef.current) {
      navigatingHistoryRef.current = false
    } else {
      historyIndexRef.current = -1
    }

    // Slash commands: /command (no space → suggest command names)
    if (value.startsWith('/') && !value.includes(' ')) {
      const commands = slashCommandRegistry.filterCommands(value.split(' ')[0])
      // Skip the setState when the suggestion list is content-identical to
      // the current one. Each `filterCommands` call returns a fresh array,
      // so `useState`'s default Object.is would always fire a re-render
      // even when nothing visually changes (user types another char inside
      // the same prefix — `/in` → `/ini` both surface the same single-row
      // list). Returning `prev` from the updater is React's signal to bail.
      setFilteredCommands(prev =>
        prev.length === commands.length && prev.every((c, i) => c.name === commands[i].name)
          ? prev
          : commands,
      )
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
      setShowMentionMenu(false)
      setIsArgMode(false)
      return
    }

    // Slash commands: /<known-cmd> [partial] → suggest argument values when
    // the command declares argSuggestions. Picking one re-triggers the menu
    // so multi-arg chains are one-key-each.
    const argResult = slashCommandRegistry.getArgSuggestions(value)
    if (argResult) {
      const argItems: SlashCommand[] = argResult.suggestions.map(arg => ({
        name: arg.value,
        description: arg.description,
        enabled: true,
        execute: async () => {},
      }))
      // Same dedupe rationale as the previous branch — same partial typed,
      // same arg suggestions, no re-render needed.
      setFilteredCommands(prev =>
        prev.length === argItems.length && prev.every((c, i) => c.name === argItems[i].name)
          ? prev
          : argItems,
      )
      setShowCommandMenu(true)
      setSelectedCommandIndex(0)
      setShowMentionMenu(false)
      setIsArgMode(true)
      return
    }

    setShowCommandMenu(false)
    setIsArgMode(false)

    // #hashtag and @mention detection share the same RAF — autocomplete state
    // is mutually exclusive. Hashtag check runs first because its vocabulary
    // is closed (and cheap), and a `#` token shouldn't fall through to the
    // file picker.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      const cursorPos = textarea.selectionStart
      const text = textarea.value

      // Closed-vocabulary hashtag (e.g. #auth-email-password, #auth-google).
      // detect() returns true when a `#` token owns the autocomplete slot —
      // including the no-matches case — so we never fall through to the file
      // picker for an unknown tag.
      if (hashtagMenu.detect(text, cursorPos)) {
        setShowMentionMenu(false)
        return
      }

      // @mention — unicode-safe, shared parser. Directories included so users
      // can reference dirs like @src/components/ for listing.
      const mention = findMentionAtCursor(text, cursorPos)
      if (!mention) {
        setShowMentionMenu(false)
        return
      }

      const qs = QuickOpenService.getInstance()
      const results = mention.query.length === 0
        ? qs.list(30, true)
        : qs.search(mention.query, 30, true)

      if (results.length > 0) {
        // Same content-dedupe as the slash branches above — `QuickOpenService`
        // builds a fresh results array on every call even when the visible
        // list is unchanged (user typing through an unambiguous prefix).
        setFilteredMentions(prev =>
          prev.length === results.length && prev.every((r, i) => r.path === results[i].path)
            ? prev
            : results,
        )
        setShowMentionMenu(true)
        setSelectedMentionIndex(0)
        mentionStartRef.current = mention.atIndex
      } else {
        setShowMentionMenu(false)
      }
    })
  }, [setInput])

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    // Paid-plan gate at selection time. The menu's mouse onClick already
    // refuses to fire handleClick for paywalled rows, but keyboard Enter
    // routes through handleCommandSelect directly — without this check,
    // a free user could press Enter on a "Pro" row and the command would
    // land in the textarea. We refuse to insert it AND surface a message
    // so the action is not silently swallowed.
    if (command.requiresPaidPlan && !command.usesOwnPlanGate) {
      const billingState = useBillingStore.getState()
      if (!isSlashCommandAllowedForPlan(command, billingState.plan)) {
        useChatStore.getState().addSystemMessage(
          command.planGateMessageKey ? t(command.planGateMessageKey) : `${command.name} is a paid feature. Upgrade your plan in Settings to use it.`
        )
        useLayoutStore.getState().setViewMode('settings')
        // Also dismiss the menu so the user isn't left with the same row
        // highlighted, inviting another Enter press.
        setShowCommandMenu(false)
        setIsArgMode(false)
        return
      }
    }

    // Arg vs command pick: if the buffer already contains a space, we're
    // picking from the arg-suggestion menu, so replace just the trailing
    // partial word. Otherwise we're picking a real command — replace the
    // whole buffer with `<cmd> ` so the user can keep typing.
    const current = useChatStore.getState().draftInput
    let next: string
    if (current.includes(' ')) {
      const lastSpaceIdx = current.lastIndexOf(' ')
      next = current.slice(0, lastSpaceIdx + 1) + command.name + ' '
    } else {
      next = command.name + ' '
    }
    setInput(next)

    // Re-evaluate so chained arg picks surface the next round of suggestions
    // without manual retype.
    const argResult = slashCommandRegistry.getArgSuggestions(next)
    if (argResult) {
      const argItems: SlashCommand[] = argResult.suggestions.map(arg => ({
        name: arg.value,
        description: arg.description,
        enabled: true,
        execute: async () => {},
      }))
      setFilteredCommands(argItems)
      setShowCommandMenu(true)
      setSelectedCommandIndex(0)
      setIsArgMode(true)
    } else {
      setShowCommandMenu(false)
      setIsArgMode(false)
    }
    textareaRef.current?.focus()
  }, [setInput])

  const handleBlur = useCallback(() => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    blurTimeoutRef.current = setTimeout(() => {
      setShowCommandMenu(false)
      setShowMentionMenu(false)
      hashtagMenu.close()
    }, 150)
  }, [hashtagMenu])

  // @mention selection: insert @path as text in the textarea, replacing the
  // full mention token (not just up to the cursor) so mid-token edits don't
  // leave trailing garbage.
  const handleMentionSelect = useCallback((item: QuickOpenItem) => {
    const currentInput = useChatStore.getState().draftInput
    const start = mentionStartRef.current
    if (start < 0) return

    const tokenEnd = findMentionTokenEnd(currentInput, start + 1)
    const before = currentInput.slice(0, start)
    const after = currentInput.slice(tokenEnd)

    // Relative path: normalise separators so Windows ("\") doesn't slip into prompt.
    const projectPath = (useProjectStore.getState().currentProject?.path || '')
      .replace(/\\/g, '/').replace(/\/+$/, '')
    const normItem = item.path.replace(/\\/g, '/')
    const relativePath = normItem.startsWith(projectPath + '/')
      ? normItem.slice(projectPath.length + 1)
      : normItem

    const suffix = item.isDirectory ? '/' : ''
    const insertion = `@${relativePath}${suffix} `
    const newValue = before + insertion + after
    const newCursor = before.length + insertion.length

    QuickOpenService.getInstance().markUsed(item.path)

    useChatStore.getState().setDraftInput(newValue)
    mentionStartRef.current = -1
    setShowMentionMenu(false)

    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea) {
        textarea.selectionStart = newCursor
        textarea.selectionEnd = newCursor
        textarea.focus()
      }
    })
  }, [])

  // Attach files via file picker dialog
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
          addDraftAttachment(attachment)
        } catch (err) {
          logger.error('prompt', 'Failed to attach file:', err)
        }
      }
    } catch (err) {
      logger.error('prompt', 'Failed to open file dialog:', err)
    }
    textareaRef.current?.focus()
  }, [addDraftAttachment])

  // Paste handler — intercept images from clipboard
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
          addDraftAttachment(attachment)
        } catch (err) {
          logger.error('prompt', 'Failed to paste image:', err)
        }
        return // Only handle first image
      }
    }
    // If no image, let default paste behavior (text) proceed
  }, [addDraftAttachment])

  // Drag-and-drop handlers — counter prevents flicker when dragging over child elements
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
          addDraftAttachment(attachment)
        } catch (err) {
          logger.error('prompt', 'Failed to attach dropped image:', err)
        }
      }
      // Note: In Tauri WebView, dropped non-image files may not have full paths.
      // For file references, users should use @ mentions or the attach button.
    }
    textareaRef.current?.focus()
  }, [addDraftAttachment])

  const handleRemoveAttachment = useCallback((id: string) => {
    removeDraftAttachment(id)
  }, [removeDraftAttachment])

  // Listen for suggestion chip inserts
  useEffect(() => {
    function handleInsert(e: Event) {
      const ce = e as CustomEvent<string>
      if (ce.detail) {
        setInput(ce.detail)
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('promptbar:insert', handleInsert)
    return () => window.removeEventListener('promptbar:insert', handleInsert)
  }, [])

  /**
   * Core send logic — runs the agent loop for a given content value.
   *
   * The `content` parameter can be either:
   *  - A plain string (direct path from handleSend with no attachments,
   *    or coalesced batch of text-only commands)
   *  - A ContentBlock[] preserving the order of text and attachments
   *    (single message with attachments, or coalesced batch with images
   *    interleaved across messages)
   *
   * For blocks, the augmented prompt is built by walking the blocks in
   * order, producing text + per-attachment XML markers inline. This
   * preserves the correspondence "this text refers to this image" that
   * a flat "all-text-then-all-attachments" representation would lose.
   *
   * @param skipUserMessage - If true, don't add user message to chat (already added by caller).
   */
  const runAgentForPrompt = useCallback(async (
    content: PromptValue,
    skipUserMessage = false,
  ) => {
    const chatStore = useChatStore.getState()
    const agentStore = useAgentStore.getState()
    const projectPath = currentProject?.path || ''
    const projectType = currentProject?.projectType || 'unknown'

    // Ensure a session exists SYNCHRONOUSLY so addUserMessage below has a
    // home for the bubble. We use sync createSession (not async
    // createNewSession) for the same reason agentRunner.ts:113 does in
    // cmd-mode: any await between dequeue and addUserMessage leaves the
    // chat blank for the duration — the queued strip already emptied,
    // and the bubble hasn't been added yet, so the user sees the message
    // disappear. App.tsx already initialised persistence for this project
    // via restoreLastSession before the user could interact, so the sync
    // path is safe.
    if (!chatStore.activeSessionId) {
      chatStore.createSession(projectPath)
    }

    // ── TMS.md Bootstrap Gate ──
    // When an external project lacks TMS.md, run a dedicated bootstrap turn
    // that creates TMS.md and starts the dev server BEFORE processing the
    // user's message. The recursive call uses skipUserMessage=true so the
    // bootstrap prompt is invisible to the user — only the agent's work
    // (reading files, creating TMS.md) appears in the chat.
    const pState = useProjectStore.getState()
    if (pState.noTmsFile && !pState.tmsBootstrapping && !skipUserMessage) {
      pState.setTmsBootstrapping(true)
      try {
        const { getTmsBootstrapPrompt } = await import('../../services/agent/tmsBootstrap')
        chatStore.addSystemMessage(t('common.tmsBootstrapStart'))

        const bootstrapPrompt = getTmsBootstrapPrompt(projectPath)
        const bootstrapOk = await runAgentForPrompt(bootstrapPrompt, true)

        // Verify TMS.md was created
        try {
          await invoke('read_file', { path: `${projectPath}/TMS.md` })
          pState.setNoTmsFile(false)
          // Invalidate cached system prompt so next build picks up TMS.md
          ContextBuilder.getInstance().invalidatePromptCache(projectPath)
          if (bootstrapOk) {
            chatStore.addSystemMessage(t('common.tmsBootstrapComplete'))

            // Show the user's original message in the chat, then replace
            // the content with a synthetic prompt that asks the agent to
            // check with the user before proceeding. This prevents the
            // redundant "run the project" after the bootstrap already did it.
            const originalDisplay = extractDisplayFromValue(content)
            chatStore.addUserMessage(originalDisplay.text, originalDisplay.attachments)

            const originalText = typeof content === 'string' ? content : ''
            content = `Project setup complete (TMS.md created, dev server started). The user's original request was: "${originalText}". Before doing anything else, ask the user if they still want you to carry out this request, since the initial setup is already done.`
            skipUserMessage = true
          }
        } catch {
          // TMS.md not created — show warning but continue with user's message
          chatStore.addSystemMessage(t('common.tmsBootstrapFailed'))
        }
      } catch (err) {
        logger.error('prompt', 'TMS bootstrap failed:', err)
      } finally {
        pState.setTmsBootstrapping(false)
      }
    }

    // Render the user's bubble + assistant placeholder BEFORE the async
    // augmentation step (mention resolution + attachment disk reads can
    // take 50–500ms). Display extraction is sync, so we can paint the
    // bubble first and build the model payload after.
    const display = extractDisplayFromValue(content)
    if (!skipUserMessage) {
      const blocks = typeof content === 'string' ? undefined : content
      chatStore.addUserMessage(display.text, display.attachments, blocks)
    }
    chatStore.startAssistantMessage(
      AgentService.getInstance().isThinkingRequestedForNextTurn(),
    )
    agentStore.setStatus('awaiting_response')

    // Split on model capability. Vision-capable models (Qwen 3.6 Plus
    // for image analysis, GLM-5.1 as primary) receive an OpenAI-compatible
    // content parts array with real image_url parts. Text-only models
    // receive a flattened string with `<attached_image .../>` placeholders.
    //
    // The split happens at this boundary (not in the queue layer) so
    // the queue stays provider-agnostic — it carries blocks, the
    // boundary decides how to ship them.
    // Model is decided by the backend. Multimodal support depends on the
    // plan: paid plans use GLM-5.1 (primary) + Qwen 3.6 Plus (image analysis),
    // free uses DeepSeek V3.2 (text-only).
    const { useBillingStore } = await import('../../stores/billingStore')
    const billingPlan = useBillingStore.getState().plan
    const supportsAttachments = billingPlan !== 'explorer'

    let userContent: string | OpenAIContentPart[] | null = null

    // Bundle the Tauri-backed resolvers once — both helpers consume the
    // same shape, so call sites are immune to argument reordering.
    const promptResolvers = {
      resolveAttachmentXml: resolveAttachments,
      resolveImageDataUri: resolveImageToDataUri,
    }

    if (supportsAttachments && display.attachments.some(a => a.type === 'image')) {
      // Multimodal path — build content parts. If buildContentParts
      // returns null (no images survived disk read / size limits / size
      // budget), fall through to the text path.
      const parts = await buildContentParts(content, promptResolvers)
      if (parts) userContent = parts
    }

    if (userContent === null) {
      // Text-only path — interleaved `<attached_image>` placeholders.
      userContent = await buildAugmentedPrompt(content, promptResolvers)
    }

    // ── @-mentions + external-modification sweep (claude-vaz parity) ──
    // Mentions resolve ONCE over the full user text and append AFTER the
    // prompt as synthetic read_file/list_directory tool context wrapped in
    // <system-reminder> blocks (atMentions.ts has the full rationale). The
    // sweep covers files the model has in context that changed on disk
    // since it last saw them — claude-vaz injects the same note at turn
    // start via getAttachmentMessages.
    try {
      const mentionResolution = await resolveMentionContext(display.text)
      const changedContext = await collectChangedFileContext()
      if (mentionResolution.contextText || mentionResolution.imageParts.length > 0 || changedContext) {
        const applied = applyMentionResolution(
          userContent, mentionResolution, changedContext, supportsAttachments,
        )
        userContent = applied.userContent
        // Persist on the user bubble so rebuildConversationHistory re-emits
        // the context on follow-up turns (it would otherwise evaporate —
        // history is rebuilt from display messages after every turn). With
        // skipUserMessage the bubble was added by the caller — still the
        // last user message in this serialized send flow.
        if (applied.persistedContext) {
          chatStore.setMentionContextOnLastUserMessage(applied.persistedContext)
        }
      }
    } catch {
      // Mention resolution must never block a send — worst case the model
      // reads the files itself via tools.
    }

    // Track whether the agent loop ended with an error.
    // Used by executeQueuedInput to stop processing remaining commands.
    let hadError = false

    try {
      // Refresh MCP tools before building prompt (handles mid-session server changes)
      const mcpService = MCPService.getInstance()
      const mcpTools = mcpService.getAllTools()
      if (mcpTools.length > 0) {
        const toolExecutor = ToolExecutor.getInstance()
        toolExecutor.registerMCPTools(
          mcpTools,
          browserSession.wrapCallTool((serverName, toolName, args) =>
            mcpService.callTool(serverName, toolName, args),
          ),
        )
        AgentService.getInstance().refreshTools()
      }

      // Build system prompt with MCP tool info for the tool_routing section
      const contextBuilder = ContextBuilder.getInstance()
      const mcpToolSummaries = mcpTools.map(t => ({
        name: t.name,
        description: t.description,
        serverName: t.serverName,
      }))
      const coreToolCount = ToolExecutor.getInstance().getCoreToolCount()
      // Pass the raw user text so contextBuilder can detect skill-trigger
      // hashtags (#auth-google, #design, etc.) and inline the corresponding
      // CRITICAL skill rules at turn 1 — before scaffoldingDetector has any
      // filesystem markers to find.
      const userMessageText = display.text
      const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType, mcpToolSummaries, coreToolCount, userMessageText)

      const rawHistory = useChatStore.getState().conversationHistory
      // The history is canonical (carries content parts when previous
      // turns had images). Downgrade to text if the active model is
      // text-only — its API cannot consume the array form.
      const history = supportsAttachments
        ? rawHistory
        : downgradeHistoryToText(rawHistory)
      const agentService = AgentService.getInstance()
      agentService.setSystemPrompt(systemPrompt)

      // Novo pedido → zera a stat de display "último pedido" (paridade com
      // agentRunner; a contabilidade real vive no worker ai-pass-through).
      useBillingStore.getState().resetLastRequestStats()

      await agentService.runAgentLoop(userContent, history, {
        onTextDelta: (delta) => {
          agentStore.setStatus('generating')
          appendTextDeltaBuffered(delta)
        },
        onReasoningDelta: (delta) => {
          agentStore.setStatus('reasoning')
          appendReasoningDeltaBuffered(delta)
        },
        onToolCallPending: (toolId, toolName) => {
          flushBufferedDeltas()
          agentStore.setStatus('applying')
          useChatStore.getState().addPendingToolCall(toolId, toolName)
        },
        onToolCallStart: (toolId, _toolName, args) => {
          useChatStore.getState().updateToolCallWithArgs(toolId, args)
        },
        onToolResult: (toolId, _toolName, result, isError) => {
          useChatStore.getState().updateToolCallWithResult(toolId, result, isError)
          agentStore.setStatus('awaiting_response')
        },
        onTurnComplete: () => {
          useChatStore.getState().incrementTurnCount()
        },
        onDone: async () => {
          flushBufferedDeltas()
          useChatStore.getState().finalizeAssistantMessage()
          agentStore.setStatus('idle')

          // Re-scan project diagnostics after agent finishes
          useProblemsStore.getState().scanProject().catch(() => {})

          const layoutStore = useLayoutStore.getState()

          // If preview server is running, reload and show preview
          if (selectIsPreviewServerRunning(layoutStore)) {
            layoutStore.reloadPreview()
            layoutStore.setViewMode('preview')
            return
          }

          // If a server is already starting (e.g. postScaffoldPipeline kicked
          // it off and waitForServerReady hasn't resolved yet), don't start a
          // second one — the first will auto-transition when ready.
          if (devServerManager.isActive()) return

          // Otherwise, try to start preview if we have a dev command
          if (devCommand && currentProject?.path) {
            layoutStore.addDevServerLog(`Starting dev server (${devCommand})...`, 'info')
            // Detect project kind so fullstack monorepos get dual-port kill
            // and port-authoritative URL classification (not just 'frontend').
            let projectKind: 'frontend' | 'backend' | 'fullstack' | undefined
            try {
              const { detectProjectCategory, categoryToServerHint } = await import('../../services/projectTypeDetector')
              const cat = await detectProjectCategory(currentProject.path)
              projectKind = categoryToServerHint(cat)
            } catch { /* non-fatal */ }
            try {
              const { resolveFrontendPortHint } = await import('../../services/templateService')
              const frontendPortHint = projectKind
                ? await resolveFrontendPortHint(currentProject.path, projectKind)
                : undefined
              await devServerManager.start(currentProject.path, devCommand, { projectKind, frontendPortHint })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              layoutStore.addDevServerLog(`Could not start dev server: ${msg}`, 'error')
            }
          }
        },
        onError: (error) => {
          flushBufferedDeltas()
          resolveAllPendingDiffApprovals(false)
          agentStore.setStatus('error')
          agentStore.setError(error.message)
          useChatStore.getState().finalizeAssistantMessage()
          hadError = true

          // Surface a "what happened + how to recover" system message for the
          // error classes that the user can recover from by re-running the
          // same prompt or sending "Continue". All onError callers in
          // agentService.ts now throw ServiceError with a known `code` —
          // no regex / string-matching here. If a new code needs the same
          // UX, add it to RECOVERABLE_UPSTREAM_CODES at the top of this file
          // and the surface message picks it up.
          const errorCode = (error as { code?: string }).code ?? 'UNKNOWN_ERROR'
          if (RECOVERABLE_UPSTREAM_CODES.has(errorCode)) {
            useChatStore.getState().addSystemMessage(
              t('chat.recoverableUpstreamError'),
              'error',
            )
          }
        },
        onUsageUpdate: (inputTokens, outputTokens) => {
          useChatStore.getState().addTokenUsage(inputTokens, outputTokens)
          // Display-only ("último pedido" em ApiKeysSection). A cobrança real
          // é exclusiva do worker ai-pass-through — ver billingStore.ts.
          useBillingStore.getState().addLastRequestTokens(inputTokens + outputTokens)
        },
        onContextCompression: (event) => {
          if (event.type === 'hooks_start') {
            agentStore.setCompactPhase(event.hookType === 'pre_compact' ? 'hooks_pre' : 'hooks_post')
          } else if (event.type === 'compact_start') {
            agentStore.setCompactPhase('compressing')
            agentStore.setStatus('compressing')
          } else if (event.type === 'compact_end') {
            agentStore.setCompactPhase('idle')
            agentStore.setStatus('awaiting_response')
            useChatStore.getState().addCompactBoundaryMessage(event.beforeTokens, event.trigger, event.messagesSummarized)
          }
        },
      })
    } catch (error) {
      // Cleanup if anything fails before or during runAgentLoop setup.
      // Prevents isStreaming/agentStatus getting stuck.
      flushBufferedDeltas()
      useChatStore.getState().finalizeAssistantMessage()
      agentStore.setStatus('idle')
      logger.error('prompt', 'runAgentForPrompt failed:', error)
      hadError = true
    }

    return !hadError
  }, [currentProject, devCommand])

  /**
   * handleSend — Claude Code style: ALL messages go through the queue first.
   *
   * The queue processor (useQueueProcessor) decides when to dequeue:
   *   - Agent idle → dequeue immediately
   *   - Agent busy → wait for query to end, then dequeue
   *
   * Slash commands are executed directly (never queued).
   */
  const handleSend = useCallback(async () => {
    const prompt = useChatStore.getState().draftInput.trim()
    const hasAttachments = useChatStore.getState().draftAttachments.length > 0
    if (!prompt && !hasAttachments) return
    if (usePermissionStore.getState().pendingPermission) return
    const phase = useLayoutStore.getState().scaffoldPhase
    if (phase === 'installing' || phase === 'starting') return

    // Check authentication
    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) return

    // Reset prompt history navigation
    historyIndexRef.current = -1
    savedDraftRef.current = ''

    // Close menus
    setShowCommandMenu(false)
    hashtagMenu.close()

    // === Plan-revision branch ===
    // When the user clicked "Request changes" on a PlanApprovalCard, the
    // architect flag is set. The NEXT user message is revision feedback,
    // NOT a normal prompt — route through executePlanRevision which
    // re-enters architect mode with the existing PLAN.md as context.
    // Slash commands (e.g. user types `/plan ...` to start over) win
    // over revision — handled below in the slash-command branch. Plain
    // prompts route here.
    const revisionProjectPath = useChatStore.getState().planRevisionPending
    if (revisionProjectPath && prompt && !slashCommandRegistry.isSlashCommand(prompt)) {
      const revisionTarget = typeof revisionProjectPath === 'string'
        ? { projectPath: revisionProjectPath, planPath: undefined }
        : revisionProjectPath
      // Clear the flag BEFORE dispatch so a subsequent message after the
      // revision turn falls back to the normal path. If revision fails,
      // the user can request changes again from the new card.
      useChatStore.getState().setPlanRevisionPending(null)
      useChatStore.getState().setDraftInput('')
      clearDraftAttachments()
      try {
        const { executePlanRevision } = await import('../../services/agent/commands/planCommand')
        await executePlanRevision(prompt, revisionTarget.projectPath, 'chat', revisionTarget.planPath)
      } catch (err) {
        logger.error('prompt', 'executePlanRevision failed:', err)
        useChatStore.getState().addSystemMessage(
          `Plan revision failed: ${(err as Error).message}. Try again or run /plan to restart.`,
        )
      }
      return
    }

    // === Slash commands: execute directly (never queued) ===
    // Slash commands take precedence over hashtag flows. A prompt that
    // STARTS with `/plan ...` is, by construction, asking the architect
    // command to run — even if the user mentions `#auth-google` inside the
    // idea ("a platform with #auth-google sign-in"). Without this order,
    // preprocessHashtags would consume the tag, route to runAuthFlow, and
    // the /plan command never executes. The hashtag is part of the
    // architectural description; the architect can address auth in PLAN.md.
    if (slashCommandRegistry.isSlashCommand(prompt)) {
      const command = slashCommandRegistry.getCommand(prompt)
      if (!command) return

      if (!command.enabled) {
        useChatStore.getState().setDraftInput('')
        clearDraftAttachments()
        useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`)
        return
      }

      // Paid-plan gate enforced at SUBMIT time, not just visually in the
      // SlashCommandMenu. The menu disables the row, but a user typing
      // `/te2e ...` and pressing Enter would otherwise bypass the visual
      // gate — the command's own paywall message catches it eventually,
      // but blocking here keeps the contract consistent and avoids
      // half-spawned side effects (e.g. browserSession.start).
      const billingPlan = useBillingStore.getState().plan
      if (command.requiresPaidPlan && !command.usesOwnPlanGate && !isSlashCommandAllowedForPlan(command, billingPlan)) {
        useChatStore.getState().setDraftInput('')
        clearDraftAttachments()
        useChatStore.getState().addSystemMessage(
          command.planGateMessageKey ? t(command.planGateMessageKey) : `${command.name} is a paid feature. Upgrade your plan in Settings to use it.`
        )
        useLayoutStore.getState().setViewMode('settings')
        return
      }

      const projectPath = currentProject?.path
      if (command.requiresProject !== false && !projectPath) {
        useChatStore.getState().setDraftInput('')
        clearDraftAttachments()
        useChatStore.getState().addSystemMessage('No project open. Open a project first.')
        return
      }

      // Smart router for /payments: if MoMenu Payments markers are already
      // in the project, block the re-scaffold with explanatory message.
      // Same rationale as the auth-hashtag router below — the slash command
      // is for first-time integration; subsequent fixes go through verbal
      // requests so the agent (which sees the appliedScaffolding system-
      // prompt section) routes to fix-mode rather than re-running fetches.
      if (command.name === '/payments') {
        const { blocked } = await guardScaffoldReapply(
          projectPath!,
          ['payments.momenu'],
          () => buildPaymentsReapplyMessage(),
          () => { useChatStore.getState().setDraftInput(''); clearDraftAttachments() },
        )
        if (blocked) return
      }

      useChatStore.getState().setDraftInput('')
      clearDraftAttachments()

      // Switch to chat so the user sees the agent working
      const layout = useLayoutStore.getState()
      if (layout.viewMode !== 'chat') {
        layout.setViewMode('chat')
      }

      const args = slashCommandRegistry.getArgs(prompt)
      // 'chat' = platform-bound surface. /plan branches on this to inject
      // the data-layer / Dockerfile / APP_ID-fallback invariants into the
      // architect's system prompt so the PLAN.md it produces is shaped
      // for the TM Code Publish pipeline (no Prisma/SQLite, firebase-admin
      // baseline, Dockerfile + backend in the same scaffold turn).
      await command.execute(args, projectPath ?? '', 'chat')
      return
    }

    // === Hashtag-driven flows: detect skill triggers (e.g. #auth-google,
    // #design) and route to the specialised flow. Replaces the legacy /auth
    // slash command. Free-form `#tags` not in the registry are ignored and
    // pass through to the agent untouched.
    //
    // Runs AFTER the slash-command check so a prompt like
    // `/plan ... with #auth-google ...` doesn't have the hashtag stripped
    // out from under /plan — slash commands own the dispatch in that case.
    const pre = preprocessHashtags(prompt)
    if (pre.authProviders.length > 0 || pre.hasDesign) {
      const projectPath = currentProject?.path
      if (!projectPath) {
        useChatStore.getState().setDraftInput('')
        clearDraftAttachments()
        useChatStore.getState().addSystemMessage('No project open. Open a project first.')
        return
      }

      useChatStore.getState().setDraftInput('')
      clearDraftAttachments()

      const layout = useLayoutStore.getState()
      if (layout.viewMode !== 'chat') {
        layout.setViewMode('chat')
      }

      // Smart router: if any requested auth provider is already applied,
      // block the re-scaffold flow with an explanatory system message. The
      // hashtag is for FIRST-TIME provisioning; for fixing the existing
      // implementation the user should phrase verbally ("Corrige o login
      // com Google"). The agent then sees the `# Already-applied
      // scaffolding` system-prompt section and routes to fix-mode.
      if (pre.authProviders.length > 0) {
        const requestedKeys: import('../../services/scaffoldingDetector').ScaffoldKey[] =
          pre.authProviders.map(p => `auth.${p}` as const)
        const { blocked } = await guardScaffoldReapply(
          projectPath,
          requestedKeys,
          (applied) => buildAuthReapplyMessage(applied),
          () => { useChatStore.getState().setDraftInput(''); clearDraftAttachments() },
        )
        if (blocked) return
      }

      // Preserve hashtags in the visible message and the persisted history.
      // The hashtag is still useful AFTER it routes — it documents the user's
      // intent for anyone reading the session later (debug exports, sharing
      // a repro, scrolling back), and it's what they actually typed. The
      // skill content is force-loaded via runAuthFlow regardless of what
      // appears in the bubble, so stripping the tag here used to delete
      // signal for no behavioural gain.
      const bubbleText = prompt

      if (pre.authProviders.length > 0) {
        // Auth flow handles design augmentation when both are requested.
        await runAuthFlow(pre.authProviders, pre.cleanedText, bubbleText, pre.hasDesign)
      } else {
        // Design-only flow: lightweight skill injection, no execution sequence.
        await runDesignFlow(pre.cleanedText, bubbleText)
      }
      return
    }

    // === ALL other messages: ALWAYS enqueue first ===
    // The queue processor will dequeue when the agent is idle.
    // This matches Claude Code's behavior — no conditional gating on isAgentBusy.
    const attachments = [...useChatStore.getState().draftAttachments]

    // Build the queued value. Plain text → string. With attachments →
    // ContentBlock[] interleaving text + attachments.
    let value: PromptValue
    if (attachments.length === 0) {
      value = prompt
    } else {
      const blocks: ContentBlock[] = []
      if (prompt.length > 0) blocks.push({ type: 'text', text: prompt })
      for (const att of attachments) {
        blocks.push({ type: 'attachment', attachment: att })
      }
      value = blocks
    }

    // The queued message lives only in the queue (rendered by
    // QueuedMessagesPreview above the input). The chat bubble is created
    // freshly when executeQueuedInput dispatches via runAgentForPrompt —
    // matches Claude Code's separation of "queued preview" and "transcript
    // entry", which removes any chance of a position race against the
    // AgentActivityIndicator's elapsed-time message.
    enqueueMessage({
      value,
      mode: 'prompt',
      priority: 'next',
      uuid: generateId('queued'),
    })

    // Clear input immediately — message is in the queue
    useChatStore.getState().setDraftInput('')
    clearDraftAttachments()

    logger.info('queue', `Message enqueued: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`)
  }, [currentProject, devCommand, runAgentForPrompt])

  const handleStop = useCallback(() => {
    // Clear the message queue BEFORE cancelling — prevents useQueueProcessor
    // from firing when queryGuard transitions to idle.
    clearMessageQueue()

    // Check if there are pending permissions that will be cancelled
    const pendingCount = usePermissionStore.getState().getQueuedCount()
    if (pendingCount > 0) {
      const confirmed = window.confirm(
        `There are ${pendingCount} pending permission${pendingCount > 1 ? 's' : ''} in the queue. ` +
        `Stopping will cancel all of them. Continue?`
      )
      if (!confirmed) return
    }

    // Clear any pending permission first — resolves the dangling Promise
    usePermissionStore.getState().clearPending()
    // Resolve any pending diff approval waits (rejects them)
    resolveAllPendingDiffApprovals(false)
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }, [clearMessageQueue])

  // === Queue processor — runs queued commands when agent becomes idle ===
  //
  // `commands` is whatever processQueueIfReady decided to drain:
  //  - Slash/bash modes: a single command (one at a time).
  //  - Prompt mode: all consecutive prompt-mode commands batched together.
  //  - Task notifications: all task-notification commands batched together.
  //
  // For prompt mode we additionally coalesce the values into a single
  // agent turn (Claude Code's joinPromptValues), so 3 quick messages
  // become ONE round-trip to the model instead of three. Attachments
  // from all batched commands are concatenated.
  //
  // After the agent loop returns, the QueryGuard transitions back to
  // idle and useQueueProcessor's effect re-fires, picking up anything
  // that was enqueued while we were running. No manual dequeueAll loop
  // is needed here — the React effect IS the loop.
  const executeQueuedInput = useCallback(async (commands: QueuedCommand[]) => {
    if (commands.length === 0) return

    // Reserve the QueryGuard SYNCHRONOUSLY before any await. This closes the
    // window where the queue snapshot changes (post-dequeue or new enqueue)
    // could re-fire useQueueProcessor's effect with isQueryActive=false and
    // dispatch a second concurrent runAgentForPrompt while createNewSession
    // is still pending inside the first one. tryStart() inside runAgentLoop
    // transitions dispatching→running; if reserve fails, another dispatch
    // already owns the guard and we yield to it.
    if (!queryGuard.reserve()) return

    try {
      // Switch to chat so the user sees the agent working
      const layoutStore = useLayoutStore.getState()
      if (layoutStore.viewMode !== 'chat') {
        layoutStore.setViewMode('chat')
      }

      const head = commands[0]!
      // Coalesce prompt-mode batches into a single turn. joinPromptValues
      // handles both string-only and block-mixed inputs:
      //   - all strings → single newline-joined string
      //   - any blocks  → concatenated block array (order preserved)
      const mergedValue: PromptValue =
        head.mode === 'prompt' && commands.length > 1
          ? joinPromptValues(commands.map(c => c.value))
          : head.value

      const planResumePending = useChatStore.getState().planResumePending
      if (planResumePending && head.mode === 'prompt') {
        const display = extractDisplayFromValue(mergedValue)
        const blocks = typeof mergedValue === 'string' ? undefined : mergedValue
        const activeProjectPath = useProjectStore.getState().currentProject?.path || ''

        if (activeProjectPath !== planResumePending.projectPath) {
          useChatStore.getState().addUserMessage(display.text, display.attachments, blocks)
          useChatStore.getState().addSystemMessage(t('plan.resumeWrongProject'), 'warn')
          return
        }

        const intent = classifyPendingPlanIntent(display.text)
        if (intent === 'cancel') {
          useChatStore.getState().addUserMessage(display.text, display.attachments, blocks)
          useChatStore.getState().setPlanResumePending(null)
          useChatStore.getState().addSystemMessage(t('plan.resumeCancelled'))
          return
        }

        try {
          const { executePlanResume } = await import('../../services/agent/commands/planCommand')
          await executePlanResume(display.text, planResumePending, display.attachments, blocks)
        } catch (err) {
          logger.error('prompt', 'executePlanResume failed:', err)
          useChatStore.getState().addSystemMessage(
            `Plan resume failed: ${(err as Error).message}. Run /plan again to restart.`,
            'error',
          )
        }
        return
      }

      // The bubble is created on dispatch (inside runAgentForPrompt) —
      // never at enqueue time. QueuedMessagesPreview already shows the
      // pending message under the input, so the user has continuous
      // visibility, and the transcript entry only exists when the agent
      // actually receives the message. Cancellation is owned by
      // AgentService.cancelLoop() (called from handleStop), which
      // propagates the abort down to the in-flight fetch.
      await runAgentForPrompt(mergedValue, false)
    } finally {
      // Safety net: if runAgentForPrompt returned without ever entering
      // runAgentLoop's tryStart() (e.g. createNewSession threw, or the
      // concurrent-guard branch refused entry), the QueryGuard would be
      // pinned in 'dispatching'. cancelReservation() is a no-op when the
      // guard is idle (post-end) or running (still active), so this is
      // always safe to call.
      queryGuard.cancelReservation()
    }
  }, [runAgentForPrompt, queryGuard])

  useQueueProcessor({ executeQueuedInput })

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // #hashtag menu — shared hook returns true when the key was consumed.
      // Mutually exclusive with the mention menu but listed first to match
      // the priority enforced by handleInputChange.
      if (hashtagMenu.handleKeyDown(e)) return

      // @mention menu navigation — takes priority when open
      if (showMentionMenu && filteredMentions.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedMentionIndex(prev => prev <= 0 ? filteredMentions.length - 1 : prev - 1)
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedMentionIndex(prev => prev >= filteredMentions.length - 1 ? 0 : prev + 1)
          return
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          const selected = filteredMentions[selectedMentionIndex]
          if (selected) handleMentionSelect(selected)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowMentionMenu(false)
          return
        }
      }

      // Prompt history navigation (Up/Down when menu is NOT open)
      // ArrowUp: only navigate to previous history if cursor is at the START of text (position 0)
      // ArrowDown: only navigate to next history if cursor is at the END of text
      // Otherwise, let the arrow keys move the cursor normally within the text
      if (!showCommandMenu && !showMentionMenu && !hashtagMenu.show && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const textarea = textareaRef.current
        if (!textarea) return

        const cursorPos = textarea.selectionStart
        const textLen = textarea.value.length
        const hasSelection = textarea.selectionStart !== textarea.selectionEnd

        // Don't navigate history if there's a text selection — let arrow keys collapse it
        if (hasSelection) return
        if (e.key === 'ArrowUp' && cursorPos !== 0) return
        if (e.key === 'ArrowDown' && cursorPos !== textLen) return

        const session = useChatStore.getState().getActiveSession()
        if (!session) return

        // Get user messages as history (most recent last, deduplicated)
        const history: string[] = []
        for (const m of session.messages) {
          if (m.role === 'user' && m.content.trim()) {
            const text = m.content
            if (history.length === 0 || history[history.length - 1] !== text) {
              history.push(text)
            }
          }
        }

        if (history.length === 0) return

        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (historyIndexRef.current === -1) {
            savedDraftRef.current = useChatStore.getState().draftInput
          }
          if (historyIndexRef.current < history.length - 1) {
            historyIndexRef.current++
            navigatingHistoryRef.current = true
            const entry = history[history.length - 1 - historyIndexRef.current]
            setInput(entry)
            // Place cursor at start so consecutive ArrowUp navigates immediately
            requestAnimationFrame(() => {
              if (textarea) { textarea.selectionStart = 0; textarea.selectionEnd = 0 }
            })
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (historyIndexRef.current > 0) {
            historyIndexRef.current--
            navigatingHistoryRef.current = true
            const entry = history[history.length - 1 - historyIndexRef.current]
            setInput(entry)
            // Place cursor at end so consecutive ArrowDown navigates immediately
            requestAnimationFrame(() => {
              if (textarea) { textarea.selectionStart = entry.length; textarea.selectionEnd = entry.length }
            })
          } else if (historyIndexRef.current === 0) {
            historyIndexRef.current = -1
            navigatingHistoryRef.current = true
            setInput(savedDraftRef.current)
            requestAnimationFrame(() => {
              if (textarea) {
                const len = savedDraftRef.current.length
                textarea.selectionStart = len; textarea.selectionEnd = len
              }
            })
          }
        }
        setShowCommandMenu(false)
        return
      }

      // Slash command menu navigation
      if (showCommandMenu && filteredCommands.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1
          )
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev >= filteredCommands.length - 1 ? 0 : prev + 1
          )
          return
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          const selected = filteredCommands[selectedCommandIndex]
          if (selected) handleCommandSelect(selected)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCommandMenu(false)
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, showCommandMenu, filteredCommands, selectedCommandIndex, handleCommandSelect, showMentionMenu, filteredMentions, selectedMentionIndex, handleMentionSelect, hashtagMenu]
  )

  const toggleEditor = useCallback(() => {
    const layoutStore = useLayoutStore.getState()
    if (layoutStore.viewMode === 'editor') {
      layoutStore.goBack()
    } else {
      layoutStore.setViewMode('editor')
    }
  }, [])

  const togglePreview = useCallback(async () => {
    const layout = useLayoutStore.getState()

    // If already in preview → toggle off.
    if (layout.viewMode === 'preview') {
      layout.goBack()
      return
    }

    // Delegate to the shared activation function (also used by ChatView's
    // header button). It handles detection, server start, and view switch.
    await activatePreview(currentProject?.path ?? null)
  }, [currentProject?.path])

  return {
    hasInputContent,
    setInput: handleInputChange,
    textareaRef,
    isStreaming,
    isAgentBusy,
    isScaffolding,
    isSendBlocked,
    isDisabled,
    hasPendingCredential,
    viewMode,
    hasPreview,
    handleSend,
    handleStop,
    handleKeyDown,
    handleBlur,
    toggleEditor,
    togglePreview,
    // Slash command menu
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    isArgMode,
    handleCommandSelect,
    // @mention menu
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    handleMentionSelect,
    // #hashtag menu — shared hook (state + handlers)
    hashtagMenu,
    // Already-applied scaffolding hints — drives the "já aplicado" badge in
    // both the hashtag and slash menus. Map keyed by tag (`#auth-google`)
    // or command name (`/payments`); value is the recommended fix phrasing.
    appliedHints,
    // Attachments
    draftAttachments,
    handleAttachFiles,
    handlePaste,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handleRemoveAttachment,
    isDragging,
  }
}

// ── Scaffold-reapply system messages ──────────────────────────────────
//
// Pure builders. Kept module-scope (not inside the hook) so they don't
// re-allocate per render. Wording is i18n-resolved at call time so the
// developer's IDE language drives the output.

function buildAuthReapplyMessage(applied: ScaffoldKey[]): string {
  const labels = applied.map(scaffoldKeyLabel).join(' + ')
  const fixHint = applied.includes('auth.google')
    ? t('scaffold.message.authFixHintGoogle')
    : t('scaffold.message.authFixHintEmail')
  return t('scaffold.message.authReapply')
    .replace('{labels}', labels)
    .replace('{fixHint}', fixHint)
}

function buildPaymentsReapplyMessage(): string {
  return t('scaffold.message.paymentsReapply')
}
