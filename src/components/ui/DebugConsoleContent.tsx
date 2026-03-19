import { memo, useState, useCallback, useRef, useEffect } from 'react'
import { Flex, Text, Box, ScrollArea, Input } from '@chakra-ui/react'
import { FiChevronRight, FiTrash2 } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface ConsoleEntry {
  id: number
  type: 'input' | 'output' | 'info' | 'error' | 'warn'
  text: string
}

const typeColor = (type: ConsoleEntry['type']) => {
  switch (type) {
    case 'input': return tokens.colors.text.primary
    case 'output': return tokens.colors.accent.green
    case 'info': return tokens.colors.accent.blueBright
    case 'error': return tokens.colors.accent.red
    case 'warn': return tokens.colors.accent.orange
  }
}

const DebugConsoleContent = memo(() => {
  const [entries] = useState<ConsoleEntry[]>([
    { id: 1, type: 'info', text: 'Debug session started' },
    { id: 2, type: 'info', text: 'Breakpoint hit: App.tsx:25' },
    { id: 3, type: 'input', text: 'console.log(user)' },
    { id: 4, type: 'output', text: '{ id: 1, name: "John Doe", email: "john@example.com" }' },
    { id: 5, type: 'info', text: 'Ready for evaluation' },
  ])

  const [inputValue, setInputValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries.length])

  const handleEvaluate = useCallback(() => {
    if (!inputValue.trim()) return
    // TODO: send to debug session
    setInputValue('')
  }, [inputValue])

  const handleClear = useCallback(() => {
    // TODO: clear console
  }, [])

  return (
    <Flex direction="column" flex="1" overflow="hidden">
      {/* Toolbar */}
      <Flex
        align="center"
        justify="flex-end"
        px={3}
        py={1}
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
        bg={tokens.colors.bg.panel}
        flexShrink={0}
      >
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

      {/* Console entries */}
      <ScrollArea.Root flex="1">
        <ScrollArea.Viewport ref={scrollRef}>
          {entries.length === 0 ? (
            <Flex align="center" justify="center" py={8}>
              <Text fontSize="11px" color={tokens.colors.text.disabled}>No debug output</Text>
            </Flex>
          ) : (
            entries.map(entry => (
              <Flex
                key={entry.id}
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
                {entry.type === 'input' ? (
                  <>
                    <FiChevronRight size={10} color={tokens.colors.accent.primary} style={{ flexShrink: 0, marginTop: 4 }} />
                    <Text color={tokens.colors.text.primary} fontWeight="400">{entry.text}</Text>
                  </>
                ) : (
                  <Text color={typeColor(entry.type)} pl="18px">{entry.text}</Text>
                )}
              </Flex>
            ))
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical">
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      {/* Input prompt */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py={1.5}
        borderTop={`1px solid ${tokens.colors.border.glass}`}
        bg={tokens.colors.bg.panel}
        flexShrink={0}
      >
        <FiChevronRight size={11} color={tokens.colors.accent.primary} />
        <Input
          value={inputValue}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInputValue(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') handleEvaluate() }}
          placeholder="Evaluate expression..."
          variant="outline"
          border="none"
          fontSize="12px"
          fontFamily={`"JetBrains Mono", ${tokens.fontFamily.mono}`}
          fontWeight="300"
          color={tokens.colors.text.primary}
          _placeholder={{ color: tokens.colors.text.disabled }}
          flex="1"
          height="22px"
        />
      </Flex>
    </Flex>
  )
})

DebugConsoleContent.displayName = 'DebugConsoleContent'

export default DebugConsoleContent
