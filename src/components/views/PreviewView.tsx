import { memo, useRef, useEffect, useCallback } from 'react'
import { Flex, Box, Text, IconButton, HStack } from '@chakra-ui/react'
import { FiRefreshCw, FiExternalLink, FiSquare } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { devServerManager } from '../../services/devServerManager'
import StaticPreviewBuilder from '../../services/agent/staticPreviewBuilder'
import MessageBubble from '../chat/MessageBubble'
import { tokens } from '@/theme/tokens'

function PreviewView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const previewUrl = useLayoutStore(s => s.previewUrl)
  const previewMode = useLayoutStore(s => s.previewMode)
  const previewHtmlContent = useLayoutStore(s => s.previewHtmlContent)
  const previewSourcePath = useLayoutStore(s => s.previewSourcePath)

  const chatScrollRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const rafId = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(rafId)
  }, [messages, messages.length])

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
    layout.goBack()
  }, [])

  const hasPreview = previewUrl || previewHtmlContent
  if (!hasPreview) return null

  const displayLabel = previewMode === 'static'
    ? (previewSourcePath?.split('/').pop() || 'Static Preview')
    : previewUrl

  return (
    <Flex flex="1" overflow="hidden">
      {/* Left: Chat panel */}
      <Flex
        direction="column"
        w="35%"
        minW="300px"
        borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
        overflow="hidden"
      >
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
          {messages.map(msg => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isStreaming={msg.id === streamingMessageId}
            />
          ))}
        </Box>
      </Flex>

      {/* Right: Preview webview */}
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

        {/* iframe */}
        <Box flex="1" bg={tokens.colors.text.inverse}>
          <iframe
            ref={iframeRef}
            src={previewMode === 'server' ? previewUrl! : undefined}
            srcDoc={previewMode === 'static' ? previewHtmlContent! : undefined}
            title="Preview"
            sandbox="allow-scripts allow-same-origin"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
            }}
          />
        </Box>
      </Flex>
    </Flex>
  )
}

export default memo(PreviewView)
