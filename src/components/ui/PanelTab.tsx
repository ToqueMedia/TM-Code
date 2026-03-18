import React from 'react'
import {
  Box,
  HStack,
  Text,
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface PanelTabProps {
  id: string
  label: string
  icon: React.ElementType
  isActive: boolean
  badge?: number
  badgeVariant?: 'error' | 'warning' | 'info'
  onClick: () => void
}

const badgeColors = {
  error: tokens.colors.accent.red,
  warning: tokens.colors.accent.orange,
  info: tokens.colors.accent.primary,
}

export const PanelTab: React.FC<PanelTabProps> = ({
  id,
  label,
  icon: Icon,
  isActive,
  badge,
  badgeVariant = 'info',
  onClick
}) => (
  <Box
    as="button"
    height="100%"
    px={3}
    bg="transparent"
    position="relative"
    color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
    cursor="pointer"
    display="flex"
    alignItems="center"
    transition={`all ${tokens.transition.fast}`}
    _hover={{
      color: tokens.colors.text.primary,
      bg: tokens.colors.bg.hoverSubtle,
    }}
    onClick={onClick}
    data-panel={id}
    _after={{
      content: '""',
      position: 'absolute',
      bottom: 0,
      left: '15%',
      right: '15%',
      height: '2px',
      bg: isActive ? tokens.colors.accent.primary : 'transparent',
      borderRadius: '2px 2px 0 0',
      transition: `all ${tokens.transition.normal}`,
      boxShadow: isActive ? `0 0 6px ${tokens.colors.accent.primaryGlow}` : 'none',
    }}
  >
    <HStack gap={1.5}>
      <Icon size={13} />
      <Text fontSize="11px" fontWeight={isActive ? '500' : '400'} letterSpacing="-0.01em">
        {label}
      </Text>
      {badge !== undefined && badge > 0 && (
        <Box
          fontSize="9px"
          fontWeight="bold"
          px="5px"
          py="1px"
          borderRadius="full"
          bg={`${badgeColors[badgeVariant]}20`}
          color={badgeColors[badgeVariant]}
          lineHeight="1.2"
        >
          {badge > 99 ? '99+' : badge}
        </Box>
      )}
    </HStack>
  </Box>
)
