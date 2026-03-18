import { memo } from 'react'
import { VStack, Input, Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface SearchFiltersProps {
  includePatterns: string
  excludePatterns: string
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
}

function SearchFilters({
  includePatterns,
  excludePatterns,
  onIncludeChange,
  onExcludeChange,
}: SearchFiltersProps) {
  return (
    <Box px={3} pb={2}>
      <VStack gap={2} align="stretch">
        <Input
          placeholder="Files to include (e.g., *.tsx, *.ts)"
          value={includePatterns}
          onChange={(e) => onIncludeChange(e.target.value)}
          bg={tokens.colors.bg.input}
          border={`1px solid ${tokens.colors.border.glass}`}
          borderRadius="6px"
          fontSize="12px"
          _focus={{
            borderColor: tokens.colors.accent.primaryBorder,
            boxShadow: `0 0 0 1px ${tokens.colors.accent.primarySubtle}`,
          }}
          _placeholder={{ color: tokens.colors.text.hint, fontSize: '12px' }}
          size="sm"
          transition={`all ${tokens.transition.normal}`}
        />
        <Input
          placeholder="Files to exclude (e.g., node_modules/**)"
          value={excludePatterns}
          onChange={(e) => onExcludeChange(e.target.value)}
          bg={tokens.colors.bg.input}
          border={`1px solid ${tokens.colors.border.glass}`}
          borderRadius="6px"
          fontSize="12px"
          _focus={{
            borderColor: tokens.colors.accent.primaryBorder,
            boxShadow: `0 0 0 1px ${tokens.colors.accent.primarySubtle}`,
          }}
          _placeholder={{ color: tokens.colors.text.hint, fontSize: '12px' }}
          size="sm"
          transition={`all ${tokens.transition.normal}`}
        />
      </VStack>
    </Box>
  )
}

export default memo(SearchFilters)
