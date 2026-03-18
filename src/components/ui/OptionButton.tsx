import React from 'react'
import { IconButton } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

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
      title={label}
      variant="ghost"
      size={sizeProps.buttonSize as "xs" | "sm" | "md"}
      color={isActive ? tokens.colors.accent.primary : tokens.colors.text.muted}
      onClick={onClick}
      bg={isActive ? tokens.colors.accent.primarySubtle : 'transparent'}
      borderRadius="4px"
      _hover={{
        bg: tokens.colors.bg.hoverSubtle,
        color: isActive ? tokens.colors.accent.primary : tokens.colors.text.primary,
      }}
      transition={`all ${tokens.transition.fast}`}
    >
      <Icon size={sizeProps.iconSize} />
    </IconButton>
  )
}
