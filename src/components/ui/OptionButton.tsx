import React from 'react'
import { 
  IconButton
} from '@chakra-ui/react'

interface OptionButtonProps {
  label: string
  icon: React.ElementType
  isActive?: boolean
  onClick: () => void
  size?: "xs" | "sm" | "md"
}

export const OptionButton: React.FC<OptionButtonProps> = ({ 
  label,
  icon: Icon,
  isActive = false,
  onClick,
  size = "sm"
}) => {
  const sizeProps = {
    xs: { iconSize: 12, buttonSize: "xs" },
    sm: { iconSize: 14, buttonSize: "sm" },
    md: { iconSize: 16, buttonSize: "md" }
  }[size]
  
  return (
    <IconButton
      aria-label={label}
      variant="ghost"
      size={sizeProps.buttonSize as "xs" | "sm" | "md"}
      color={isActive ? 'blue.500' : 'text.secondary'}
      onClick={onClick}
      bg={isActive ? 'whiteAlpha.100' : 'transparent'}
      _hover={{
        bg: 'whiteAlpha.050',
        color: isActive ? 'blue.500' : 'text.primary'
      }}
    >
      <Icon size={sizeProps.iconSize} />
    </IconButton>
  )
}