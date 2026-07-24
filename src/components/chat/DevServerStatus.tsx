import { memo, useRef, useEffect, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiMonitor, FiX } from 'react-icons/fi'
import { useLayoutStore, selectIsPreviewServerRunning, type DevServerLogEntry } from '../../stores/layoutStore'
import { useProjectStore } from '../../stores/projectStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { stripAnsi } from '@/utils/stripAnsi'

const LOG_COLORS: Record<string, string> = {
  info: tokens.colors.text.secondary,
  warn: '#e3b341',
  error: '#f85149',
}

function DevServerStatus() {
  const projectPath = useProjectStore(s => s.currentProject?.path ?? null)
  const isLoading = useLayoutStore(s => s.isPreviewServerLoading)
  const isInstallingDeps = useLayoutStore(s => s.isInstallingDeps)
  const isRunning = useLayoutStore(selectIsPreviewServerRunning)
  const logs = useLayoutStore(s => s.devServerLogs)
  const scrollRef = useRef<HTMLDivElement>(null)
  // X only hides the panel — logs stay in layoutStore until a new start
  // clears them (or an explicit clear elsewhere). Dismiss ≠ wipe.
  const [dismissed, setDismissed] = useState(false)

  // Project switch parks/restores layout per path. Reset local dismiss so a
  // dismissed panel on A does not suppress a real failure on B — and so we
  // never keep a floating panel identity across workspaces.
  useEffect(() => {
    setDismissed(false)
  }, [projectPath])

  // New install/start cycle → show the panel again.
  useEffect(() => {
    if (isLoading || isInstallingDeps) setDismissed(false)
  }, [isLoading, isInstallingDeps])

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  // Only show when loading/installing or when there are recent errors for the
  // focused project's server attempt. layoutStore is the focused mirror; park
  // restore already isolates logs per project.
  const hasErrors = logs.some(l => l.level === 'error')
  const visible = !dismissed && (isLoading || isInstallingDeps || (hasErrors && !isRunning))

  if (!projectPath || !visible || logs.length === 0) return null

  return (
    <Box
      position="fixed"
      bottom="80px"
      right="16px"
      w="380px"
      maxH="220px"
      bg="rgba(10, 10, 10, 0.95)"
      backdropFilter="blur(12px)"
      borderRadius="12px"
      border={`1px solid ${hasErrors ? 'rgba(248, 81, 73, 0.25)' : 'rgba(255, 255, 255, 0.08)'}`}
      boxShadow="0 8px 32px rgba(0, 0, 0, 0.5)"
      overflow="hidden"
      zIndex={tokens.zIndex.toast}
      css={{
        animation: 'slideUp 0.2s ease-out',
        '@keyframes slideUp': {
          from: { opacity: 0, transform: 'translateY(10px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py="8px"
        borderBottom="1px solid rgba(255, 255, 255, 0.06)"
      >
        {(isLoading || isInstallingDeps) ? (
          <Box
            w="12px"
            h="12px"
            borderRadius="full"
            border="2px solid transparent"
            borderTopColor={tokens.colors.accent.primary}
            borderRightColor={tokens.colors.accent.primary}
            css={{
              animation: 'spin 0.7s linear infinite',
              '@keyframes spin': { to: { transform: 'rotate(360deg)' } },
            }}
            flexShrink={0}
          />
        ) : (
          <FiMonitor size={12} color={hasErrors ? tokens.colors.accent.red : tokens.colors.accent.green} />
        )}
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary} flex={1}>
          {isInstallingDeps ? t('preview.installingDeps') : isLoading ? t('devserver.starting') : t('devserver.title')}
        </Text>
        <Box
          as="button"
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="18px"
          h="18px"
          borderRadius="4px"
          cursor="pointer"
          color={tokens.colors.text.disabled}
          aria-label={t('misc.dismiss')}
          title={t('misc.dismiss')}
          _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary }}
          onClick={() => setDismissed(true)}
        >
          <FiX size={11} />
        </Box>
      </Flex>

      {/* Logs */}
      <Box
        ref={scrollRef}
        maxH="170px"
        overflowY="auto"
        px={3}
        py="6px"
        css={{
          '&::-webkit-scrollbar': { width: '3px' },
          '&::-webkit-scrollbar-thumb': {
            background: 'rgba(255,255,255,0.1)',
            borderRadius: '3px',
          },
        }}
      >
        {logs.slice(-30).map((entry: DevServerLogEntry) => (
          <Text
            key={entry.id}
            fontSize="10.5px"
            fontFamily={tokens.fontFamily.mono}
            color={LOG_COLORS[entry.level] || tokens.colors.text.secondary}
            lineHeight="1.6"
            whiteSpace="pre-wrap"
            wordBreak="break-all"
          >
            {stripAnsi(entry.text)}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

export default memo(DevServerStatus)
