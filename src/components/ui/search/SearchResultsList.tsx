import { memo } from 'react'
import {
  Text, IconButton, Box, Button, Flex, ScrollArea, Badge, HStack
} from '@chakra-ui/react'
import {
  FiSearch, FiChevronDown, FiChevronRight, FiFile, FiAlertCircle
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { SearchResult } from '../../../services/searchService'
import { FileResult, FileMatchResult } from './types'

interface SearchResultsListProps {
  fileResults: FileResult[]
  searchResult: SearchResult | null
  searchTerm: string
  isSearching: boolean
  isReplaceVisible: boolean
  replaceTerm: string
  error: string | null
  onToggleFileExpansion: (filePath: string) => void
  onResultClick: (result: FileMatchResult) => void
  onReplace: () => void
}

function SearchResultsList({
  fileResults, searchResult, searchTerm, isSearching,
  isReplaceVisible, replaceTerm, error,
  onToggleFileExpansion, onResultClick, onReplace,
}: SearchResultsListProps) {
  return (
    <Box flex="1">
      {error && (
        <Box bg="red.900" color="red.100" p={3} borderRadius="md" mx={3} mb={2}>
          <HStack><FiAlertCircle size={16} /><Text fontSize="sm">{error}</Text></HStack>
        </Box>
      )}

      {searchResult && searchResult.total_matches > 0 && (
        <Flex align="center" justify="space-between" p={3}
          bg={tokens.colors.bg.footerOverlay} borderBottom="1px solid" borderColor="border.glass">
          <Text fontSize="xs" color="text.muted">
            {searchResult.total_matches} results in {searchResult.total_files} files
            {searchResult.truncated && ' (truncated)'}
            {searchResult.duration_ms && ` - ${searchResult.duration_ms}ms`}
          </Text>
          {isReplaceVisible && (
            <Button size="xs" variant="outline" onClick={onReplace} disabled={!replaceTerm.trim()}>
              Replace All
            </Button>
          )}
        </Flex>
      )}

      <ScrollArea.Root flex="1">
        <ScrollArea.Viewport>
          {fileResults.map((fileResult) => (
            <Box key={fileResult.file}>
              <Flex align="center" px={3} py={2} cursor="pointer"
                _hover={{ bg: 'whiteAlpha.050' }} onClick={() => onToggleFileExpansion(fileResult.file)}>
                <IconButton aria-label="Expand" variant="ghost" size="xs"
                  color={tokens.colors.text.secondary} mr={1}>
                  {fileResult.isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                </IconButton>
                <FiFile size={14} color={tokens.colors.accent.primary} />
                <Text fontSize="sm" color={tokens.colors.text.primary} ml={2} flex="1"
                  whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                  {fileResult.file}
                </Text>
                <Badge size="sm" colorPalette="blue" ml={2}>{fileResult.matches.length}</Badge>
              </Flex>

              {fileResult.isExpanded && fileResult.matches.map((match) => (
                <Flex key={match.id} align="center" px={6} py={1} cursor="pointer"
                  _hover={{ bg: 'whiteAlpha.050', borderColor: tokens.colors.accent.blue }}
                  onClick={() => onResultClick(match)} borderLeft="2px solid transparent">
                  <Text fontSize="xs" color="text.muted" minW="40px" mr={3}>{match.line}</Text>
                  <Text fontSize="xs" color={tokens.colors.text.primary} fontFamily="mono" flex="1"
                    whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                    {match.context}
                  </Text>
                </Flex>
              ))}
            </Box>
          ))}

          {fileResults.length === 0 && searchTerm && !isSearching && (
            <Flex align="center" justify="center" p={6} direction="column" color="text.muted">
              <FiSearch size={32} />
              <Text fontSize="sm" mt={2} textAlign="center">No results found for "{searchTerm}"</Text>
            </Flex>
          )}

          {!searchTerm && (
            <Flex align="center" justify="center" p={6} direction="column" color="text.muted">
              <FiSearch size={32} />
              <Text fontSize="sm" mt={2} textAlign="center">Search across all files in the workspace</Text>
              <Text fontSize="xs" mt={1} color="text.muted">Enter a search term to get started</Text>
            </Flex>
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical"><ScrollArea.Thumb /></ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </Box>
  )
}

export default memo(SearchResultsList)
