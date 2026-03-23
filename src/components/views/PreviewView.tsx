import { memo, useRef, useEffect, useCallback, useState } from 'react'
import { Flex, Box, Text, IconButton, HStack } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiRefreshCw, FiExternalLink, FiSquare, FiTerminal, FiChevronDown, FiTrash2 } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore, type DevServerLogEntry } from '../../stores/layoutStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { devServerManager } from '../../services/devServerManager'
import StaticPreviewBuilder from '../../services/agent/staticPreviewBuilder'
import MessageBubble from '../chat/MessageBubble'
import PromptBar from '../PromptBar'
import PermissionDialog from '../chat/PermissionDialog'
import { tokens } from '@/theme/tokens'

const STORAGE_KEY = 'preview-chat-width'
const CONSOLE_STORAGE_KEY = 'preview-console-height'
const MIN_WIDTH = 280
const MAX_WIDTH = 640
const DEFAULT_WIDTH = 380
const MIN_CONSOLE_HEIGHT = 80
const MAX_CONSOLE_HEIGHT = 400
const DEFAULT_CONSOLE_HEIGHT = 180

const LOG_COLORS: Record<string, string> = {
  info: tokens.colors.text.secondary,
  warn: '#e3b341',
  error: '#f85149',
}

function PreviewView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const previewUrl = useLayoutStore(s => s.previewUrl)
  const previewMode = useLayoutStore(s => s.previewMode)
  const previewHtmlContent = useLayoutStore(s => s.previewHtmlContent)
  const previewSourcePath = useLayoutStore(s => s.previewSourcePath)
  const previewReloadKey = useLayoutStore(s => s.previewReloadKey)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const devServerLogs = useLayoutStore(s => s.devServerLogs)
  const isConsoleVisible = useLayoutStore(s => s.isConsoleVisible)

  const chatScrollRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
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

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  const errorCount = devServerLogs.filter(l => l.level === 'error').length
  const warnCount = devServerLogs.filter(l => l.level === 'warn').length

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

  // Auto-reload iframe when reloadKey changes (agent finished editing files)
  useEffect(() => {
    if (previewReloadKey === 0) return
    if (previewMode === 'static' && previewSourcePath) {
      StaticPreviewBuilder.getInstance()
        .buildPreview(previewSourcePath)
        .then(html => useLayoutStore.getState().setStaticPreview(html, previewSourcePath))
        .catch(() => {})
    } else if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src
    }
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
    } else if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src
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
    await devServerManager.stop()
    const layout = useLayoutStore.getState()
    layout.clearPreviewServer()
    // Go back to previous view, but never to 'generating' (which could re-trigger preview)
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

  const hasPreview = previewUrl || previewHtmlContent

  const displayLabel = previewMode === 'static'
    ? (previewSourcePath?.split('/').pop() || 'Static Preview')
    : (previewUrl || 'Loading...')

  return (
    <Flex flex="1" overflow="hidden">
      {/* Left: Full chat sidebar (messages + prompt) */}
      <Flex
        direction="column"
        w={`${chatWidth}px`}
        minW={`${MIN_WIDTH}px`}
        maxW={`${MAX_WIDTH}px`}
        overflow="hidden"
        bg={tokens.colors.bg.mainLayout}
        flexShrink={0}
      >
        {/* Chat messages */}
        <Box
          ref={chatScrollRef}
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
          <Box maxW="600px" mx="auto" w="100%">
            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={msg.id === streamingMessageId}
              />
            ))}
          </Box>
        </Box>

        {/* Permission dialog above prompt */}
        {pendingPermission && (
          <PermissionDialog
            toolName={pendingPermission.toolName}
            args={pendingPermission.args}
            sensitive={pendingPermission.sensitive}
            onApprove={() => usePermissionStore.getState().approve()}
            onApproveAll={() => usePermissionStore.getState().approveAll()}
            onDeny={() => usePermissionStore.getState().deny()}
          />
        )}

        {/* PromptBar at bottom of chat sidebar */}
        <PromptBar />
      </Flex>

      {/* Resize handle (horizontal) */}
      <Box
        ref={handleRef}
        w="4px"
        cursor="col-resize"
        flexShrink={0}
        bg={isResizing ? tokens.colors.accent.primary : 'transparent'}
        transition={isResizing ? 'none' : `background ${tokens.transition.fast}`}
        _hover={{ bg: tokens.colors.accent.primary }}
        onPointerDown={handleResizeStart}
        position="relative"
        zIndex={2}
      />

      {/* Right: Preview webview + console */}
      <Flex
        direction="column"
        flex="1"
        overflow="hidden"
        bg={tokens.colors.bg.mainLayout}
      >
        {/* Preview toolbar */}
        <Flex
          align="center"
          justify="space-between"
          px={4}
          py={2}
          bg={tokens.colors.bg.panel}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
          flexShrink={0}
        >
          <HStack gap={2}>
            <Box
              px={3}
              py={1}
              bg={tokens.colors.bg.mainLayout}
              borderRadius="6px"
              border={`1px solid ${tokens.colors.border.panel}`}
            >
              <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.secondary} fontFamily="mono">
                {displayLabel}
              </Text>
            </Box>
            {previewMode === 'static' && (
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                Static Preview
              </Text>
            )}
          </HStack>

          <HStack gap={1}>
            {/* Console toggle */}
            <IconButton
              aria-label="Toggle console"
              size="sm"
              variant="ghost"
              color={isConsoleVisible ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
              borderRadius="6px"
              onClick={() => useLayoutStore.getState().toggleConsole()}
              position="relative"
            >
              <FiTerminal size={14} />
              {/* Error/warn badge */}
              {errorCount > 0 && (
                <Box
                  position="absolute"
                  top="2px"
                  right="2px"
                  w="8px"
                  h="8px"
                  borderRadius="full"
                  bg="#f85149"
                />
              )}
              {errorCount === 0 && warnCount > 0 && (
                <Box
                  position="absolute"
                  top="2px"
                  right="2px"
                  w="8px"
                  h="8px"
                  borderRadius="full"
                  bg="#e3b341"
                />
              )}
            </IconButton>

            <IconButton
              aria-label="Reload preview"
              size="sm"
              variant="ghost"
              color={tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
              borderRadius="6px"
              onClick={handleReload}
            >
              <FiRefreshCw size={14} />
            </IconButton>
            {previewMode === 'server' && previewUrl && (
              <>
                <IconButton
                  aria-label="Open in browser"
                  size="sm"
                  variant="ghost"
                  color={tokens.colors.text.secondary}
                  _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
                  borderRadius="6px"
                  onClick={handleOpenExternal}
                >
                  <FiExternalLink size={14} />
                </IconButton>
                <IconButton
                  aria-label="Stop server"
                  size="sm"
                  variant="ghost"
                  color={tokens.colors.text.secondary}
                  _hover={{ bg: 'rgba(248, 81, 73, 0.15)', color: '#f85149' }}
                  borderRadius="6px"
                  onClick={handleStopServer}
                >
                  <FiSquare size={14} />
                </IconButton>
              </>
            )}
          </HStack>
        </Flex>

        {/* iframe — disable pointer events while resizing */}
        <Box flex="1" bg={tokens.colors.text.inverse} position="relative">
          {hasPreview ? (
            <>
              {(isResizing || isResizingConsole) && (
                <Box position="absolute" inset={0} zIndex={1} />
              )}
              <iframe
                ref={iframeRef}
                src={previewMode === 'server' ? previewUrl! : undefined}
                srcDoc={previewMode === 'static' ? previewHtmlContent! : undefined}
                title="Preview"
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  pointerEvents: (isResizing || isResizingConsole) ? 'none' : 'auto',
                }}
              />
            </>
          ) : (
            <Flex flex="1" align="center" justify="center" direction="column" gap={2}>
              {devServerLogs.some(l => l.level === 'error') ? (
                <>
                  <Text fontSize={tokens.fontSize.sm} color={tokens.colors.accent.red} fontWeight="500">
                    Dev server failed to start
                  </Text>
                  <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                    Check the console below for details
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
                : { duration: 0.2, ease: [0.4, 0, 0.2, 1] }
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
                      aria-label="Clear console"
                      size="xs"
                      variant="ghost"
                      color={tokens.colors.text.disabled}
                      _hover={{ color: tokens.colors.text.secondary }}
                      borderRadius="4px"
                      onClick={() => useLayoutStore.getState().clearDevServerLogs()}
                    >
                      <FiTrash2 size={12} />
                    </IconButton>
                    <IconButton
                      aria-label="Close console"
                      size="xs"
                      variant="ghost"
                      color={tokens.colors.text.disabled}
                      _hover={{ color: tokens.colors.text.secondary }}
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
                      No output yet...
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
