import { memo } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { useBillingStore } from '../../stores/billingStore'
import { tokens } from '@/theme/tokens'

export const BillingOverageBanner = memo(function BillingOverageBanner() {
  const consumedPct = useBillingStore(s => s.consumedPct)
  if (consumedPct <= 1) return null

  return (
    <Flex
      align="center"
      gap={2}
      px={3}
      py="5px"
      bg="rgba(247,127,0,0.06)"
      borderBottom="1px solid rgba(247,127,0,0.15)"
      flexShrink={0}
      data-tauri-drag-region
    >
      <Text fontSize="11px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} fontWeight="700">!</Text>
      <Text fontSize="11px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} opacity={0.9}>
        usage over budget — agent may be throttled
      </Text>
    </Flex>
  )
})
