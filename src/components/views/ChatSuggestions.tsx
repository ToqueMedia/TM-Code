import { memo, useCallback } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiFolder } from 'react-icons/fi'
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
      <Box mb={2}>
        <Text
          fontSize="28px"
          fontWeight="700"
          color={tokens.colors.text.primary}
          letterSpacing="-0.02em"
        >
          What do you want to build?
        </Text>
      </Box>

      {projectPath && (
        <Flex align="center" gap={1.5} mb={6}>
          <FiFolder size={14} color={tokens.colors.text.muted} />
          <Text
            fontSize="13px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.text.muted}
          >
            {projectPath}
          </Text>
        </Flex>
      )}

      <Flex
        wrap="wrap"
        gap={2}
        justify="center"
        maxW="500px"
      >
        {suggestions.map(s => (
          <Box
            key={s.label}
            as="button"
            px={4}
            py={2}
            bg={tokens.colors.bg.panel}
            border={`1px solid ${tokens.colors.border.panel}`}
            borderRadius="10px"
            color={tokens.colors.text.secondary}
            fontSize={tokens.fontSize.md}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{
              bg: tokens.colors.bg.panelAlt,
              borderColor: tokens.colors.accent.primary,
              color: tokens.colors.text.primary,
              transform: 'translateY(-1px)',
            }}
            _active={{ transform: 'scale(0.98)' }}
            onClick={() => handleSuggestionClick(s.prompt)}
          >
            {s.label}
          </Box>
        ))}
      </Flex>
    </Flex>
  )
}

export default memo(ChatSuggestions)
