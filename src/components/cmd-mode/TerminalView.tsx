import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useMessageWindow } from '../../hooks/useMessageWindow'
import { usePermissionStore } from '../../stores/permissionStore'

import { useAskUserQuestionStore } from '../../stores/askUserQuestionStore'
import { useCmdOverlayStore } from '../../stores/cmdOverlayStore'
import { useTerminalPanelStore, TERMINAL_PANEL_MIN_WIDTH } from '../../stores/terminalPanelStore'
import { useSettingsStore, CHAT_TEXT_FONT_SIZE_OPTIONS, DEFAULT_CHAT_TEXT_FONT_SIZE } from '../../stores/settingsStore'
import { stopAgent, loadSessionById } from '../../services/agent/cmdModeCommands'
import CmdModePromptInput, { type CmdModePromptInputRef } from './CmdModePromptInput'
import { TerminalTitleBar } from './TerminalTitleBar'
import { TerminalStatusLine } from './TerminalStatusLine'
import { TerminalMessageRenderer } from './TerminalMessageRenderer'
import { TerminalGreeting } from './TerminalGreeting'
import { TerminalPanel } from './TerminalPanel'
import { BillingOverageBanner } from './BillingOverageBanner'
import { ErrorBoundary } from './terminalHelpers'
import { TerminalPermissionPrompt } from './TerminalPermissionPrompt'
import { TerminalSessionPicker } from './TerminalSessionPicker'
import AgentTasksPanel from '../chat/AgentTasksPanel'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useAttachments } from '../../hooks/useAttachments'
import { useTranslation } from '@/i18n/useTranslation'
import { tokens } from '@/theme/tokens'
import { FiChevronDown } from 'react-icons/fi'
import { hasCopyableSelection } from './terminalKeyboard'

interface TerminalViewProps {
  projectPath: string
  onBack: () => void
}

const TerminalView: React.FC<TerminalViewProps> = ({ projectPath, onBack }) => {
  const t = useTranslation()
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const streamingVersion = useChatStore(s => s.streamingVersion)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const agentStatus = useAgentStore(s => s.status)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const hasPendingAskUserQuestion = useAskUserQuestionStore(s => s.pending.size > 0)
  const chatTextFontSize = useSettingsStore(s => s.chatTextFontSize)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  // Track if we've ever had messages — prevents flicker when first message
  // is added and then immediately removed (e.g. session switch, clear).
  // Also used to fade out the greeting smoothly instead of abrupt removal.
  const [hasEverHadMessages, setHasEverHadMessages] = useState(false)

  useEffect(() => {
    if (messages.length > 0) {
      setHasEverHadMessages(true)
    }
  }, [messages.length])

  const sessionPickerOpen = useCmdOverlayStore(s => s.sessionPickerOpen)
  const sessionPickerItems = useCmdOverlayStore(s => s.sessionPickerItems)
  const sessionPickerActiveId = useCmdOverlayStore(s => s.sessionPickerActiveId)

  const promptInputRef = useRef<CmdModePromptInputRef>(null)
  const isStreamingRef = useRef(isStreaming)
  const agentStatusRef = useRef(agentStatus)
  const pendingPermissionRef = useRef(pendingPermission)
  const prevPendingPermissionRef = useRef(pendingPermission)
  const sessionPickerOpenRef = useRef(sessionPickerOpen)
  const hasPendingAskUserQuestionRef = useRef(hasPendingAskUserQuestion)
  const prevHasPendingAskUserQuestionRef = useRef(hasPendingAskUserQuestion)

  useEffect(() => {
    sessionPickerOpenRef.current = sessionPickerOpen
  }, [sessionPickerOpen])

  useEffect(() => {
    hasPendingAskUserQuestionRef.current = hasPendingAskUserQuestion
  }, [hasPendingAskUserQuestion])

  // Restore focus when ask_user_question prompt clears (after submit/cancel).
  // Blur on appear — same hidden-textarea/IME-ghosting issue as the
  // permission prompt (see the pendingPermission effect below).
  useEffect(() => {
    const wasBlocked = prevHasPendingAskUserQuestionRef.current
    prevHasPendingAskUserQuestionRef.current = hasPendingAskUserQuestion
    if (!wasBlocked && hasPendingAskUserQuestion) {
      promptInputRef.current?.blur()
      return
    }
    if (wasBlocked && !hasPendingAskUserQuestion) {
      const t = setTimeout(() => promptInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [hasPendingAskUserQuestion])

  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    agentStatusRef.current = agentStatus
  }, [agentStatus])

  useEffect(() => {
    pendingPermissionRef.current = pendingPermission
  }, [pendingPermission])

  // Clear chat state when this TerminalView unmounts (user switched
  // projects or went back to Welcome). Without this, activeSessionId
  // persists in the Zustand store and the next project's TerminalView
  // mounts with stale messages from the previous project.
  //
  // saveSessionToDisk captures the session snapshot synchronously (before
  // its first await), so it's safe to fire-and-forget — the disk write
  // uses its own copy of the messages regardless of what happens to the
  // store afterward. clearAllSessions must run synchronously in the
  // cleanup so the new TerminalView mounts into a clean store.
  useEffect(() => {
    return () => {
      const state = useChatStore.getState()
      if (state.isStreaming) stopAgent()
      // Fire-and-forget: snapshot captured sync inside saveSessionToDisk.
      state.saveSessionToDisk().catch(() => {})
      // Synchronous: wipe store before the next component mounts.
      useChatStore.getState().clearAllSessions()
    }
  }, [])

  // Create a session if none exists (fresh mount or after cleanup above).
  // Guard with a ref to prevent the effect from re-firing when createSession
  // changes activeSessionId, which would otherwise cause a render loop.
  const sessionCreatedRef = useRef(false)
  useEffect(() => {
    if (!projectPath) return
    sessionCreatedRef.current = false
    return () => { sessionCreatedRef.current = false }
  }, [projectPath])

  useEffect(() => {
    if (!projectPath || sessionCreatedRef.current) return
    if (!useChatStore.getState().activeSessionId) {
      sessionCreatedRef.current = true
      useChatStore.getState().createSession(projectPath)
    }
  }, [activeSessionId, projectPath])

  // Focus the prompt input on mount so the user can start typing immediately.
  useEffect(() => {
    const t = setTimeout(() => promptInputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  // Hydrate per-project state. Terminal Mode bypasses projectStore.openProject
  // (it invokes Rust open_project directly), so we must clear stale state from
  // the previous project and load the new project's data here — same logic as
  // projectStore.openProject lines ~300-329.
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false

    // Tasks — hydrate new project's tasks.json atomically.
    // We do NOT clear before load: clearTasks() + async loadFromDisk creates
    // a race window where the store is empty but tasks.json still exists on
    // disk. If the agent reads prompt context during this gap, it sees
    // tasks=[] and may re-seed a fresh tracker, overwriting the real state.
    // Instead, loadFromDisk resolves with the new project's tasks (or []),
    // and setTasks() atomically replaces the old project's data — no
    // intermediate empty state. If the load fails, we clear stale data as
    // a fallback (old project's tasks are worse than empty).
    const { setTasks, clearTasks } = useAgentStore.getState()
    import('../../services/agent/taskPersistence').then(({ loadTasksFromDisk }) =>
      loadTasksFromDisk(projectPath)
        .then(tasks => { if (!cancelled) setTasks(tasks) })
        .catch(() => { if (!cancelled) clearTasks() }),
    )

    // Permissions — clear stale trust grants, hydrate new project's
    // permissions.json. Without this, scopes approved in Project A leak
    // into Project B (auto-approved tools without user consent).
    import('../../stores/permissionStore').then(({ hydrateApprovedScopes }) =>
      import('../../services/agent/permissionPersistence').then(({ loadPermissionsFromDisk }) =>
        loadPermissionsFromDisk(projectPath)
          .then(perms => { if (!cancelled) hydrateApprovedScopes(perms.scopes, projectPath, perms.tools, perms.directories) })
          .catch(() => { /* non-critical — empty grants means re-prompt */ }),
      ),
    )

    return () => { cancelled = true }
  }, [projectPath])

  // Notify backend of project path exactly once per path.
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    const promise = import('@tauri-apps/api/core').then(({ invoke }) => {
      if (!cancelled) return invoke('open_project', { path: projectPath })
    })
    return () => {
      cancelled = true
      // Await the promise so the callback stays alive until Rust responds.
      promise?.catch(() => {})
    }
  }, [projectPath])

  // use-stick-to-bottom: ResizeObserver-based auto-scroll that handles
  // streaming content, expanding diffs, and dynamic height changes.
  // Replaces the old useCmdScrollFollow hook whose manual scrollTop
  // approach missed content-height changes between buffer flushes.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({
    resize: 'instant',
    initial: 'instant',
  })

  // Pagination — same shape used by chat. Render the latest 30 messages,
  // expand the window as the user scrolls back through history. Reset on
  // session switch so the new session starts at the bottom.
  // pageSize=2 — CMD turns include similar tool-call density.
  const { visibleItems, canLoadMore, loadMore, hiddenCount } = useMessageWindow(messages, {
    resetKey: activeSessionId,
    pageSize: 2,
  })

  // Top sentinel — IntersectionObserver fires when the user scrolls up
  // close to the start of the visible window. Capture scrollHeight before
  // React commits the larger list, then offset scrollTop by the delta so
  // the viewport stays anchored on the same line instead of being pushed
  // upward by the height of the freshly-prepended messages. `isLoadingMoreRef`
  // guards against cascade triggers when the sentinel briefly re-intersects
  // the rootMargin band before the scroll restore lands.
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const isLoadingMoreRef = useRef(false)
  useEffect(() => {
    if (!canLoadMore) return
    const sentinel = loadMoreSentinelRef.current
    const scrollEl = scrollRef.current
    if (!sentinel || !scrollEl) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        if (isLoadingMoreRef.current) return
        isLoadingMoreRef.current = true
        const beforeHeight = scrollEl.scrollHeight
        const beforeTop = scrollEl.scrollTop
        loadMore()
        // Double rAF — see ChatView. CMD mode uses `useStickToBottom`
        // (ResizeObserver-based) but the principle is the same: let the
        // follow logic settle before our manual scrollTop write.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const delta = scrollEl.scrollHeight - beforeHeight
            if (delta > 0) scrollEl.scrollTop = beforeTop + delta
            setTimeout(() => { isLoadingMoreRef.current = false }, 200)
          })
        })
      },
      { root: scrollEl, rootMargin: '120px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canLoadMore, loadMore, scrollRef])

  // Window-wide drop support — any area of CMD mode (header, banners, scroll
  // area) becomes a drop target. The visual overlay still lives in the prompt
  // input; both subscribe to the same cmdAttachmentStore so state stays in sync.
  const {
    handleDragOver: onViewDragOver,
    handleDragEnter: onViewDragEnter,
    handleDragLeave: onViewDragLeave,
    handleDrop: onViewDrop,
  } = useAttachments({ localState: true })

  // Focus input only when click lands on the container itself (not on code/copy/mention etc).
  // Skip when the terminal just opened (suppressPromptFocusRef) so xterm keeps focus.
  const handleOutputClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (pendingPermission || suppressPromptFocusRef.current) return
    const target = e.target as HTMLElement
    if (target.closest('[data-no-focus-steal], button, a, textarea, input, [role="button"]')) return
    const sel = window.getSelection()
    if (sel && sel.toString().length > 0) return
    promptInputRef.current?.focus()
  }, [pendingPermission])

  // Restore focus when permission prompt clears. On the opposite edge —
  // prompt APPEARING while the user is mid-typing — explicitly blur the
  // prompt textarea. Hiding it with display:none doesn't reliably drop
  // focus in WKWebView, so subsequent keystrokes kept feeding the hidden
  // field and macOS rendered the IME composition in a floating panel over
  // where the box used to be ("ghost characters").
  useEffect(() => {
    const wasBlocked = prevPendingPermissionRef.current
    prevPendingPermissionRef.current = pendingPermission
    if (!wasBlocked && pendingPermission) {
      promptInputRef.current?.blur()
      return
    }
    if (wasBlocked && !pendingPermission) {
      const t = setTimeout(() => promptInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [pendingPermission])

  // Native terminal keyboard shortcuts.
  // Ctrl/Cmd+C: stop agent if active and no selected text would be copied
  // Ctrl+L: scroll to bottom (like native terminal clear)
  // Ctrl+K / Ctrl+U: clear input line (native terminal / readline kill-line)
  // Cmd/Ctrl + = / - / 0: font zoom in / out / reset (iTerm2, Terminal.app)
  useEffect(() => {
    const isAgentActive = () => {
      const status = agentStatusRef.current
      return isStreamingRef.current || (status !== 'idle' && status !== 'error')
    }
    const stepFontSize = (direction: 1 | -1 | 0) => {
      const { chatTextFontSize, setChatTextFontSize } = useSettingsStore.getState()
      if (direction === 0) {
        setChatTextFontSize(DEFAULT_CHAT_TEXT_FONT_SIZE)
        return
      }
      const idx = (CHAT_TEXT_FONT_SIZE_OPTIONS as readonly number[]).indexOf(chatTextFontSize)
      const nextIdx = Math.min(CHAT_TEXT_FONT_SIZE_OPTIONS.length - 1, Math.max(0, idx + direction))
      setChatTextFontSize(CHAT_TEXT_FONT_SIZE_OPTIONS[nextIdx])
    }
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd+C — stop agent when it is active, including non-streaming tool phases.
      // If the user has selected text in chat, prompt, terminal output, or Monaco,
      // leave the browser/editor copy behavior untouched.
      if (e.key === 'c' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (isAgentActive() && !hasCopyableSelection(e.target)) {
          e.preventDefault()
          e.stopPropagation()
          stopAgent()
          return
        }
      }
      // Ctrl+L — scroll to bottom (native terminal behavior)
      if (e.key === 'l' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        wasAtBottomRef.current = true
        scrollToBottom()
        return
      }
      // Ctrl+K — clear input line (native terminal behavior).
      // Ctrl+U — readline kill-line, same effect here (no cursor-relative
      // splitting in a multi-line prompt box; full-clear matches user intent).
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey) && !e.shiftKey) ||
          (e.key === 'u' && e.ctrlKey && !e.metaKey && !e.shiftKey)) {
        if (promptInputRef.current?.hasText?.()) {
          e.preventDefault()
          e.stopPropagation()
          window.dispatchEvent(new CustomEvent('cmd-clear-input'))
          return
        }
      }
      // Cmd/Ctrl + = / + — zoom in, - — zoom out, 0 — reset (terminal parity).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          e.stopPropagation()
          stepFontSize(1)
          return
        }
        if (e.key === '-') {
          e.preventDefault()
          e.stopPropagation()
          stepFontSize(-1)
          return
        }
        if (e.key === '0') {
          e.preventDefault()
          e.stopPropagation()
          stepFontSize(0)
          return
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [scrollToBottom])

  // Unified Escape handler. Priority:
  //   1. Permission prompt owns Escape while visible (handled by the prompt itself)
  //   2. AskUserQuestion owns Escape (cancels the question)
  //   3. Session picker owns Escape (closes picker, does NOT exit CMD Mode)
  //   4. Terminal panel open → close panel (does NOT exit CMD Mode)
  //   5. Open menus (slash / @mention) own Escape to close themselves
  //   6. Streaming → stop agent
  //   7. Typing with text → let the textarea handle it
  //   8. Idle → exit to welcome
  useEffect(() => {
    const isAgentActive = () => {
      const status = agentStatusRef.current
      return isStreamingRef.current || (status !== 'idle' && status !== 'error')
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (pendingPermissionRef.current) return
      // AskUserQuestion component handles its own Escape — don't exit CMD mode.
      if (hasPendingAskUserQuestionRef.current) return
      // Picker's own onKeyDown also handles Esc, but a click elsewhere can
      // defocus the overlay — intercept here too so Escape never leaks out
      // of CMD Mode while the picker is open.
      if (sessionPickerOpenRef.current) {
        e.preventDefault()
        e.stopPropagation()
        useCmdOverlayStore.getState().closeSessionPicker()
        return
      }
      // Close terminal panel first if open — don't exit CMD mode entirely.
      if (useTerminalPanelStore.getState().isOpen) {
        e.preventDefault()
        e.stopPropagation()
        useTerminalPanelStore.getState().close()
        return
      }
      if (promptInputRef.current?.isMenuOpen?.()) return
      if (isAgentActive()) {
        e.preventDefault()
        e.stopPropagation()
        stopAgent()
        return
      }
      const ae = document.activeElement as HTMLElement | null
      const tag = ae?.tagName
      const isTyping = tag === 'TEXTAREA' || tag === 'INPUT' || ae?.isContentEditable
      const hasInputText = !!(promptInputRef.current?.hasText?.())
      if (isTyping && hasInputText) return
      e.preventDefault()
      e.stopPropagation()
      onBack()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onBack])

  // Close the session picker automatically if the user leaves CMD Mode.
  useEffect(() => {
    return () => { useCmdOverlayStore.getState().closeSessionPicker() }
  }, [])

  const handlePickSession = useCallback(async (session: { id: string }) => {
    useCmdOverlayStore.getState().closeSessionPicker()
    // Clear draft attachments when switching sessions
    promptInputRef.current?.clearAttachments()
    await loadSessionById(session.id, projectPath)
    // Wait a frame for React to commit the new messages before restoring focus.
    // Using requestAnimationFrame instead of a fixed timeout avoids the race
    // where 40ms isn't enough for a slow session load.
    requestAnimationFrame(() => {
      promptInputRef.current?.focus()
    })
  }, [projectPath])

  const handleClosePicker = useCallback(() => {
    useCmdOverlayStore.getState().closeSessionPicker()
    setTimeout(() => promptInputRef.current?.focus(), 40)
  }, [])

  // Track whether user was at bottom before streaming started.
  // Once the user scrolls away during streaming, we stop forcing scroll
  // until they manually return to the bottom (clicking the ↓ button or
  // scrolling back down). This prevents the scroll from yanking the user
  // away from content they're reading mid-stream.
  const wasAtBottomRef = useRef(true)
  const prevStreamingRef = useRef(false)

  // When the user expands/collapses an inline element (reasoning block,
  // tool call, diff), the message height changes and the stick-to-bottom
  // ResizeObserver fires scrollToBottom. If the user clicked an element
  // ABOVE the current viewport, that yanks them away from what they were
  // reading. We listen for an explicit interaction event from those
  // expand/collapse handlers and freeze stick-to-bottom for a tick so the
  // upcoming resize doesn't auto-scroll.
  const isAtBottomRef = useRef(isAtBottom)
  isAtBottomRef.current = isAtBottom
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onInteraction = () => {
      if (!isAtBottomRef.current) {
        wasAtBottomRef.current = false
      }
    }
    window.addEventListener('cmd-toggle-interaction', onInteraction)
    return () => window.removeEventListener('cmd-toggle-interaction', onInteraction)
  }, [])

  // Synchronously scroll to bottom when a new message is added and the user was already at the bottom.
  // This prevents the scroll-jump effect when the user sends a message.
  useLayoutEffect(() => {
    if (wasAtBottomRef.current) {
      scrollToBottom()
    }
  }, [messages.length, scrollToBottom])

  // Consolidated scroll effect — handles all three concerns in deterministic
  // order to prevent race conditions between the separate wasAtBottom tracking,
  // streaming scroll, and end-of-stream scroll effects.
  useEffect(() => {
    // 1. Track wasAtBottom
    if (isAtBottom) {
      wasAtBottomRef.current = true
    } else if (isStreaming) {
      wasAtBottomRef.current = false
    }

    // 2. Force scroll during streaming if user was at bottom
    if (isStreaming && wasAtBottomRef.current) {
      scrollToBottom()
    }

    // 3. When streaming ends, force final scroll after DOM settles
    if (prevStreamingRef.current && !isStreaming && wasAtBottomRef.current) {
      const timer = setTimeout(() => scrollToBottom(), 80)
      prevStreamingRef.current = isStreaming
      return () => clearTimeout(timer)
    }
    prevStreamingRef.current = isStreaming
  }, [streamingVersion, isStreaming, isAtBottom, scrollToBottom])

  // Terminal bell — when streaming ends and the window is not focused,
  // flash the document title to get the user's attention (like iTerm2).
  //
  // Owns its own prev-streaming ref. It previously shared prevStreamingRef
  // with the consolidated scroll effect above — which runs first (declaration
  // order) and overwrites the ref to the CURRENT isStreaming, so by the time
  // this effect compared it the edge was gone and the bell never rang.
  const prevStreamingBellRef = useRef(false)
  useEffect(() => {
    const wasStreaming = prevStreamingBellRef.current
    prevStreamingBellRef.current = isStreaming
    if (wasStreaming && !isStreaming) {
      if (document.hidden) {
        const originalTitle = document.title
        document.title = '✓ Done — Terminal'
        const resetTitle = () => {
          document.title = originalTitle
          document.removeEventListener('visibilitychange', resetTitle)
        }
        document.addEventListener('visibilitychange', resetTitle)
        // Also reset after 5s in case the user never returns
        const autoReset = setTimeout(resetTitle, 5000)
        const cleanup = () => { clearTimeout(autoReset); resetTitle() }
        return cleanup
      }
    }
  }, [isStreaming])

  // Kill all PTY sessions when leaving the project (unmount TerminalView).
  useEffect(() => {
    return () => { useTerminalPanelStore.getState().killAll() }
  }, [])

  // Track outer container width so we can clamp the panel to max 50% of the IDE.
  const outerRef = useRef<HTMLDivElement | null>(null)
  const [outerWidth, setOuterWidth] = useState<number>(0)
  useEffect(() => {
    if (!outerRef.current) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setOuterWidth(w)
    })
    ro.observe(outerRef.current)
    return () => ro.disconnect()
  }, [])

  // Subscribe to terminal-panel state.
  const terminalOpen = useTerminalPanelStore(s => s.isOpen)
  const terminalWidthPref = useTerminalPanelStore(s => s.widthPx)
  const setTerminalWidth = useTerminalPanelStore(s => s.setWidth)

  // Suppress prompt input focus until the terminal panel's PTY is ready.
  // onReady callback fires when start_pty_shell succeeds — clears the flag
  // so the xterm keeps focus and the textarea doesn't steal it back.
  // Fallback timeout: if onReady never fires (PTY failure, slow init),
  // clear the suppress after 500ms so the prompt isn't stuck forever.
  const suppressPromptFocusRef = useRef(false)
  const suppressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevTerminalOpenRef = useRef(terminalOpen)
  useEffect(() => {
    if (terminalOpen && !prevTerminalOpenRef.current) {
      suppressPromptFocusRef.current = true
      suppressTimeoutRef.current = setTimeout(() => {
        suppressPromptFocusRef.current = false
        suppressTimeoutRef.current = null
      }, 500)
    }
    prevTerminalOpenRef.current = terminalOpen
  }, [terminalOpen])
  const handleTerminalReady = useCallback(() => {
    if (suppressTimeoutRef.current) {
      clearTimeout(suppressTimeoutRef.current)
      suppressTimeoutRef.current = null
    }
    suppressPromptFocusRef.current = false
  }, [])
  // Cleanup suppress timeout on unmount
  useEffect(() => {
    return () => {
      if (suppressTimeoutRef.current) clearTimeout(suppressTimeoutRef.current)
    }
  }, [])

  const maxPanelWidth = outerWidth > 0 ? Math.floor(outerWidth * 0.5) : terminalWidthPref
  const clampedPanelWidth = Math.min(terminalWidthPref, Math.max(TERMINAL_PANEL_MIN_WIDTH, maxPanelWidth))

  const terminalTextScaleStyles = useMemo(() => {
    const bodySize = `${chatTextFontSize}px`
    const codeSize = `${Math.max(12, chatTextFontSize - 1)}px`
    return {
      '--terminal-a11y-text-size': bodySize,
      '--terminal-a11y-code-size': codeSize,
      '& [data-cmd-mode-root]': {
        fontSize: 'var(--terminal-a11y-text-size)',
      },
      '& [data-cmd-mode-root] :is(p, li, span, div, button, textarea, input, table, th, td):not([data-ui-chrome] *)': {
        fontSize: 'var(--terminal-a11y-text-size) !important',
        lineHeight: '1.6',
      },
      '& [data-cmd-mode-root] :is(code, pre, pre *):not([data-ui-chrome] *)': {
        fontSize: 'var(--terminal-a11y-code-size) !important',
        lineHeight: '1.6',
      },
      '& [data-cmd-mode-root] :is(h1):not([data-ui-chrome] *)': {
        fontSize: `${chatTextFontSize + 4}px !important`,
        lineHeight: '1.35',
      },
      '& [data-cmd-mode-root] :is(h2):not([data-ui-chrome] *)': {
        fontSize: `${chatTextFontSize + 2}px !important`,
        lineHeight: '1.4',
      },
      '& [data-cmd-mode-root] :is(h3):not([data-ui-chrome] *)': {
        fontSize: `${chatTextFontSize + 1}px !important`,
        lineHeight: '1.45',
      },
      '& [data-cmd-mode-root] :is(p, li, span, div, button, textarea, input, th, td, code, pre)': {
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      },
      '& [data-cmd-mode-root] :is(button, [role="button"])': {
        whiteSpace: 'normal',
      },
      // Native terminal selection — muted accent wash instead of the browser
      // default blue, matching iTerm2/Terminal.app feel.
      '& [data-cmd-mode-root] *::selection': {
        background: 'rgba(163, 113, 247, 0.30)',
        color: 'inherit',
      },
    }
  }, [chatTextFontSize])

  // Divider drag — captures pointer, updates width store.
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const handleDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragStateRef.current = { startX: e.clientX, startWidth: clampedPanelWidth }
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
  }, [clampedPanelWidth])
  const handleDividerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || outerWidth === 0) return
    // Cursor moving left widens the panel (panel is on the right edge).
    const next = drag.startWidth - (e.clientX - drag.startX)
    setTerminalWidth(Math.min(Math.floor(outerWidth * 0.5), Math.max(TERMINAL_PANEL_MIN_WIDTH, next)))
  }, [outerWidth, setTerminalWidth])
  const handleDividerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current) {
      dragStateRef.current = null
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    }
  }, [])

  return (
    <Flex
      ref={outerRef}
      direction="row"
      flex="1"
      minH={0}
      minW={0}
      bg={tokens.colors.terminal.background}
      color={tokens.colors.terminal.foreground}
      fontFamily={tokens.fontFamily.mono}
      fontSize={`${chatTextFontSize}px`}
      position="relative"
      overflow="hidden"
      css={terminalTextScaleStyles}
    >
    <Flex
      direction="column"
      flex="1"
      minW={0}
      minH={0}
      data-cmd-mode-root
      onDragOver={onViewDragOver}
      onDragEnter={onViewDragEnter}
      onDragLeave={onViewDragLeave}
      onDrop={onViewDrop}
    >
      <TerminalTitleBar projectPath={projectPath} onBack={onBack} />
      <BillingOverageBanner />

      {/* Output area — overflow="hidden" on the wrapper prevents large content
          from pushing siblings off-screen. Same pattern as ChatView. */}
      <Box position="relative" flex="1" minH={0} overflow="hidden">
      <Box
        ref={scrollRef}
        h="100%"
        overflowY="auto"
        px={3}
        pt={3}
        pb={0}
        onClick={handleOutputClick}
        cursor="text"
        css={{
          scrollbarGutter: 'stable',
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
        }}
      >
        <Box ref={contentRef} minH="100%">
          {isLoadingSession ? (
            <Box mb={2}>
              <Text color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} fontSize="12px">
                {t('terminalMode.view.loadingSession')}
              </Text>
            </Box>
          ) : (
            <AnimatePresence mode="wait">
              {messages.length === 0 && !hasEverHadMessages ? (
                <motion.div
                  key="greeting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                >
                  <TerminalGreeting projectPath={projectPath} />
                </motion.div>
              ) : (
                <motion.div
                  key="messages"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.2 } }}
                >
                  <Box pb={1} data-selectable="true">
              {canLoadMore && (
                <Box
                  as="button"
                  ref={loadMoreSentinelRef}
                  w="100%"
                  textAlign="left"
                  fontFamily={tokens.fontFamily.mono}
                  fontSize="11px"
                  fontWeight="500"
                  color={tokens.colors.text.muted}
                  py={2}
                  px={2}
                  mb={1}
                  borderRadius="4px"
                  bg={tokens.colors.bg.hoverSubtle}
                  border={`1px solid ${tokens.colors.border.panel}`}
                  cursor="pointer"
                  transition={`all ${tokens.transition.fast}`}
                  _hover={{
                    color: tokens.colors.text.primary,
                    borderColor: tokens.colors.border.glass,
                  }}
                  onClick={() => loadMore()}
                >
                  {t('terminalMode.view.loadEarlier').replace('{hiddenCount}', String(hiddenCount))}
                </Box>
              )}
              {visibleItems.map(msg => (
                <ErrorBoundary key={msg.id}>
                  <Box
                    css={{
                      animation: 'msgFadeIn 0.12s ease-out',
                      '@keyframes msgFadeIn': {
                        from: { opacity: '0', transform: 'translateY(3px)' },
                        to: { opacity: '1', transform: 'translateY(0)' },
                      },
                    }}
                  >
                    <TerminalMessageRenderer
                      message={msg}
                      isStreaming={msg.id === streamingMessageId}
                    />
                  </Box>
                </ErrorBoundary>
              ))}
            </Box>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </Box>
      </Box>
      </Box>

      {/* Scroll-to-bottom button — appears when user scrolls away from bottom */}
      {!isAtBottom && messages.length > 0 && (
        <Box
          position="absolute"
          bottom="12px"
          right="16px"
          as="button"
          w="28px"
          h="28px"
          borderRadius="full"
          bg="rgba(163, 113, 247, 0.15)"
          border="1px solid rgba(163, 113, 247, 0.3)"
          color={tokens.colors.accent.purple}
          cursor="pointer"
          display="flex"
          alignItems="center"
          justifyContent="center"
          onClick={() => {
            wasAtBottomRef.current = true
            scrollToBottom()
          }}
          zIndex={10}
          transition="all 0.15s"
          _hover={{ bg: 'rgba(163, 113, 247, 0.25)', transform: 'scale(1.1)' }}
          _active={{ transform: 'scale(0.95)' }}
          aria-label="Scroll to bottom"
        >
          <FiChevronDown size={16} />
        </Box>
      )}

      {pendingPermission && (
        <Box flexShrink={0}>
        <TerminalPermissionPrompt
          key={pendingPermission.id}
          toolName={pendingPermission.toolName}
          args={pendingPermission.args}
          promptReason={pendingPermission.promptReason}
          onApprove={() => usePermissionStore.getState().approve()}
          onApproveAll={() => usePermissionStore.getState().approveAll()}
          onDeny={() => usePermissionStore.getState().deny()}
          onDenyAll={() => usePermissionStore.getState().denyAll()}
          onDenyWith={(reason) => usePermissionStore.getState().denyWith(reason)}
        />
        </Box>
      )}

      {sessionPickerOpen && (
        <TerminalSessionPicker
          items={sessionPickerItems}
          activeSessionId={sessionPickerActiveId}
          onSelect={handlePickSession}
          onClose={handleClosePicker}
        />
      )}

      {/* Task list — appears when the agent defines tasks, hides when all complete */}
      <AgentTasksPanel />

      <Box flexShrink={0} data-tauri-drag-region>
        <TerminalStatusLine />
      </Box>

      <Box display={(pendingPermission || hasPendingAskUserQuestion) ? 'none' : undefined} flexShrink={0} data-no-focus-steal>
        <CmdModePromptInput ref={promptInputRef} />
      </Box>
    </Flex>
      {/* Keep TerminalPanel mounted when instances exist — CSS display toggle
          prevents unmount/remount which would call start_pty_shell on existing
          sessions. Instances persist after non-destructive close(). */}
      {useTerminalPanelStore.getState().instances.length > 0 && (
        <Flex display={terminalOpen ? 'flex' : 'none'} flexShrink={0}>
          <Box
            width="4px"
            flexShrink={0}
            cursor="col-resize"
            bg="rgba(255,255,255,0.04)"
            _hover={{ bg: 'rgba(254,16,99,0.4)' }}
            transition="background 0.12s"
            onPointerDown={handleDividerDown}
            onPointerMove={handleDividerMove}
            onPointerUp={handleDividerUp}
            onPointerCancel={handleDividerUp}
            aria-label={t('terminalMode.view.resizePanel')}
            role="separator"
          />
          <TerminalPanel projectPath={projectPath} widthPx={clampedPanelWidth} onReady={handleTerminalReady} />
        </Flex>
      )}
    </Flex>
  )
}

export default TerminalView
