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
          placeholder="Files to include (comma-separated, e.g., *.tsx,*.ts)"
          value={includePatterns}
          onChange={(e) => onIncludeChange(e.target.value)}
          bg="transparent"
          border="1px solid"
          borderColor="border.glass"
          _focus={{
            borderColor: tokens.colors.accent.blue,
            boxShadow: 'none'
          }}
          size="sm"
        />
        <Input
          placeholder="Files to exclude (comma-separated, e.g., *.min.js,node_modules/**)"
          value={excludePatterns}
          onChange={(e) => onExcludeChange(e.target.value)}
          bg="transparent"
          border="1px solid"
          borderColor="border.glass"
          _focus={{
            borderColor: tokens.colors.accent.blue,
            boxShadow: 'none'
          }}
          size="sm"
        />
      </VStack>
    </Box>
  )
}

export default memo(SearchFilters)
