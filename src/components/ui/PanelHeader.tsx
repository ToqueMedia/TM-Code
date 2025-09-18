import React from 'react'
import { 
  Flex, 
  Text, 
  HStack, 
  IconButton,
  Box
} from '@chakra-ui/react'

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
      p={compact ? 2 : 3}
      borderBottom="1px solid"
      borderColor="border.glass"
      bg="rgba(255, 255, 255, 0.01)"
    >
      <HStack gap={2}>
        <Text
          fontSize={compact ? "xs" : "sm"}
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="wide"
          color="text.secondary"
        >
          {title}
        </Text>
        {children}
      </HStack>
      
      {rightControls && (
        <HStack gap={1}>
          {rightControls}
        </HStack>
      )}
    </Flex>
  )
}