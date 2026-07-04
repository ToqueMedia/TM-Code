import { memo, useCallback } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiFolder, FiArrowUpRight } from 'react-icons/fi'
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

  if (!projectPath) {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        flex="1"
        px={{ base: 5, md: 8 }}
        pb={16}
      >
        <Box mb={5}>
          <AgentLogo size={48} glow />
        </Box>
        <Text
          fontSize={{ base: '22px', md: '26px' }}
          fontWeight="700"
          color={tokens.colors.text.primary}
          letterSpacing="-0.03em"
          mb={1}
        >
          {t('chat.empty.noProject.title')}
        </Text>
        <Text
          fontSize={{ base: '13px', md: '14px' }}
          color={tokens.colors.text.muted}
          maxW="460px"
          textAlign="center"
          lineHeight="1.55"
        >
          {t('chat.empty.noProject.subtitle')}
        </Text>
      </Flex>
    )
  }

  return (
      <Flex
      direction="column"
      align="center"
      justify="center"
      flex="1"
      px={{ base: 5, md: 8 }}
      pb={16}
    >
      {/* ToqueMedia icon */}
      <Box mb={5}>
        <AgentLogo size={48} glow />
      </Box>

      <Text
        fontSize={{ base: '22px', md: '26px' }}
        fontWeight="700"
        color={tokens.colors.text.primary}
        letterSpacing="-0.03em"
        mb={1}
      >
        {t("view.whatToBuild")}
      </Text>

      <Text
        fontSize={{ base: '13px', md: '14px' }}
        color={tokens.colors.text.muted}
        mb={2}
      >
        {t("view.tmCodeHelp")}
      </Text>

      <Flex
        align="center"
        gap={1.5}
        mb={7}
        maxW="min(620px, 100%)"
        px={3}
        py="5px"
        borderRadius="999px"
        bg="rgba(255, 255, 255, 0.025)"
        border="1px solid rgba(255, 255, 255, 0.05)"
      >
        <FiFolder size={13} color={tokens.colors.text.disabled} />
        <Text
          fontSize="12px"
          fontFamily={tokens.fontFamily.mono}
          color={tokens.colors.text.disabled}
          truncate
        >
          {projectPath}
        </Text>
      </Flex>

      <Flex direction="column" align="stretch" gap={0} maxW="720px" w="100%">
        {suggestions.map((s, index) => (
          <Box
            key={s.label}
            as="button"
            display="grid"
            gridTemplateColumns={{ base: '1fr auto', md: '190px 1fr auto' }}
            alignItems="center"
            gap={{ base: 2, md: 3 }}
            w="100%"
            px={{ base: 2.5, md: 3 }}
            py={{ base: 2.5, md: 3 }}
            bg="transparent"
            border="0"
            borderTop={index === 0 ? '1px solid rgba(255, 255, 255, 0.06)' : '0'}
            borderBottom="1px solid rgba(255, 255, 255, 0.06)"
            color={tokens.colors.text.muted}
            cursor="pointer"
            transition="background 0.15s ease, color 0.15s ease, transform 0.15s ease"
            textAlign="left"
            _hover={{
              bg: 'rgba(255, 255, 255, 0.025)',
              color: tokens.colors.text.primary,
              transform: 'translateX(2px)',
            }}
            _active={{ transform: 'scale(0.98)' }}
            onClick={() => handleSuggestionClick(s.prompt)}
          >
            <Text
              as="span"
              display={{ base: 'none', md: 'block' }}
              fontSize="11px"
              color={tokens.colors.accent.primary}
              fontWeight="700"
              textTransform="uppercase"
              letterSpacing="0.08em"
              lineClamp={1}
            >
              {s.label}
            </Text>
            <Box minW={0}>
              <Text
                display={{ base: 'block', md: 'none' }}
                fontSize="10px"
                color={tokens.colors.accent.primary}
                fontWeight="700"
                textTransform="uppercase"
                letterSpacing="0.08em"
                mb="3px"
                lineClamp={1}
              >
                {s.label}
              </Text>
              <Text as="span" color="inherit" fontSize={{ base: '13px', md: '14px' }} lineHeight="1.45">
              {s.prompt}
              </Text>
            </Box>
            <Box color={tokens.colors.text.disabled} display="flex" justifyContent="flex-end">
              <FiArrowUpRight size={13} />
            </Box>
          </Box>
        ))}
      </Flex>
    </Flex>
  )
}

export default memo(ChatSuggestions)
