import { memo, useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { Flex, Box, Text, IconButton, HStack } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiLoader, FiRefreshCw, FiExternalLink, FiSquare, FiTerminal, FiChevronDown, FiTrash2, FiLock, FiGlobe, FiMaximize2, FiMinimize2, FiUpload, FiZap } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore, selectFrontendUrl, selectBackendUrl, selectProjectKind, type DevServerLogEntry } from '../../stores/layoutStore'
import { useProjectStore } from '../../stores/projectStore'
import { useDeployStore } from '../../stores/deployStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { devServerManager } from '../../services/devServerManager'
import StaticPreviewBuilder from '../../services/agent/staticPreviewBuilder'
import MessageBubble from '../chat/MessageBubble'
import PromptBar from '../PromptBar'
import PermissionDialog from '../chat/PermissionDialog'
import HttpClientPanel from '../http-client/HttpClientPanel'
import TauriWebview, { closePreviewWebview } from '../ui/TauriWebview'
import AgentLogo from '../ui/AgentLogo'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { IS_MAC } from '@/utils/platform'

const STORAGE_KEY = 'preview-chat-width'
const CONSOLE_STORAGE_KEY = 'preview-console-height'
const HTTP_DRAWER_HEIGHT_KEY = 'preview-http-drawer-height'
const HTTP_DRAWER_OPEN_KEY = 'preview-http-drawer-open'
const MIN_WIDTH = 280
const MAX_WIDTH = 640
const DEFAULT_WIDTH = 380
const MIN_CONSOLE_HEIGHT = 80
const MAX_CONSOLE_HEIGHT = 400
const DEFAULT_CONSOLE_HEIGHT = 180
const MIN_DRAWER_HEIGHT = 200
const MAX_DRAWER_HEIGHT = 600
const DEFAULT_DRAWER_HEIGHT = 340

const LOG_COLORS: Record<string, string> = {
  info: tokens.colors.text.secondary,
  warn: '#e3b341',
  error: '#f85149',
}

function PreviewView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const frontendUrl = useLayoutStore(selectFrontendUrl)
  const backendUrl = useLayoutStore(selectBackendUrl)
  const projectKind = useLayoutStore(selectProjectKind)
  const previewMode = useLayoutStore(s => s.previewMode)
  const previewHtmlContent = useLayoutStore(s => s.previewHtmlContent)
  const previewSourcePath = useLayoutStore(s => s.previewSourcePath)
  const previewReloadKey = useLayoutStore(s => s.previewReloadKey)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const devServerLogs = useLayoutStore(s => s.devServerLogs)
  const isConsoleVisible = useLayoutStore(s => s.isConsoleVisible)
  const isHttpDrawerOpen = useLayoutStore(s => s.isHttpDrawerOpen)
  const previewServerTimedOut = useLayoutStore(s => s.previewServerTimedOut)
  const isPreviewServerLoading = useLayoutStore(s => s.isPreviewServerLoading)
  const currentProject = useProjectStore(s => s.currentProject)
  // Subscribed so the in-toolbar Publish button mirrors the title-bar one
  // (spinner + "Publishing…" while a deploy is mid-flight). Both buttons
  // open the same modal via layoutStore.isPublishModalOpen.
  const isPublishing = useDeployStore(function (s) {
    const id = currentProject?.id
    if (!id) return false
    return s.records.get(id)?.phase === 'in_progress'
  })

  // Main surface selection:
  //   - backend project → HttpClientPanel (no iframe)
  //   - frontend/fullstack → iframe preview
  //   - static → iframe with HTML content
  const showHttpClientMain = projectKind === 'backend'
  const showIframe = projectKind === 'frontend' || projectKind === 'fullstack' || previewMode === 'static'
  const isFullstack = projectKind === 'fullstack'
  const previewUrl = showHttpClientMain ? backendUrl : frontendUrl

  const [isChatCollapsed, setIsChatCollapsed] = useState(false)

  const chatScrollRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const consoleHandleRef = useRef<HTMLDivElement>(null)
  const consoleScrollRef = useRef<HTMLDivElement>(null)

  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_WIDTH
  })
  const [consoleHeight, setConsoleHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(CONSOLE_STORAGE_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_CONSOLE_HEIGHT && parsed <= MAX_CONSOLE_HEIGHT) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_CONSOLE_HEIGHT
  })
  const [isResizing, setIsResizing] = useState(false)
  const [isResizingConsole, setIsResizingConsole] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(HTTP_DRAWER_HEIGHT_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_DRAWER_HEIGHT && parsed <= MAX_DRAWER_HEIGHT) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_DRAWER_HEIGHT
  })
  const [isResizingDrawer, setIsResizingDrawer] = useState(false)
  const drawerHandleRef = useRef<HTMLDivElement>(null)

  // Restore drawer-open state on mount (fullstack only).
  useEffect(() => {
    if (projectKind !== 'fullstack') return
    try {
      const saved = localStorage.getItem(HTTP_DRAWER_OPEN_KEY)
      if (saved === '1' && !useLayoutStore.getState().isHttpDrawerOpen) {
        useLayoutStore.getState().toggleHttpDrawer()
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKind])

  // Persist drawer-open state whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(HTTP_DRAWER_OPEN_KEY, isHttpDrawerOpen ? '1' : '0')
    } catch { /* ignore */ }
  }, [isHttpDrawerOpen])

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  // Single pass over logs; memoized so subscribers that re-render the
  // wrapping component (e.g. on unrelated layoutStore changes) don't
  // re-scan the whole log list.
  const { errorCount, warnCount, hasErrors } = useMemo(() => {
    let e = 0, w = 0
    for (const l of devServerLogs) {
      if (l.level === 'error') e++
      else if (l.level === 'warn') w++
    }
    return { errorCount: e, warnCount: w, hasErrors: e > 0 }
  }, [devServerLogs])

  // Keyboard shortcut for fullstack drawer: Cmd/Ctrl + Shift + H
  useEffect(() => {
    if (projectKind !== 'fullstack') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        useLayoutStore.getState().toggleHttpDrawer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectKind])

  // Auto-scroll chat
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const rafId = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(rafId)
  }, [messages, messages.length])

  // Auto-scroll console
  useEffect(() => {
    const el = consoleScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [devServerLogs.length, isConsoleVisible])

  // Auto-reload when reloadKey changes (agent finished editing files)
  useEffect(() => {
    if (previewReloadKey === 0) return
    if (previewMode === 'static' && previewSourcePath) {
      StaticPreviewBuilder.getInstance()
        .buildPreview(previewSourcePath)
        .then(html => useLayoutStore.getState().setStaticPreview(html, previewSourcePath))
        .catch(() => {})
    }
    // Server mode: reloadKey is passed to TauriWebview which recreates the webview
  }, [previewReloadKey, previewMode, previewSourcePath])

  // Auto-open console when errors appear
  useEffect(() => {
    if (errorCount > 0 && !isConsoleVisible) {
      useLayoutStore.getState().toggleConsole()
    }
  }, [errorCount])

  const handleReload = useCallback(async () => {
    if (previewMode === 'static' && previewSourcePath) {
      try {
        const builder = StaticPreviewBuilder.getInstance()
        const html = await builder.buildPreview(previewSourcePath)
        useLayoutStore.getState().setStaticPreview(html, previewSourcePath)
      } catch {
        // Failed to rebuild
      }
    } else {
      // Trigger wry webview recreation via reloadKey
      useLayoutStore.getState().reloadPreview()
    }
  }, [previewMode, previewSourcePath])

  const handleOpenExternal = async () => {
    if (!previewUrl) return
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(previewUrl)
    } catch {
      window.open(previewUrl, '_blank')
    }
  }

  const handleStopServer = useCallback(async () => {
    closePreviewWebview()
    await devServerManager.stop()
    const layout = useLayoutStore.getState()
    layout.clearDevServer()
    const prev = layout.previousViewMode
    layout.setViewMode(prev && prev !== 'generating' && prev !== 'preview' ? prev : 'chat')
  }, [])

  // Horizontal resize (chat width)
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = handleRef.current
    if (!handleEl) return

    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch { /* ignore */ }

    let current = chatWidth
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'
    setIsResizing(true)

    function onPointerMove(pe: PointerEvent) {
      let next = pe.clientX
      if (next < MIN_WIDTH) next = MIN_WIDTH
      if (next > MAX_WIDTH) next = MAX_WIDTH
      current = next
      setChatWidth(next)
    }

    function onPointerUp() {
      try { localStorage.setItem(STORAGE_KEY, String(current)) } catch { /* ignore */ }
      try { handleEl?.releasePointerCapture(pid) } catch { /* ignore */ }
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizing(false)
    }

    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [chatWidth])

  // Vertical resize (console height)
  const handleConsoleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = consoleHandleRef.current
    if (!handleEl) return

    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch { /* ignore */ }

    const startY = e.clientY
    const startHeight = consoleHeight
    let current = consoleHeight
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'row-resize'
    body.style.userSelect = 'none'
    setIsResizingConsole(true)

    function onPointerMove(pe: PointerEvent) {
      // Dragging up = increasing height
      let next = startHeight + (startY - pe.clientY)
      if (next < MIN_CONSOLE_HEIGHT) next = MIN_CONSOLE_HEIGHT
      if (next > MAX_CONSOLE_HEIGHT) next = MAX_CONSOLE_HEIGHT
      current = next
      setConsoleHeight(next)
    }

    function onPointerUp() {
      try { localStorage.setItem(CONSOLE_STORAGE_KEY, String(current)) } catch { /* ignore */ }
      try { handleEl?.releasePointerCapture(pid) } catch { /* ignore */ }
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizingConsole(false)
    }

    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [consoleHeight])

  const hasPreview = !!(previewUrl || previewHtmlContent)

  const displayLabel = previewMode === 'static'
    ? (previewSourcePath?.split('/').pop() || 'Static Preview')
    : showHttpClientMain
      ? (previewUrl || 'HTTP Client')
      : (previewUrl || 'Loading...')

  // Drawer resize (vertical, drag up from the top of the drawer)
  const handleDrawerResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = drawerHandleRef.current
    if (!handleEl) return

    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch { /* ignore */ }

    const startY = e.clientY
    const startH = drawerHeight
    let current = drawerHeight
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'row-resize'
    body.style.userSelect = 'none'
    setIsResizingDrawer(true)

    function onPointerMove(pe: PointerEvent) {
      // Dragging up = increasing height
      let next = startH + (startY - pe.clientY)
      if (next < MIN_DRAWER_HEIGHT) next = MIN_DRAWER_HEIGHT
      if (next > MAX_DRAWER_HEIGHT) next = MAX_DRAWER_HEIGHT
      current = next
      setDrawerHeight(next)
    }

    function onPointerUp() {
      try { localStorage.setItem(HTTP_DRAWER_HEIGHT_KEY, String(current)) } catch { /* ignore */ }
      try { handleEl?.releasePointerCapture(pid) } catch { /* ignore */ }
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizingDrawer(false)
    }

    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [drawerHeight])

  return (
    <Flex flex="1" overflow="hidden">
      {/* Left: Full chat sidebar (messages + prompt) — collapsible with animation */}
      <Flex
        direction="column"
        w={isChatCollapsed ? '0px' : `${chatWidth}px`}
        minW={isChatCollapsed ? '0px' : `${MIN_WIDTH}px`}
        maxW={isChatCollapsed ? '0px' : `${MAX_WIDTH}px`}
        overflow="hidden"
        bg={tokens.colors.bg.mainLayout}
        flexShrink={0}
        transition="width 0.25s ease, min-width 0.25s ease, max-width 0.25s ease"
        opacity={isChatCollapsed ? 0 : 1}
        css={{ transition: 'width 0.25s ease, min-width 0.25s ease, max-width 0.25s ease, opacity 0.2s ease' }}
      >
        {/* Chat messages */}
        <Flex
          ref={chatScrollRef}
          direction="column"
          flex="1"
          overflowY="auto"
          py={3}
          px={3}
          css={{
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: tokens.colors.border.panel,
              borderRadius: '2px',
            },
          }}
        >
          {messages.length === 0 ? (
            <Flex
              flex="1"
              direction="column"
              align="center"
              justify="center"
              gap={3}
            >
              <AgentLogo size={36} glow />
              <Flex direction="column" align="center" gap={1}>
                <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.muted} fontWeight={500}>
                  Ask the agent to iterate
                </Text>
                <Text fontSize="10px" color={tokens.colors.text.disabled} textAlign="center" px={3} lineHeight="1.4">
                  Describe changes and see them live
                </Text>
              </Flex>
            </Flex>
          ) : (
            <Box maxW="600px" mx="auto" w="100%">
              {messages.map(msg => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isStreaming={msg.id === streamingMessageId}
                />
              ))}
            </Box>
          )}
        </Flex>

        {/* Permission dialog above prompt */}
        {pendingPermission && (
          <PermissionDialog
            toolName={pendingPermission.toolName}
            args={pendingPermission.args}
            promptReason={pendingPermission.promptReason}
            onApprove={() => usePermissionStore.getState().approve()}
            onApproveAll={() => usePermissionStore.getState().approveAll()}
            onDeny={() => usePermissionStore.getState().deny()}
          />
        )}

        {/* PromptBar at bottom of chat sidebar */}
        <PromptBar />
      </Flex>

      {/* Resize handle (horizontal) — hidden when chat is collapsed */}
      <Box
        ref={handleRef}
        w={isChatCollapsed ? '0px' : '4px'}
        cursor="col-resize"
        flexShrink={0}
        bg={isResizing ? tokens.colors.accent.primary : 'transparent'}
        transition={isResizing ? 'none' : `all ${tokens.transition.fast}`}
        _hover={!isChatCollapsed ? { bg: tokens.colors.accent.primary } : {}}
        onPointerDown={isChatCollapsed ? undefined : handleResizeStart}
        position="relative"
        zIndex={2}
        overflow="hidden"
      />

      {/* Right: Preview webview + console */}
      <Flex
        direction="column"
        flex="1"
        overflow="hidden"
        bg={tokens.colors.bg.mainLayout}
      >
        {/* ── Browser-style toolbar ──────────────────────────────── */}
        <Flex
          align="center"
          gap={2}
          px={2}
          py={1.5}
          bg={tokens.colors.bg.panel}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
          flexShrink={0}
        >
          {/* Navigation + reload */}
          <HStack gap={0}>
            {previewMode !== 'api' && (
              <IconButton
                aria-label={t("view.reloadPreview")}
                size="xs"
                variant="ghost"
                color={tokens.colors.text.secondary}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                borderRadius="6px"
                onClick={handleReload}
              >
                <FiRefreshCw size={13} />
              </IconButton>
            )}
          </HStack>

          {/* Address bar */}
          <Flex
            flex={1}
            align="center"
            gap="6px"
            px={3}
            py="5px"
            bg={tokens.colors.bg.mainLayout}
            borderRadius="8px"
            border={`1px solid ${tokens.colors.border.panel}`}
            minW={0}
          >
            {previewMode === 'static' ? (
              <FiGlobe size={12} color={tokens.colors.text.disabled} style={{ flexShrink: 0 }} />
            ) : (
              <FiLock size={11} color={tokens.colors.accent.green} style={{ flexShrink: 0 }} />
            )}
            <Text
              fontSize="12px"
              color={tokens.colors.text.secondary}
              fontFamily={tokens.fontFamily.mono}
              lineClamp={1}
              flex={1}
              userSelect="all"
            >
              {showHttpClientMain ? 'HTTP Client' : displayLabel}
            </Text>
          </Flex>

          {/* Right actions */}
          <HStack gap={0}>
            {/* Expand/collapse chat sidebar */}
            <IconButton
              aria-label={isChatCollapsed ? 'Show chat' : 'Full preview'}
              size="xs"
              variant="ghost"
              color={isChatCollapsed ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              borderRadius="6px"
              onClick={() => setIsChatCollapsed(!isChatCollapsed)}
            >
              {isChatCollapsed ? <FiMinimize2 size={13} /> : <FiMaximize2 size={13} />}
            </IconButton>

            {/* HTTP Client drawer toggle — only visible for fullstack projects */}
            {isFullstack && (
              <IconButton
                aria-label={isHttpDrawerOpen ? 'Close HTTP Client' : 'Open HTTP Client'}
                size="xs"
                variant="ghost"
                color={isHttpDrawerOpen ? tokens.colors.accent.primary : tokens.colors.text.secondary}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                borderRadius="6px"
                onClick={() => useLayoutStore.getState().toggleHttpDrawer()}
                title="Toggle HTTP Client"
              >
                <FiZap size={13} />
              </IconButton>
            )}

            {/* Console */}
            <IconButton
              aria-label={t("view.toggleConsole")}
              size="xs"
              variant="ghost"
              color={isConsoleVisible ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              borderRadius="6px"
              onClick={() => useLayoutStore.getState().toggleConsole()}
              position="relative"
            >
              <FiTerminal size={13} />
              {errorCount > 0 && (
                <Box position="absolute" top="1px" right="1px" w="6px" h="6px" borderRadius="full" bg="#f85149" />
              )}
              {errorCount === 0 && warnCount > 0 && (
                <Box position="absolute" top="1px" right="1px" w="6px" h="6px" borderRadius="full" bg="#e3b341" />
              )}
            </IconButton>

            {/* Open in system browser */}
            {previewUrl && (
              <IconButton
                aria-label={t("view.openInBrowser")}
                size="xs"
                variant="ghost"
                color={tokens.colors.text.secondary}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                borderRadius="6px"
                onClick={handleOpenExternal}
              >
                <FiExternalLink size={13} />
              </IconButton>
            )}

            {/* Publish — primary action in the preview toolbar. The same
                modal also opens from the title bar; layoutStore.isPublishModalOpen
                is the single source of truth so the two entry points cannot
                fight each other. Pill style (not IconButton) so it reads as
                a primary action vs. the surrounding glyph buttons. */}
            {currentProject && (
              <Box
                as="button"
                ml="6px"
                display="flex"
                alignItems="center"
                gap="6px"
                h="24px"
                px="10px"
                borderRadius="6px"
                bg={tokens.colors.accent.primarySubtle}
                color={tokens.colors.accent.primary}
                border={`1px solid ${tokens.colors.accent.primaryMuted}`}
                fontSize="11px"
                fontWeight="500"
                cursor="pointer"
                transition={tokens.transition.fast}
                _hover={{
                  bg: tokens.colors.accent.primaryHover,
                  boxShadow: `0 2px 12px -2px ${tokens.colors.accent.primaryGlow}`,
                }}
                onClick={() => useLayoutStore.getState().setPublishModalOpen(true)}
                title={isPublishing
                  ? 'Publishing… click to view progress'
                  : `Publish (${IS_MAC ? '⌘' : 'Ctrl'}⇧D)`}
              >
                {isPublishing ? (
                  <Box
                    css={{
                      animation: 'tm-publish-spin 1.4s linear infinite',
                      '@keyframes tm-publish-spin': {
                        from: { transform: 'rotate(0deg)' },
                        to: { transform: 'rotate(360deg)' },
                      },
                    }}
                  >
                    <FiLoader size={11} />
                  </Box>
                ) : (
                  <FiUpload size={11} />
                )}
                <Text fontSize="11px" fontWeight="500">
                  {isPublishing ? 'Publishing…' : 'Publish'}
                </Text>
              </Box>
            )}

            {/* Stop server */}
            {previewMode !== 'static' && previewUrl && (
              <IconButton
                aria-label={t("misc.stopServer")}
                size="xs"
                variant="ghost"
                color={tokens.colors.text.secondary}
                _hover={{ bg: 'rgba(248, 81, 73, 0.12)', color: '#f85149' }}
                borderRadius="6px"
                onClick={handleStopServer}
              >
                <FiSquare size={12} />
              </IconButton>
            )}
          </HStack>
        </Flex>

        {/* ── Content area ──────────────────────────────────── */}
        {showHttpClientMain ? (
          // Backend-only project → HTTP Client occupies the full main area.
          <Flex flex="1" direction="column" overflow="hidden">
            <HttpClientPanel />
          </Flex>
        ) : (
          <Box flex="1" bg={tokens.colors.text.inverse} position="relative" overflow="hidden">
            {hasPreview && showIframe ? (
              <Box position="relative" w="100%" h="100%">
                <TauriWebview
                  url={previewMode === 'static' ? undefined : previewUrl!}
                  html={previewMode === 'static' ? previewHtmlContent! : undefined}
                  reloadKey={previewReloadKey}
                  frozen={isResizing || isResizingConsole}
                />
                {(isResizing || isResizingConsole) && (
                  <Box
                    position="absolute"
                    inset={0}
                    bg="rgba(10, 10, 10, 0.6)"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    zIndex={5}
                    pointerEvents="none"
                  >
                    <Text fontSize="11px" color={tokens.colors.text.disabled} fontWeight="500">
                      Resizing...
                    </Text>
                  </Box>
                )}
              </Box>
            ) : (
              <Flex flex="1" align="center" justify="center" direction="column" gap={3}>
                {previewServerTimedOut ? (
                  <>
                    <Text fontSize={tokens.fontSize.sm} color={tokens.colors.accent.orange} fontWeight="500">
                      Server did not respond in time
                    </Text>
                    <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} maxW="300px" textAlign="center">
                      The dev server may still be starting. Check the console for errors.
                    </Text>
                    <Box
                      as="button"
                      mt={1}
                      px={4}
                      py="6px"
                      borderRadius="6px"
                      fontSize="12px"
                      fontWeight="600"
                      bg={tokens.colors.accent.primary}
                      color="#fff"
                      cursor="pointer"
                      transition={`all ${tokens.transition.fast}`}
                      _hover={{ opacity: 0.85 }}
                      onClick={() => {
                        useLayoutStore.getState().setPreviewServerTimedOut(false)
                        useLayoutStore.getState().reloadPreview()
                      }}
                    >
                      Retry
                    </Box>
                  </>
                ) : hasErrors ? (
                  <>
                    <Text fontSize={tokens.fontSize.sm} color={tokens.colors.accent.red} fontWeight="500">
                      {t("view.devServerFailed")}
                    </Text>
                    <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                      Check the console below for details
                    </Text>
                  </>
                ) : isPreviewServerLoading ? (
                  <>
                    <Box
                      w="20px" h="20px" borderRadius="full"
                      border="2px solid" borderColor={tokens.colors.border.panel}
                      borderTopColor={tokens.colors.accent.primary}
                      animation="spin 0.8s linear infinite"
                      css={{ '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }}
                    />
                    <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.disabled}>
                      Starting preview server...
                    </Text>
                  </>
                ) : (
                  <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.disabled}>
                    Waiting for preview server...
                  </Text>
                )}
              </Flex>
            )}
          </Box>
        )}

        {/* Fullstack HTTP Client drawer — resizable bottom slide-up panel */}
        <AnimatePresence>
          {isFullstack && isHttpDrawerOpen && (
            <motion.div
              key="http-drawer"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: drawerHeight + 4, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={isResizingDrawer
                ? { duration: 0 }
                : { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 }
              }
              style={{ flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            >
              {/* Resize handle — drag up/down */}
              <Box
                ref={drawerHandleRef}
                h="4px"
                cursor="row-resize"
                flexShrink={0}
                bg={isResizingDrawer ? tokens.colors.accent.primary : 'transparent'}
                transition={isResizingDrawer ? 'none' : `background ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.accent.primary }}
                onPointerDown={handleDrawerResizeStart}
                zIndex={2}
              />
              <Flex
                align="center"
                justify="space-between"
                px={3}
                py="6px"
                bg={tokens.colors.bg.panel}
                borderTop={`1px solid ${tokens.colors.border.sidebarPanel}`}
                borderBottom={`1px solid ${tokens.colors.border.glass}`}
                flexShrink={0}
              >
                <HStack gap={2}>
                  <FiZap size={11} color={tokens.colors.accent.primary} />
                  <Text fontSize="11px" fontWeight={600} color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.5px">
                    HTTP Client
                  </Text>
                  {backendUrl && (
                    <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily="mono">
                      {backendUrl}
                    </Text>
                  )}
                </HStack>
                <IconButton
                  aria-label="Close HTTP Client"
                  size="xs"
                  variant="ghost"
                  color={tokens.colors.text.disabled}
                  _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                  borderRadius="4px"
                  onClick={() => useLayoutStore.getState().toggleHttpDrawer()}
                >
                  <FiChevronDown size={12} />
                </IconButton>
              </Flex>
              <Box flex="1" overflow="hidden" bg={tokens.colors.bg.mainLayout}>
                <HttpClientPanel />
              </Box>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Console panel (DevTools-style) with slide animation */}
        <AnimatePresence>
          {isConsoleVisible && (
            <motion.div
              key="console-panel"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: consoleHeight + 4, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={isResizingConsole
                ? { duration: 0 }
                : { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 }
              }
              style={{ flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            >
              {/* Resize handle (vertical) */}
              <Box
                ref={consoleHandleRef}
                h="4px"
                cursor="row-resize"
                flexShrink={0}
                bg={isResizingConsole ? tokens.colors.accent.primary : 'transparent'}
                transition={isResizingConsole ? 'none' : `background ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.accent.primary }}
                onPointerDown={handleConsoleResizeStart}
                zIndex={2}
              />

              {/* Console content */}
              <Flex
                direction="column"
                flex="1"
                bg="#0d0d0d"
                borderTop={`1px solid ${tokens.colors.border.panel}`}
                overflow="hidden"
              >
                {/* Console header */}
                <Flex
                  align="center"
                  justify="space-between"
                  px={3}
                  py={1.5}
                  flexShrink={0}
                  borderBottom={`1px solid ${tokens.colors.border.panel}`}
                >
                  <HStack gap={3}>
                    <Text fontSize="11px" fontWeight={600} color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.5px">
                      Console
                    </Text>
                    {errorCount > 0 && (
                      <HStack gap={1}>
                        <Box w="6px" h="6px" borderRadius="full" bg="#f85149" />
                        <Text fontSize="11px" color="#f85149">{errorCount}</Text>
                      </HStack>
                    )}
                    {warnCount > 0 && (
                      <HStack gap={1}>
                        <Box w="6px" h="6px" borderRadius="full" bg="#e3b341" />
                        <Text fontSize="11px" color="#e3b341">{warnCount}</Text>
                      </HStack>
                    )}
                  </HStack>
                  <HStack gap={0}>
                    <IconButton
                      aria-label={t("misc.clearConsole")}
                      size="xs"
                      variant="ghost"
                      color={tokens.colors.text.disabled}
                      _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                      borderRadius="4px"
                      onClick={() => useLayoutStore.getState().clearDevServerLogs()}
                    >
                      <FiTrash2 size={12} />
                    </IconButton>
                    <IconButton
                      aria-label={t("misc.closeConsole")}
                      size="xs"
                      variant="ghost"
                      color={tokens.colors.text.disabled}
                      _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                      borderRadius="4px"
                      onClick={() => useLayoutStore.getState().toggleConsole()}
                    >
                      <FiChevronDown size={12} />
                    </IconButton>
                  </HStack>
                </Flex>

                {/* Console log entries */}
                <Box
                  ref={consoleScrollRef}
                  flex="1"
                  overflowY="auto"
                  px={3}
                  py={1}
                  css={{
                    '&::-webkit-scrollbar': { width: '4px' },
                    '&::-webkit-scrollbar-track': { background: 'transparent' },
                    '&::-webkit-scrollbar-thumb': {
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: '2px',
                    },
                  }}
                >
                  {devServerLogs.length === 0 ? (
                    <Text fontSize="11px" color={tokens.colors.text.disabled} py={2}>
                      {t("view.noOutputYet")}
                    </Text>
                  ) : (
                    devServerLogs.map((entry: DevServerLogEntry) => (
                      <ConsoleLogLine key={entry.id} entry={entry} />
                    ))
                  )}
                </Box>
              </Flex>
            </motion.div>
          )}
        </AnimatePresence>
      </Flex>
    </Flex>
  )
}

const ConsoleLogLine = memo(function ConsoleLogLine({ entry }: { entry: DevServerLogEntry }) {
  const color = LOG_COLORS[entry.level] || tokens.colors.text.secondary
  const bgColor = entry.level === 'error'
    ? 'rgba(248, 81, 73, 0.06)'
    : entry.level === 'warn'
      ? 'rgba(227, 179, 65, 0.06)'
      : 'transparent'

  return (
    <Flex
      align="flex-start"
      gap={2}
      py="2px"
      px={1}
      borderBottom="1px solid rgba(255,255,255,0.03)"
      bg={bgColor}
      borderRadius="2px"
    >
      <Text
        fontSize="10px"
        color={tokens.colors.text.disabled}
        fontFamily="mono"
        flexShrink={0}
        mt="1px"
        userSelect="none"
      >
        {new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
      </Text>
      <Text
        fontSize="11px"
        color={color}
        fontFamily="mono"
        whiteSpace="pre-wrap"
        wordBreak="break-all"
        lineHeight="1.5"
      >
        {entry.text}
      </Text>
    </Flex>
  )
})

export default memo(PreviewView)
