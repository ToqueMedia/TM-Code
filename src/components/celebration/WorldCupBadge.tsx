import { Box, Text } from '@chakra-ui/react'
import { FootballMark } from './FootballMark'
import { FOOTBALL_MODE_ENABLED } from '@/utils/worldCup'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

// Small persistent "World Cup 2026" pill for the Welcome hero. Always-visible
// seasonal cue so the surface still reads as themed after the one-shot kick-off
// burst fades. Glass pill matching the hero cards; renders nothing when the
// seasonal feature is off.
export function WorldCupBadge() {
  if (!FOOTBALL_MODE_ENABLED) return null
  return (
    <Box
      display="inline-flex"
      alignItems="center"
      gap={2}
      px={3}
      py="6px"
      borderRadius="full"
      bg="rgba(255, 255, 255, 0.04)"
      backdropFilter="blur(16px)"
      border="1px solid"
      borderColor={tokens.colors.accent.primaryMuted}
    >
      <FootballMark size={18} glow={false} />
      <Text
        fontSize="11px"
        fontWeight="700"
        letterSpacing="0.04em"
        textTransform="uppercase"
        color={tokens.colors.text.secondary}
      >
        {t('celebration.worldCup')}
      </Text>
    </Box>
  )
}
