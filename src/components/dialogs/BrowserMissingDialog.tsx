import { Box, Button, Flex, HStack, Text, VStack } from '@chakra-ui/react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { FiAlertCircle } from 'react-icons/fi'
import { useE2EStore } from '../../stores/e2eStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

const CHROME_URL = 'https://www.google.com/chrome/'

export function BrowserMissingDialog() {
  const open = useE2EStore(s => s.browserMissingOpen)
  const resolve = useE2EStore(s => s.resolveBrowserMissing)
  if (!open) return null

  return (
    <Flex
      position="fixed"
      top={0}
      left={0}
      right={0}
      bottom={0}
      bg={tokens.colors.dialog.backdrop}
      zIndex={tokens.zIndex.overlay}
      alignItems="center"
      justifyContent="center"
      backdropFilter="blur(4px)"
    >
      <Box
        bg={tokens.colors.dialog.bg}
        border={`1px solid ${tokens.colors.dialog.border}`}
        borderRadius="12px"
        p={6}
        maxWidth="460px"
        width="90%"
        boxShadow={tokens.shadow.overlay}
      >
        <HStack gap={2} mb={3}>
          <FiAlertCircle size={16} color={tokens.colors.accent.orange} />
          <Text fontSize="15px" fontWeight={600} color={tokens.colors.text.primary}>
            {t('browser.missing.title')}
          </Text>
        </HStack>

        <VStack gap={3} alignItems="stretch" mb={5}>
          <Text fontSize="12px" color={tokens.colors.text.muted} lineHeight="1.6">
            {t('browser.missing.body')}
          </Text>
          <Box bg={tokens.colors.bg.whiteSubtle} borderRadius="8px" p={3}>
            <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.5">
              {t('browser.missing.subtext')}
            </Text>
          </Box>
        </VStack>

        <HStack gap={3} justifyContent="flex-end">
          <Button
            variant="ghost"
            size="sm"
            color={tokens.colors.text.secondary}
            _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
            onClick={() => resolve(false)}
          >
            {t('browser.missing.cancel')}
          </Button>
          <Button
            size="sm"
            bg={tokens.colors.accent.primary}
            color="white"
            _hover={{ opacity: 0.9 }}
            onClick={() => {
              openUrl(CHROME_URL).catch(() => {})
              resolve(true)
            }}
          >
            {t('browser.missing.install')}
          </Button>
        </HStack>
      </Box>
    </Flex>
  )
}
