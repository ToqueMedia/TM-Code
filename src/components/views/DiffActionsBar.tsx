import { memo } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface DiffActionsBarProps {
  activeDiffsCount: number
  onRejectAll: () => void
  onAcceptAll: () => void
}

function DiffActionsBar({ activeDiffsCount, onRejectAll, onAcceptAll }: DiffActionsBarProps) {
  return (
    <Flex
      align="center"
      justify="space-between"
      px={4}
      py={2}
      bg={tokens.colors.bg.panel}
      borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
      flexShrink={0}
    >
      <Text fontSize={tokens.fontSize.md} color={tokens.colors.text.primary} fontWeight="600">
        Changes ({activeDiffsCount})
      </Text>
      {activeDiffsCount > 0 && (
        <Flex gap={2}>
          <button
            onClick={onRejectAll}
            style={{
              padding: '4px 12px',
              background: tokens.colors.accent.redSubtle,
              border: `1px solid ${tokens.colors.accent.redMuted}`,
              borderRadius: '6px',
              color: tokens.colors.accent.red,
              fontSize: tokens.fontSize.sm,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            Reject All
          </button>
          <button
            onClick={onAcceptAll}
            style={{
              padding: '4px 12px',
              background: tokens.colors.accent.greenSubtle,
              border: `1px solid ${tokens.colors.accent.greenMuted}`,
              borderRadius: '6px',
              color: tokens.colors.accent.green,
              fontSize: tokens.fontSize.sm,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            Accept All
          </button>
        </Flex>
      )}
    </Flex>
  )
}

export default memo(DiffActionsBar)
