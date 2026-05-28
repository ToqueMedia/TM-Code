import { memo } from 'react'
import {
  Text, IconButton, Box, Button, Flex, ScrollArea, HStack
} from '@chakra-ui/react'
import {
  FiSearch, FiChevronDown, FiChevronRight, FiFile, FiAlertCircle
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
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
  onFileSelect?: (path: string) => void
}

function SearchResultsList({
  fileResults, searchResult, searchTerm, isSearching,
  isReplaceVisible, replaceTerm, error,
  onToggleFileExpansion, onResultClick, onReplace, onFileSelect,
}: SearchResultsListProps) {
  const fileNameMatches = searchResult?.file_name_matches ?? []
  const hasContentResults = fileResults.length > 0
  const hasFileNameResults = fileNameMatches.length > 0

  return (
    <Box flex="1">
      {error && (
        <Box bg="red.900" color="red.100" p={3} borderRadius="md" mx={3} mb={2}>
          <HStack><FiAlertCircle size={16} /><Text fontSize="sm">{error}</Text></HStack>
        </Box>
      )}

      {searchResult && (searchResult.total_matches > 0 || hasFileNameResults) && (
        <Flex align="center" justify="space-between" p={3}
          bg={tokens.colors.bg.footerOverlay} borderBottom="1px solid" borderColor="border.glass">
          <Text fontSize="xs" color="text.muted">
            {searchResult.total_matches} results in {searchResult.total_files} files
            {hasFileNameResults && ` · ${fileNameMatches.length} t("misc.fileNames")`}
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
          {/* File name matches — shown at top */}
          {hasFileNameResults && (
            <Box borderBottom="1px solid" borderColor="border.glass" pb={1} mb={1}>
              <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.disabled} px={3} pt={2} pb={1}
                textTransform="uppercase" letterSpacing="0.05em">
                Files
              </Text>
              {fileNameMatches.map((fm) => (
                <Flex key={fm.file_path} align="center" px={3} py="5px" cursor="pointer"
                  _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                  onClick={() => onFileSelect?.(fm.file_path) || onResultClick({ id: fm.file_path, file: fm.file_path, line: 1, column: 1, text: '', match: '', context: '' })}
                >
                  <FiFile size={13} color={tokens.colors.accent.purple} style={{ flexShrink: 0 }} />
                  <Text fontSize="12px" color={tokens.colors.text.primary} ml={2} fontWeight="500"
                    whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                    {fm.file_name}
                  </Text>
                  <Text fontSize="11px" color={tokens.colors.text.disabled} ml={2}
                    whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis" flex={1}>
                    {fm.file_path.replace(fm.file_name, '').replace(/\/$/, '')}
                  </Text>
                </Flex>
              ))}
            </Box>
          )}

          {/* Content matches */}
          {hasContentResults && hasFileNameResults && (
            <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.disabled} px={3} pt={1} pb={1}
              textTransform="uppercase" letterSpacing="0.05em">
              Content
            </Text>
          )}

          {fileResults.map((fileResult) => (
            <Box key={fileResult.file}>
              <Flex align="center" px={3} py={2} cursor="pointer"
                _hover={{ bg: 'whiteAlpha.050' }} onClick={() => onToggleFileExpansion(fileResult.file)}>
                <IconButton aria-label={t("search.expand")} variant="ghost" size="xs"
                  color={tokens.colors.text.secondary} mr={1}>
                  {fileResult.isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                </IconButton>
                <FiFile size={14} color={tokens.colors.accent.primary} />
                <Text fontSize="sm" color={tokens.colors.text.primary} ml={2} flex="1"
                  whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                  {fileResult.file}
                </Text>
                <Box
                  fontSize="9px"
                  fontWeight="bold"
                  px="5px"
                  py="1px"
                  borderRadius="full"
                  bg={tokens.colors.accent.primarySubtle}
                  color={tokens.colors.accent.primary}
                  ml={2}
                  lineHeight="1.3"
                >
                  {fileResult.matches.length}
                </Box>
              </Flex>

              {fileResult.isExpanded && fileResult.matches.map((match) => (
                <Flex key={match.id} align="center" px={6} py={1} cursor="pointer"
                  _hover={{ bg: tokens.colors.bg.hoverSubtle, borderColor: tokens.colors.accent.primary }}
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

          {!hasContentResults && !hasFileNameResults && searchTerm && !isSearching && (
            <Flex align="center" justify="center" p={6} direction="column" color="text.muted">
              <FiSearch size={32} />
              <Text fontSize="sm" mt={2} textAlign="center">{t('search.noResultsFor').replace('{term}', searchTerm)}</Text>
            </Flex>
          )}

          {!searchTerm && (
            <Flex align="center" justify="center" p={6} direction="column" color="text.muted">
              <FiSearch size={32} />
              <Text fontSize="sm" mt={2} textAlign="center">{t("explorer.searchFiles")}</Text>
              <Text fontSize="xs" mt={1} color="text.muted">{t("explorer.enterSearchTerm")}</Text>
            </Flex>
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical"><ScrollArea.Thumb /></ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </Box>
  )
}

export default memo(SearchResultsList)
