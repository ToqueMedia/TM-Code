import { memo, useCallback } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiFolder, FiArrowRight } from 'react-icons/fi'
import { useProjectStore } from '../../stores/projectStore'
import AgentLogo from '../ui/AgentLogo'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

const suggestions = [
  { label: t('suggestions.reactTs'), prompt: t('suggestions.reactTsPrompt') },
  { label: t('suggestions.express'), prompt: t('suggestions.expressPrompt') },
  { label: t('suggestions.nextjs'), prompt: t('suggestions.nextjsPrompt') },
  { label: t('suggestions.fixBug'), prompt: t('suggestions.fixBugPrompt') },
  { label: t('suggestions.addTests'), prompt: t('suggestions.addTestsPrompt') },
  { label: t('suggestions.explain'), prompt: t('suggestions.explainPrompt') },
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
      flex="1"
      px={8}
      pb={16}
    >
      {/* ToqueMedia icon */}
      <Box mb={5}>
        <AgentLogo size={48} glow />
      </Box>

      <Text
        fontSize="26px"
        fontWeight="700"
        color={tokens.colors.text.primary}
        letterSpacing="-0.03em"
        mb={1}
      >
        {t("view.whatToBuild")}
      </Text>

      <Text
        fontSize="14px"
        color={tokens.colors.text.muted}
        mb={2}
      >
        {t("view.tmCodeHelp")}
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
