import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useChatStore } from '../../stores/chatStore'
import { usePermissionStore } from '../../stores/permissionStore'
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

interface CmdModeViewProps {
  projectPath: string
  onBack: () => void
}

const CmdModeView: React.FC<CmdModeViewProps> = ({ projectPath, onBack }) => {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const streamingVersion = useChatStore(s => s.streamingVersion)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)

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

  useEffect(() => {
    sessionPickerOpenRef.current = sessionPickerOpen
  }, [sessionPickerOpen])

  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    pendingPermissionRef.current = pendingPermission
  }, [pendingPermission])

  // Create a session once if none exists. Runs independently from open_project so
  // activeSessionId changes do not re-invoke the backend.
  useEffect(() => {
    if (!activeSessionId) useChatStore.getState().createSession(projectPath)
  }, [activeSessionId, projectPath])

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
  const handleOutputClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (pendingPermission) return
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
  //   2. Session picker owns Escape (closes picker, does NOT exit CMD Mode)
  //   3. Open menus (slash / @mention) own Escape to close themselves
  //   4. Streaming → stop agent
  //   5. Typing with text → let the textarea handle it
  //   6. Idle → exit to welcome
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (pendingPermissionRef.current) return
      // Picker's own onKeyDown also handles Esc, but a click elsewhere can
      // defocus the overlay — intercept here too so Escape never leaks out
      // of CMD Mode while the picker is open.
      if (sessionPickerOpenRef.current) {
        e.preventDefault()
        e.stopPropagation()
        useCmdOverlayStore.getState().closeSessionPicker()
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

  // Close the terminal panel automatically when leaving the project.
  useEffect(() => {
    return () => { useTerminalPanelStore.getState().close() }
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

      {/* Output area */}
      <Box
        ref={scrollRef as React.RefObject<HTMLDivElement>}
        flex="1"
        minH={0}
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
              {messages.map(msg => (
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

      {pendingPermission && (
        <TerminalPermissionPrompt
          key={pendingPermission.id}
          toolName={pendingPermission.toolName}
          args={pendingPermission.args}
          promptReason={pendingPermission.promptReason}
          onApprove={() => usePermissionStore.getState().approve()}
          onApproveAll={() => usePermissionStore.getState().approveAll()}
          onDeny={() => usePermissionStore.getState().deny()}
          onDenyWith={(reason) => usePermissionStore.getState().denyWith(reason)}
        />
      )}

      {sessionPickerOpen && (
        <TerminalSessionPicker
          items={sessionPickerItems}
          activeSessionId={sessionPickerActiveId}
          onSelect={handlePickSession}
          onClose={handleClosePicker}
        />
      )}

      <TerminalStatusLine />

      <Box display={pendingPermission ? 'none' : undefined} data-no-focus-steal>
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
          <TerminalPanel projectPath={projectPath} widthPx={clampedPanelWidth} />
        </>
      )}
    </Flex>
  )
}

export default CmdModeView
