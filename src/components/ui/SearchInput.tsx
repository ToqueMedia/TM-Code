import React from 'react'
import { 
  HStack,
  Input,
  IconButton} from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'

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
        bg="transparent"
        border="1px solid"
        borderColor="border.glass"
        _focus={{
          borderColor: 'blue.500',
          boxShadow: 'none'
        }}
        size={compact ? "sm" : "md"}
      />
      
      {value && onClear && (
        <IconButton
          aria-label="Clear search"
          variant="ghost"
          size={compact ? "xs" : "sm"}
          color="text.secondary"
          onClick={onClear}
        >
          <FiX size={compact ? 12 : 14} />
        </IconButton>
      )}
    </HStack>
  )
}