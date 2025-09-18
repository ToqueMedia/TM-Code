import React from 'react'
import { 
  Button,
  HStack,
  Text,
  Badge
} from '@chakra-ui/react'

interface PanelTabProps {
  id: string
  label: string
  icon: React.ElementType
  isActive: boolean
  badge?: number
  badgeVariant?: 'error' | 'warning' | 'info'
  onClick: () => void
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
  <Button
    variant="ghost"
    size="sm"
    height="32px"
    px={3}
    bg={isActive ? 'whiteAlpha.100' : 'transparent'}
    borderBottom={isActive ? '2px solid' : 'none'}
    borderColor={isActive ? 'blue.500' : 'transparent'}
    borderRadius="0"
    color={isActive ? 'text.primary' : 'text.secondary'}
    _hover={{
      bg: isActive ? 'whiteAlpha.100' : 'whiteAlpha.050',
      color: 'text.primary'
    }}
    onClick={onClick}
    data-panel={id}
  >
    <HStack gap={2}>
      <Icon size={14} />
      <Text fontSize="xs" fontWeight="medium">{label}</Text>
      {badge && badge > 0 && (
        <Badge
          size="sm"
          colorPalette={badgeVariant === 'error' ? 'red' : badgeVariant === 'warning' ? 'orange' : 'blue'}
          fontSize="xs"
        >
          {badge > 99 ? '99+' : badge}
        </Badge>
      )}
    </HStack>
  </Button>
)