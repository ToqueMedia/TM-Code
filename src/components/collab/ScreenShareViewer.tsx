import { useEffect, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { VscClose, VscScreenFull } from 'react-icons/vsc'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { useCollabStore } from '@/stores/collabStore'
import { stopWatching } from '@/services/collab/collabScreen'

/**
 * Floating viewer for a teammate's screen share. Mounted once in MainLayout
 * (next to TeamChatPanel), visible while WE opted in to watch. The stream is
 * pure video — narration travels on the voice call — so the element is muted,
 * which also makes autoplay unconditionally allowed.
 */
export function ScreenShareViewer() {
  const t = useTranslation()
  const watching = useCollabStore((s) => s.screenWatching)
  const presenter = useCollabStore((s) => s.screenPresenter)
  const stream = useCollabStore((s) => s.screenRemoteStream)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => {/* retried implicitly by autoPlay */})
  }, [stream, watching])

  if (!watching || !presenter) return null

  return (
    <Box
      position="fixed"
      bottom="48px"
      right="348px" // sits beside the team chat panel (16 + 320 + 12)
      zIndex={49}
      w="560px"
      bg={tokens.colors.bg.overlay}
      border={`1px solid ${tokens.colors.border.default}`}
      borderRadius="8px"
      boxShadow="0 12px 40px rgba(0,0,0,0.45)"
      overflow="hidden"
    >
      <Flex
        align="center"
        justify="space-between"
        px={3}
        h="32px"
        bg={tokens.colors.bg.glass}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
      >
        <Flex align="center" gap={2} minW={0}>
          <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.red} flexShrink={0} />
          <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary} lineClamp={1}>
            {t('team.screenPresenting').replace('{name}', presenter.name)}
          </Text>
        </Flex>
        <Flex align="center" gap={2} flexShrink={0}>
          <Box
            as="button"
            aria-label={t('team.screenFullscreen')}
            title={t('team.screenFullscreen')}
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary }}
            onClick={() => void videoRef.current?.requestFullscreen().catch(() => {})}
          >
            <VscScreenFull size={14} />
          </Box>
          <Box
            as="button"
            aria-label={t('team.screenStopWatch')}
            title={t('team.screenStopWatch')}
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary }}
            onClick={() => stopWatching()}
          >
            <VscClose size={15} />
          </Box>
        </Flex>
      </Flex>

      <Box position="relative" bg="#000" aspectRatio="16 / 9">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
        {!stream && (
          <Flex position="absolute" inset={0} align="center" justify="center">
            <Text fontSize="11px" color={tokens.colors.text.muted}>
              {t('team.screenWaiting')}
            </Text>
          </Flex>
        )}
      </Box>
    </Box>
  )
}
