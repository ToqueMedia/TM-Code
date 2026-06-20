import { Box, Flex, Text } from '@chakra-ui/react'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { canShareCode, useCollabStore, type LivePreview } from '@/stores/collabStore'
import { openPreview } from '@/services/collab/previewViewerService'

/**
 * Terminal-style banner for INCOMING live previews — a teammate is sharing their
 * running app and this user (in Terminal mode) can open + test it. Without this
 * the only access was the strip inside the team-chat panel, which is hidden
 * unless the chat is open; the offer toast is transient. Sits in the prompt
 * chrome and is clickable (opens the preview window).
 */
export function TerminalIncomingPreviewBanner() {
  const t = useTranslation()
  const livePreviews = useCollabStore((s) => s.livePreviews)

  if (livePreviews.length === 0 || !canShareCode()) return null

  const open = (lp: LivePreview) => void openPreview(lp.peerId, lp.name)

  return (
    <Box flexShrink={0} px={3} pt="6px" data-ui-chrome>
      {livePreviews.map((lp) => (
        <Flex
          key={lp.peerId}
          as="button"
          w="100%"
          align="center"
          gap={2}
          px={2.5}
          py="6px"
          mb="4px"
          textAlign="left"
          borderRadius={tokens.radius.sm}
          bg="rgba(163,113,247,0.10)"
          border="1px solid rgba(163,113,247,0.30)"
          color={tokens.colors.terminal.foreground}
          fontFamily={tokens.fontFamily.mono}
          transition="background 0.15s"
          _hover={{ bg: 'rgba(163,113,247,0.18)' }}
          onClick={() => open(lp)}
        >
          <Text as="span" flexShrink={0} color={tokens.colors.accent.purple} fontWeight="700">
            ▸
          </Text>
          <Box minW={0} flex={1}>
            <Text as="span" fontSize="11px" color={tokens.colors.accent.purple} lineClamp={1}>
              {t('team.previewOffered').replace('{name}', lp.name)}
            </Text>
            {lp.note && (
              <Text fontSize="10px" color={tokens.colors.terminal.brightBlack} lineClamp={1}>
                {lp.note}
              </Text>
            )}
          </Box>
          <Text as="span" flexShrink={0} fontSize="10px" color={tokens.colors.terminal.brightBlack}>
            [{t('team.openPreview').toLowerCase()}]
          </Text>
        </Flex>
      ))}
    </Box>
  )
}
