import { memo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n/useTranslation'
import { useCompactionProgress, formatCompactElapsed } from '../../hooks/useCompactionProgress'

/**
 * Refined-terminal compaction indicator. Renders inline at the bottom of the
 * scrollback while the agent compresses context:
 *
 *   * Compacting conversation… (1m 37s)
 *     ████████████░░░░░░░░░░  58%
 *
 * Flat and sharp (0 radius), purple structural accent. The bar width is a
 * synthetic time-eased estimate (see useCompactionProgress) — there is no real
 * progress signal for the summarization — so it never claims 100%; it just
 * disappears when compaction ends.
 */
export const TerminalCompactionIndicator = memo(function TerminalCompactionIndicator() {
  const { active, percent, elapsedMs } = useCompactionProgress()
  if (!active) return null

  // i18n value carries a trailing "..." — normalize to a single ellipsis.
  const label = t('chat.compact.compacting').replace(/[.…]+\s*$/, '')

  return (
    <Box my={2} fontFamily={tokens.fontFamily.mono} data-no-focus-steal>
      <Flex align="center" gap={2} wrap="wrap">
        <Text color={tokens.colors.accent.purple} fontSize="13px" fontWeight="800" flexShrink={0} lineHeight="1.4">
          *
        </Text>
        <Text color={tokens.colors.accent.purple} fontSize="13px" fontWeight="600" flexShrink={0}>
          {label}…
        </Text>
        <Text color={tokens.colors.text.disabled} fontSize="12px" flexShrink={0}>
          ({formatCompactElapsed(elapsedMs)})
        </Text>
      </Flex>

      {/* Flat sharp bar — fill is the structural purple, track a subtle wash. */}
      <Flex align="center" gap={2} mt="5px" pl={4}>
        <Box flex="1" maxW="440px" h="6px" bg="rgba(255, 255, 255, 0.08)" overflow="hidden" position="relative">
          <Box
            position="absolute"
            left={0}
            top={0}
            bottom={0}
            width={`${percent}%`}
            bg={tokens.colors.accent.purple}
            transition="width 0.25s linear"
          />
        </Box>
        <Text
          color={tokens.colors.text.muted}
          fontSize="12px"
          minW="36px"
          textAlign="right"
          css={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {percent}%
        </Text>
      </Flex>
    </Box>
  )
})
