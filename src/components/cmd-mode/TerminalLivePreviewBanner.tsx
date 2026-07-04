import { Box, Flex, Text } from '@chakra-ui/react'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { canShareCode, useCollabStore } from '@/stores/collabStore'
import { stopLivePreview } from '@/services/collab/collabSessionService'

/**
 * Shell-style banner shown while THIS user is sharing a Live Preview. Sits in
 * the prompt chrome so the sharer always sees the share is live and how to stop
 * it: click the banner, or run `/live-preview` again. Also pairs with the
 * exit-block (you can't leave the surface while sharing).
 */
export function TerminalLivePreviewBanner() {
  const t = useTranslation()
  const sharing = useCollabStore((s) => s.sharingPreview)
  const starting = useCollabStore((s) => s.startingPreview)

  if ((!sharing && !starting) || !canShareCode()) return null

  return (
    <Box flexShrink={0} px={3} py="6px" data-ui-chrome>
      <Flex
        as="button"
        w="100%"
        align="center"
        gap={2}
        px={2.5}
        py="6px"
        textAlign="left"
        borderRadius={tokens.radius.sm}
        bg="rgba(35, 209, 139, 0.10)"
        border={`1px solid rgba(35, 209, 139, 0.30)`}
        color={tokens.colors.terminal.foreground}
        fontFamily={tokens.fontFamily.mono}
        transition="background 0.15s"
        _hover={starting ? {} : { bg: 'rgba(35, 209, 139, 0.18)' }}
        cursor={starting ? 'default' : 'pointer'}
        onClick={() => { if (!starting) stopLivePreview() }}
      >
        {/* Pulsing live dot */}
        <Box
          flexShrink={0}
          w="7px"
          h="7px"
          borderRadius="full"
          bg={tokens.colors.terminal.brightGreen}
          css={{ animation: 'tlpb-pulse 1.2s ease-in-out infinite', '@keyframes tlpb-pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.3 } } }}
        />
        <Text as="span" flex={1} minW={0} fontSize="11px" color={tokens.colors.terminal.brightGreen} lineClamp={1}>
          {starting ? t('team.startingPreview') : t('team.liveSharingActive')}
        </Text>
        {!starting && (
          <Text as="span" flexShrink={0} fontSize="10px" color={tokens.colors.terminal.brightBlack}>
            /live-preview · [{t('team.stopShortcut')}]
          </Text>
        )}
      </Flex>
    </Box>
  )
}
