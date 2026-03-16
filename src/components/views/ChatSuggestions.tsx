import { memo, useCallback } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiFolder, FiArrowRight } from 'react-icons/fi'
import { useProjectStore } from '../../stores/projectStore'
import { tokens } from '@/theme/tokens'

const suggestions = [
  { label: 'React + TypeScript app', prompt: 'Create a React application with TypeScript and Tailwind CSS' },
  { label: 'REST API with Express', prompt: 'Create an Express.js REST API server with TypeScript' },
  { label: 'Full-stack Next.js app', prompt: 'Create a full-stack Next.js application with authentication' },
  { label: 'Fix a bug', prompt: 'Help me fix a bug in my code' },
  { label: 'Add tests', prompt: 'Add unit tests to my project' },
  { label: 'Explain code', prompt: 'Explain how this codebase works' },
]

function ChatSuggestions() {
  const projectPath = useProjectStore(s => s.currentProject?.path)

  const handleSuggestionClick = useCallback((prompt: string) => {
    window.dispatchEvent(new CustomEvent('promptbar:insert', { detail: prompt }))
  }, [])

  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      height="100%"
      px={8}
      pb={16}
    >
      {/* Diamond icon */}
      <Flex
        w="48px"
        h="48px"
        borderRadius="14px"
        bgGradient={tokens.gradient.accentPrimary}
        align="center"
        justify="center"
        mb={5}
        boxShadow="0 8px 32px rgba(254, 16, 99, 0.3)"
      >
        <Text fontSize="22px" color="white" fontWeight="800" lineHeight="1">
          ◆
        </Text>
      </Flex>

      <Text
        fontSize="26px"
        fontWeight="700"
        color={tokens.colors.text.primary}
        letterSpacing="-0.03em"
        mb={1}
      >
        What do you want to build?
      </Text>

      <Text
        fontSize="14px"
        color={tokens.colors.text.muted}
        mb={2}
      >
        Diamond can help you code, debug, and ship faster.
      </Text>

      {projectPath && (
        <Flex align="center" gap={1.5} mb={6}>
          <FiFolder size={13} color={tokens.colors.text.disabled} />
          <Text
            fontSize="12px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.text.disabled}
          >
            {projectPath}
          </Text>
        </Flex>
      )}

      <Flex
        wrap="wrap"
        gap="8px"
        justify="center"
        maxW="520px"
      >
        {suggestions.map(s => (
          <Flex
            key={s.label}
            as="button"
            align="center"
            gap={2}
            px={4}
            py="9px"
            bg="rgba(255, 255, 255, 0.03)"
            border="1px solid rgba(255, 255, 255, 0.06)"
            borderRadius="10px"
            color={tokens.colors.text.secondary}
            fontSize="13px"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{
              bg: 'rgba(255, 255, 255, 0.05)',
              borderColor: 'rgba(254, 16, 99, 0.25)',
              color: tokens.colors.text.primary,
              transform: 'translateY(-1px)',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
            _active={{ transform: 'scale(0.98)' }}
            onClick={() => handleSuggestionClick(s.prompt)}
            css={{
              '&:hover .arrow-icon': { opacity: 1, transform: 'translateX(0)' },
            }}
          >
            {s.label}
            <Box
              className="arrow-icon"
              opacity={0}
              transform="translateX(-4px)"
              transition="all 0.15s"
              color={tokens.colors.accent.primary}
            >
              <FiArrowRight size={13} />
            </Box>
          </Flex>
        ))}
      </Flex>
    </Flex>
  )
}

export default memo(ChatSuggestions)
