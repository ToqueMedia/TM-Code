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
    <Box p={3} borderBottom={`1px solid ${tokens.colors.border.default}`}>
      <VStack gap={2} align="stretch">
        <Input
          placeholder="Search"
          value={searchTerm}
          onKeyPress={(e) => e.key === 'Enter' && onSearch()}
          onChange={(e) => onSearchTermChange(e.target.value)}
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

        {isReplaceVisible && (
          <Input
            placeholder="Replace"
            value={replaceTerm}
            onChange={(e) => onReplaceTermChange(e.target.value)}
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
        )}

        <HStack justify="space-between">
          <HStack gap={0.5}>
            <IconButton
              aria-label="Match case"
              title="Match case"
              variant="ghost"
              size="xs"
              borderRadius="4px"
              color={caseSensitive ? tokens.colors.accent.primary : tokens.colors.text.muted}
              bg={caseSensitive ? tokens.colors.accent.primarySubtle : 'transparent'}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={onToggleCaseSensitive}
              transition={`all ${tokens.transition.fast}`}
            >
              <FiType size={12} />
            </IconButton>
            <IconButton
              aria-label="Whole word"
              title="Match whole word"
              variant="ghost"
              size="xs"
              borderRadius="4px"
              color={wholeWord ? tokens.colors.accent.primary : tokens.colors.text.muted}
              bg={wholeWord ? tokens.colors.accent.primarySubtle : 'transparent'}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={onToggleWholeWord}
              transition={`all ${tokens.transition.fast}`}
            >
              <FiType size={12} />
            </IconButton>
            <IconButton
              aria-label="Use regex"
              title="Use regular expressions"
              variant="ghost"
              size="xs"
              borderRadius="4px"
              color={useRegex ? tokens.colors.accent.primary : tokens.colors.text.muted}
              bg={useRegex ? tokens.colors.accent.primarySubtle : 'transparent'}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={onToggleRegex}
              transition={`all ${tokens.transition.fast}`}
            >
              <FiSearch size={12} />
            </IconButton>
          </HStack>

          <Button
            size="xs"
            onClick={onSearch}
            disabled={isSearching || !ripgrepAvailable || !hasProject}
            bg={tokens.colors.accent.primary}
            color="#fff"
            borderRadius="6px"
            fontSize="11px"
            _hover={{
              bg: tokens.colors.accent.primaryDark,
              boxShadow: `0 2px 8px ${tokens.colors.accent.primaryGlow}`,
            }}
            _disabled={{
              opacity: 0.4,
              cursor: 'not-allowed',
            }}
            transition={`all ${tokens.transition.normal}`}
          >
            {isSearching ? <Spinner size="xs" /> : <FiSearch size={12} />}
          </Button>
        </HStack>
      </VStack>
    </Box>
  )
}

export default memo(SearchInputArea)
