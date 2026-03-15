import { memo } from 'react'
import {
  VStack,
  HStack,
  Box,
  Input,
  IconButton,
  Button,
  Spinner
} from '@chakra-ui/react'
import {
  FiSearch,
  FiType,
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface SearchInputAreaProps {
  searchTerm: string
  replaceTerm: string
  isReplaceVisible: boolean
  isSearching: boolean
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  ripgrepAvailable: boolean | null
  hasProject: boolean
  onSearchTermChange: (value: string) => void
  onReplaceTermChange: (value: string) => void
  onSearch: () => void
  onToggleCaseSensitive: () => void
  onToggleWholeWord: () => void
  onToggleRegex: () => void
}

function SearchInputArea({
  searchTerm,
  replaceTerm,
  isReplaceVisible,
  isSearching,
  caseSensitive,
  wholeWord,
  useRegex,
  ripgrepAvailable,
  hasProject,
  onSearchTermChange,
  onReplaceTermChange,
  onSearch,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
}: SearchInputAreaProps) {
  return (
    <Box p={3} borderBottom="1px solid" borderColor="border.glass">
      <VStack gap={2} align="stretch">
        <Input
          placeholder="Search"
          value={searchTerm}
          onKeyPress={(e) => e.key === 'Enter' && onSearch()}
          onChange={(e) => onSearchTermChange(e.target.value)}
          bg="transparent"
          border="1px solid"
          borderColor="border.glass"
          _focus={{
            borderColor: tokens.colors.accent.blue,
            boxShadow: 'none'
          }}
          size="sm"
        />

        {isReplaceVisible && (
          <Input
            placeholder="Replace"
            value={replaceTerm}
            onChange={(e) => onReplaceTermChange(e.target.value)}
            bg="transparent"
            border="1px solid"
            borderColor="border.glass"
            _focus={{
              borderColor: tokens.colors.accent.blue,
              boxShadow: 'none'
            }}
            size="sm"
          />
        )}

        <HStack justify="space-between">
          <HStack gap={1}>
            <IconButton
              aria-label="Match case"
              variant="ghost"
              size="xs"
              color={caseSensitive ? tokens.colors.accent.blue : tokens.colors.text.secondary}
              onClick={onToggleCaseSensitive}
            >
              <FiType size={12} />
            </IconButton>
            <IconButton
              aria-label="Whole word"
              variant="ghost"
              size="xs"
              color={wholeWord ? tokens.colors.accent.blue : tokens.colors.text.secondary}
              onClick={onToggleWholeWord}
            >
              <FiType size={12} />
            </IconButton>
            <IconButton
              aria-label="Use regex"
              variant="ghost"
              size="xs"
              color={useRegex ? tokens.colors.accent.blue : tokens.colors.text.secondary}
              onClick={onToggleRegex}
              title="Use regular expressions"
            >
              <FiSearch size={12} />
            </IconButton>
          </HStack>

          <Button
            size="xs"
            onClick={onSearch}
            disabled={isSearching || !ripgrepAvailable || !hasProject}
            colorPalette="blue"
          >
            {isSearching ? <Spinner size="xs" /> : <FiSearch size={12} />}
          </Button>
        </HStack>
      </VStack>
    </Box>
  )
}

export default memo(SearchInputArea)
