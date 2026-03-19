import { memo, useState, useCallback } from 'react'
import { Flex, Text, Box, ScrollArea } from '@chakra-ui/react'
import { FiTrash2 } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface LogEntry {
  id: number
  level: 'info' | 'warn' | 'error' | 'debug'
  source: string
  message: string
  timestamp: string
}

const levelColor = (level: LogEntry['level']) => {
  switch (level) {
    case 'error': return tokens.colors.accent.red
    case 'warn': return tokens.colors.accent.orange
    case 'info': return tokens.colors.accent.blueBright
    case 'debug': return tokens.colors.text.disabled
  }
}

const levelLabel = (level: LogEntry['level']) => {
  switch (level) {
    case 'error': return 'ERR'
    case 'warn': return 'WRN'
    case 'info': return 'INF'
    case 'debug': return 'DBG'
  }
}

const OutputContent = memo(() => {
  const [logs] = useState<LogEntry[]>([
    { id: 1, level: 'info', source: 'Extension Host', message: 'Starting extension host process...', timestamp: '12:00:01' },
    { id: 2, level: 'info', source: 'TypeScript', message: 'Language Server started', timestamp: '12:00:02' },
    { id: 3, level: 'info', source: 'Formatter', message: 'Code formatting enabled', timestamp: '12:00:02' },
    { id: 4, level: 'warn', source: 'Extensions', message: "Extension 'deprecated-ext' is deprecated", timestamp: '12:00:03' },
    { id: 5, level: 'debug', source: 'FileWatcher', message: 'Watching for file changes...', timestamp: '12:00:03' },
  ])

  const handleClear = useCallback(() => {
    // TODO: clear logs when backed by real output stream
  }, [])

  return (
    <Flex direction="column" flex="1" overflow="hidden">
      {/* Toolbar */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py={1}
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
        bg={tokens.colors.bg.panel}
        flexShrink={0}
      >
        <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
          {logs.length} entries
        </Text>
        <Box
          as="button"
          cursor="pointer"
          color={tokens.colors.text.muted}
          _hover={{ color: tokens.colors.text.primary }}
          transition={tokens.transition.fast}
          p={0.5}
          borderRadius="3px"
          onClick={handleClear}
        >
          <FiTrash2 size={12} />
        </Box>
      </Flex>

      {/* Log entries */}
      <ScrollArea.Root flex="1">
        <ScrollArea.Viewport>
          {logs.length === 0 ? (
            <Flex align="center" justify="center" py={8}>
              <Text fontSize="11px" color={tokens.colors.text.disabled}>No output</Text>
            </Flex>
          ) : (
            logs.map(log => (
              <Flex
                key={log.id}
                px={3}
                py="3px"
                gap={2}
                align="baseline"
                _hover={{ bg: 'rgba(255,255,255,0.02)' }}
                fontFamily={`"JetBrains Mono", ${tokens.fontFamily.mono}`}
                fontSize="12px"
                lineHeight="18px"
                fontWeight="300"
              >
                <Text color={tokens.colors.text.disabled} fontSize="10px" flexShrink={0} w="50px">
                  {log.timestamp}
                </Text>
                <Text
                  color={levelColor(log.level)}
                  fontSize="10px"
                  fontWeight="500"
                  flexShrink={0}
                  w="28px"
                >
                  {levelLabel(log.level)}
                </Text>
                <Text color={tokens.colors.text.muted} fontSize="11px" flexShrink={0}>
                  [{log.source}]
                </Text>
                <Text color={tokens.colors.text.primary} fontSize="12px" fontWeight="300">
                  {log.message}
                </Text>
              </Flex>
            ))
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical">
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </Flex>
  )
})

OutputContent.displayName = 'OutputContent'

export default OutputContent
