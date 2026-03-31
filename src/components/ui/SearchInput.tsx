import React from 'react'
import {
  HStack,
  Input,
  IconButton
} from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  onClear?: () => void
  placeholder?: string
  compact?: boolean
}

export const SearchInput: React.FC<SearchInputProps> = ({
  value,
  onChange,
  onClear,
  placeholder = "Search...",
  compact = false
}) => {
  return (
    <HStack w="100%">
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        bg={tokens.colors.bg.input}
        border={`1px solid ${tokens.colors.border.glass}`}
        borderRadius="6px"
        fontSize="12px"
        _focus={{
          borderColor: tokens.colors.accent.primaryBorder,
          boxShadow: `0 0 0 1px ${tokens.colors.accent.primarySubtle}`,
        }}
        _placeholder={{ color: tokens.colors.text.hint, fontSize: '12px' }}
        size={compact ? "sm" : "md"}
        transition={`all ${tokens.transition.normal}`}
      />

      {value && onClear && (
        <IconButton
          aria-label={t("search.clearSearch")}
          variant="ghost"
          size={compact ? "xs" : "sm"}
          color={tokens.colors.text.muted}
          _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
          onClick={onClear}
          borderRadius="4px"
        >
          <FiX size={compact ? 12 : 14} />
        </IconButton>
      )}
    </HStack>
  )
}
