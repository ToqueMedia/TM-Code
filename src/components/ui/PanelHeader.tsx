import React from 'react'
import {
  Flex,
  Text,
  HStack
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface PanelHeaderProps {
  title: string
  children?: React.ReactNode
  rightControls?: React.ReactNode
  compact?: boolean
}

export const PanelHeader: React.FC<PanelHeaderProps> = ({
  title,
  children,
  rightControls,
  compact = false
}) => {
  return (
    <Flex
      align="center"
      justify="space-between"
      px={compact ? 2 : 3}
      height={compact ? '32px' : '36px'}
      flexShrink={0}
      borderBottom={`1px solid ${tokens.colors.border.default}`}
      bg={tokens.colors.bg.panel}
    >
      <HStack gap={1}>
        {title && (
          <Text
            fontSize="11px"
            fontWeight="600"
            textTransform="uppercase"
            letterSpacing="0.06em"
            color={tokens.colors.text.muted}
          >
            {title}
          </Text>
        )}
        {children}
      </HStack>

      {rightControls && (
        <HStack gap={0.5}>
          {rightControls}
        </HStack>
      )}
    </Flex>
  )
}
