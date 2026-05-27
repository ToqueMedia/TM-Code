import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useMessageWindow } from '../../hooks/useMessageWindow'
import { usePermissionStore } from '../../stores/permissionStore'
import { useCredentialRequestStore } from '../../stores/credentialRequestStore'
import { useAskUserQuestionStore } from '../../stores/askUserQuestionStore'
import { useCmdOverlayStore } from '../../stores/cmdOverlayStore'
import { useTerminalPanelStore, TERMINAL_PANEL_MIN_WIDTH } from '../../stores/terminalPanelStore'
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
import { useCmdScrollFollow } from '../../hooks/useCmdScrollFollow'
import { useAttachments } from '../../hooks/useAttachments'
import { tokens } from '@/theme/tokens'

interface TerminalViewProps {
  projectPath: string
  onBack: () => void
}

const TerminalView: React.FC<TerminalViewProps> = ({ projectPath, onBack }) => {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const streamingVersion = useChatStore(s => s.streamingVersion)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const hasPendingCredential = useCredentialRequestStore(s => s.pending.size > 0)
  const hasPendingAskUserQuestion = useAskUserQuestionStore(s => s.pending.size > 0)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  const sessionPickerOpen = useCmdOverlayStore(s => s.sessionPickerOpen)
  const sessionPickerItems = useCmdOverlayStore(s => s.sessionPickerItems)
  const sessionPickerActiveId = useCmdOverlayStore(s => s.sessionPickerActiveId)

  const promptInputRef = useRef<CmdModePromptInputRef>(null)
  const isStreamingRef = useRef(isStreaming)
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
  useEffect(() => {
    const wasBlocked = prevHasPendingAskUserQuestionRef.current
    prevHasPendingAskUserQuestionRef.current = hasPendingAskUserQuestion
    if (wasBlocked && !hasPendingAskUserQuestion) {
      const t = setTimeout(() => promptInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [hasPendingAskUserQuestion])

  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

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
  useEffect(() => {
    if (!projectPath) return
    if (!useChatStore.getState().activeSessionId) {
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

    // Tasks — clear cross-project leak, hydrate new project's tasks.json.
    const { clearTasks, setTasks } = useAgentStore.getState()
    clearTasks()
    import('../../services/agent/taskPersistence').then(({ loadTasksFromDisk }) =>
      loadTasksFromDisk(projectPath)
        .then(tasks => { if (!cancelled) setTasks(tasks) })
        .catch(() => { /* non-critical — empty tracker is fine */ }),
    )

    // Permissions — clear stale trust grants, hydrate new project's
    // permissions.json. Without this, scopes approved in Project A leak
    // into Project B (auto-approved tools without user consent).
    import('../../stores/permissionStore').then(({ hydrateApprovedScopes }) =>
      import('../../services/agent/permissionPersistence').then(({ loadPermissionsFromDisk }) =>
        loadPermissionsFromDisk(projectPath)
          .then(scopes => { if (!cancelled) hydrateApprovedScopes(scopes, projectPath) })
          .catch(() => { /* non-critical — empty grants means re-prompt */ }),
      ),
    )

    return () => { cancelled = true }
  }, [projectPath])

  // Notify backend of project path exactly once per path.
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    import('@tauri-apps/api/core').then(({ invoke }) => {
      if (!cancelled) invoke('open_project', { path: projectPath }).catch(() => {})
    })
    return () => { cancelled = true }
  }, [projectPath])

  // Scroll follow — auto-sticks to bottom while user is near bottom; pauses on manual scroll up.
  const { scrollRef, stickToBottom } = useCmdScrollFollow({
    isStreaming,
    streamingVersion,
    messageCount: messages.length,
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
        // Double rAF — see ChatView. CMD mode uses `useCmdScrollFollow`
        // (not `useStickToBottom`) but the principle is the same: let the
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

  // Restore focus when permission prompt clears.
  useEffect(() => {
    const wasBlocked = prevPendingPermissionRef.current
    prevPendingPermissionRef.current = pendingPermission
    if (wasBlocked && !pendingPermission) {
      const t = setTimeout(() => promptInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [pendingPermission])

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
      if (isStreamingRef.current) {
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
    // Restore focus to the prompt after the picker unmounts.
    setTimeout(() => promptInputRef.current?.focus(), 40)
  }, [projectPath])

  const handleClosePicker = useCallback(() => {
    useCmdOverlayStore.getState().closeSessionPicker()
    setTimeout(() => promptInputRef.current?.focus(), 40)
  }, [])

  // Scroll to bottom after session load or when user sends.
  useEffect(() => {
    stickToBottom()
  }, [messages.length, stickToBottom])

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
  const suppressPromptFocusRef = useRef(false)
  const prevTerminalOpenRef = useRef(terminalOpen)
  useEffect(() => {
    if (terminalOpen && !prevTerminalOpenRef.current) {
      suppressPromptFocusRef.current = true
    }
    prevTerminalOpenRef.current = terminalOpen
  }, [terminalOpen])
  const handleTerminalReady = useCallback(() => {
    suppressPromptFocusRef.current = false
  }, [])

  const maxPanelWidth = outerWidth > 0 ? Math.floor(outerWidth * 0.5) : terminalWidthPref
  const clampedPanelWidth = Math.min(terminalWidthPref, Math.max(TERMINAL_PANEL_MIN_WIDTH, maxPanelWidth))

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
      fontSize="14px"
      position="relative"
      overflow="hidden"
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
        ref={scrollRef as React.RefObject<HTMLDivElement>}
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
        <Box minH="100%">
          {isLoadingSession ? (
            <Box mb={2}>
              <Text color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} fontSize="12px">
                ⟳ loading session…
              </Text>
            </Box>
          ) : messages.length === 0 ? (
            <TerminalGreeting projectPath={projectPath} />
          ) : (
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
                  ⟳ load earlier — {hiddenCount} hidden
                </Box>
              )}
              {visibleItems.map(msg => (
                <ErrorBoundary key={msg.id}>
                  <TerminalMessageRenderer
                    message={msg}
                    isStreaming={msg.id === streamingMessageId}
                  />
                </ErrorBoundary>
              ))}
            </Box>
          )}
        </Box>
      </Box>
      </Box>

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

      <Box flexShrink={0} data-tauri-drag-region>
        <TerminalStatusLine />
      </Box>

      <Box display={(pendingPermission || hasPendingCredential || hasPendingAskUserQuestion) ? 'none' : undefined} flexShrink={0} data-no-focus-steal>
        <CmdModePromptInput ref={promptInputRef} />
      </Box>
    </Flex>
      {terminalOpen && (
        <>
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
            aria-label="Resize terminal panel"
            role="separator"
          />
          <TerminalPanel projectPath={projectPath} widthPx={clampedPanelWidth} onReady={handleTerminalReady} />
        </>
      )}
    </Flex>
  )
}

export default TerminalView
