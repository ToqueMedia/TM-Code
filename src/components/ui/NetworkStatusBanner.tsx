import { memo } from 'react'
import { Box, Flex, HStack, Text } from '@chakra-ui/react'
import { FiWifiOff, FiRefreshCw, FiAlertTriangle } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'

function NetworkStatusBanner() {
  const t = useTranslation()
  const { status, recheck } = useNetworkStatus()

  if (status === 'online') return null

  const isOffline = status === 'offline'
  const accent = isOffline ? '#f85149' : tokens.colors.accent.orange
  const Icon = isOffline ? FiWifiOff : FiAlertTriangle
  const title = isOffline
    ? t('network.offline')
    : t('network.slow')

  return (
    <Box
      position="absolute"
      top="44px"
      left="50%"
      transform="translateX(-50%)"
      zIndex={6}
      maxW="640px"
      w="calc(100% - 48px)"
      bg="rgba(26, 26, 26, 0.94)"
      backdropFilter="blur(14px)"
      border={`1px solid ${accent}40`}
      borderRadius="12px"
      boxShadow="0 12px 40px rgba(0, 0, 0, 0.5)"
      px={4}
      py={2.5}
      data-no-drag
      role="status"
      aria-live="polite"
      css={{
        animation: 'netBannerIn 0.2s ease-out',
        '@keyframes netBannerIn': {
          from: { opacity: 0, transform: 'translate(-50%, -8px)' },
          to: { opacity: 1, transform: 'translate(-50%, 0)' },
        },
      }}
    >
      <Flex align="center" gap={3}>
        <Box
          w="28px"
          h="28px"
          borderRadius="full"
          bg={`${accent}26`}
          display="flex"
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
        >
          <Icon size={14} color={accent} />
        </Box>
        <Text fontSize="12.5px" fontWeight="500" color={tokens.colors.text.primary} flex={1} lineClamp={1}>
          {title}
        </Text>
        <HStack gap={1} flexShrink={0}>
          <Box
            as="button"
            aria-label="Retry connection"
            display="flex"
            alignItems="center"
            gap="4px"
            px="10px"
            py="5px"
            borderRadius="6px"
            bg="rgba(255, 255, 255, 0.06)"
            border={`1px solid ${tokens.colors.border.glass}`}
            color={tokens.colors.text.secondary}
            fontSize="11px"
            fontWeight="600"
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: 'rgba(255, 255, 255, 0.1)', color: tokens.colors.text.primary }}
            onClick={() => recheck()}
          >
            <FiRefreshCw size={10} />
            Retry
          </Box>
        </HStack>
      </Flex>
    </Box>
  )
}

export default memo(NetworkStatusBanner)
