import { memo, useState, useCallback, useEffect } from 'react'
import {
  VStack,
  HStack,
  Text,
  IconButton,
  Box,
  Input,
  Button,
  Flex,
  ScrollArea,
  Badge,
  Spinner
} from '@chakra-ui/react'
import {
  FiSearch,
  FiMoreHorizontal,
  FiChevronDown,
  FiChevronRight,
  FiFile,
  FiX,
  FiType,
  FiAlertCircle
} from 'react-icons/fi'
import { PanelHeader } from './PanelHeader'
import { OptionButton } from './OptionButton'
import SearchService, { SearchResult } from '../../services/searchService'
import { useProjectStore } from '../../stores/projectStore'

// Use types from SearchService instead
interface FileResult {
  file: string
  matches: any[]
  isExpanded: boolean
}

interface SearchPanelProps {
  onFileSelect?: (path: string, line?: number, column?: number) => void
}

function SearchPanel({ onFileSelect }: SearchPanelProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [replaceTerm, setReplaceTerm] = useState('')
  const [isReplaceVisible, setIsReplaceVisible] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [fileResults, setFileResults] = useState<FileResult[]>([])
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ripgrepAvailable, setRipgrepAvailable] = useState<boolean | null>(null)
  const [includePatterns, setIncludePatterns] = useState('')
  const [excludePatterns, setExcludePatterns] = useState('')
  
  // Get current project directory
  const currentProject = useProjectStore(state => state.currentProject)

  // Check ripgrep availability on component mount
  useEffect(() => {
    async function checkRipgrep() {
      try {
        const available = await SearchService.shared.checkRipgrepAvailable()
        setRipgrepAvailable(available)
        if (!available) {
          setError('ripgrep (rg) is not installed. Please install it for search functionality.')
        }
      } catch (err) {
        setRipgrepAvailable(false)
        setError('Failed to check ripgrep availability')
      }
    }
    checkRipgrep()
  }, [])

  const handleSearch = useCallback(async () => {
    if (!searchTerm.trim() || !currentProject?.path || !ripgrepAvailable) return

    setIsSearching(true)
    setError(null)
    
    try {
      const searchOptions = SearchService.shared.buildSearchOptions(
        caseSensitive,
        wholeWord,
        useRegex,
        includePatterns,
        excludePatterns
      )
      
      const result = await SearchService.shared.searchInFiles(
        searchTerm,
        currentProject.path,
        searchOptions
      )
      
      setSearchResult(result)
      
      // Convert to FileResult format for existing UI
      const convertedResults: FileResult[] = result.files.map(file => ({
        file: file.file_path,
        isExpanded: true,
        matches: file.matches.map(match => ({
          id: `${file.file_path}-${match.line_number}-${match.column}`,
          file: file.file_path,
          line: match.line_number,
          column: match.column,
          text: match.text,
          match: match.match_text,
          context: match.text
        }))
      }))
      
      setFileResults(convertedResults)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setSearchResult(null)
      setFileResults([])
    } finally {
      setIsSearching(false)
    }
  }, [searchTerm, currentProject?.path, caseSensitive, wholeWord, useRegex, includePatterns, excludePatterns, ripgrepAvailable])

  const toggleFileExpansion = useCallback((filePath: string) => {
    setFileResults(prev => 
      prev.map(file => 
        file.file === filePath 
          ? { ...file, isExpanded: !file.isExpanded }
          : file
      )
    )
  }, [])

  const handleResultClick = useCallback((result: any) => {
    if (onFileSelect) {
      onFileSelect(result.file, result.line, result.column)
    }
  }, [onFileSelect])

  const toggleReplace = useCallback(() => {
    setIsReplaceVisible(!isReplaceVisible)
  }, [isReplaceVisible])

  const handleReplace = useCallback(async () => {
    if (!replaceTerm.trim() || !currentProject?.path || !searchTerm.trim()) return
    
    try {
      const searchOptions = SearchService.shared.buildSearchOptions(
        caseSensitive,
        wholeWord,
        useRegex,
        includePatterns,
        excludePatterns
      )
      
      const affectedFiles = await SearchService.shared.replaceInFiles(
        searchTerm,
        replaceTerm,
        currentProject.path,
        searchOptions
      )
      
      // Re-run search to get updated results
      await handleSearch()
      
      console.log(`Replaced "${searchTerm}" with "${replaceTerm}" in ${affectedFiles} files`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replace failed')
    }
  }, [searchTerm, replaceTerm, currentProject?.path, caseSensitive, wholeWord, useRegex, includePatterns, excludePatterns, handleSearch])

  const clearSearch = useCallback(() => {
    SearchService.shared.cancelSearch()
    setSearchTerm('')
    setReplaceTerm('')
    setFileResults([])
    setSearchResult(null)
    setError(null)
  }, [])

  return (
    <VStack
      height="100%"
      bg="bg.sidebar"
      align="stretch"
      gap={0}
    >
      <PanelHeader 
        title="Search"
        rightControls={
          <>
            <OptionButton 
              label="Toggle replace"
              icon={FiSearch}
              isActive={isReplaceVisible}
              onClick={toggleReplace}
            />
            <OptionButton 
              label="Clear search"
              icon={FiX}
              onClick={clearSearch}
            />
            <OptionButton 
              label="More options"
              icon={FiMoreHorizontal}
              onClick={() => console.log('More options')}
            />
          </>
        }
      />

      {/* Search Input */}
      <Box p={3} borderBottom="1px solid" borderColor="border.glass">
        <VStack gap={2} align="stretch">
          <Input
            placeholder="Search"
            value={searchTerm}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            onChange={(e) => {
              setSearchTerm(e.target.value)
              // Debounced search while typing
              if (e.target.value.trim() && currentProject?.path) {
                const searchOptions = SearchService.shared.buildSearchOptions(
                  caseSensitive,
                  wholeWord,
                  useRegex,
                  includePatterns,
                  excludePatterns
                )
                SearchService.shared.debouncedSearch(
                  e.target.value.trim(),
                  currentProject.path,
                  searchOptions,
                  (result) => {
                    setSearchResult(result)
                    const convertedResults: FileResult[] = result.files.map(file => ({
                      file: file.file_path,
                      isExpanded: true,
                      matches: file.matches.map(match => ({
                        id: `${file.file_path}-${match.line_number}-${match.column}`,
                        file: file.file_path,
                        line: match.line_number,
                        column: match.column,
                        text: match.text,
                        match: match.match_text,
                        context: match.text
                      }))
                    }))
                    setFileResults(convertedResults)
                  }
                )
              }
            }}
            bg="transparent"
            border="1px solid"
            borderColor="border.glass"
            _focus={{
              borderColor: 'blue.500',
              boxShadow: '0 0 0 1px rgba(88, 166, 255, 0.6)'
            }}
            size="sm"
          />
          
          {isReplaceVisible && (
            <Input
              placeholder="Replace"
              value={replaceTerm}
              onChange={(e) => setReplaceTerm(e.target.value)}
              bg="transparent"
              border="1px solid"
              borderColor="border.glass"
              _focus={{
                borderColor: 'blue.500',
                boxShadow: '0 0 0 1px rgba(88, 166, 255, 0.6)'
              }}
              size="sm"
            />
          )}
          
          {/* Advanced Options */}
          <Input
            placeholder="Files to include (comma-separated, e.g., *.tsx,*.ts)"
            value={includePatterns}
            onChange={(e) => setIncludePatterns(e.target.value)}
            bg="transparent"
            border="1px solid"
            borderColor="border.glass"
            _focus={{
              borderColor: 'blue.500',
              boxShadow: '0 0 0 1px rgba(88, 166, 255, 0.6)'
            }}
            size="sm"
          />
          <Input
            placeholder="Files to exclude (comma-separated, e.g., *.min.js,node_modules/**)"
            value={excludePatterns}
            onChange={(e) => setExcludePatterns(e.target.value)}
            bg="transparent"
            border="1px solid"
            borderColor="border.glass"
            _focus={{
              borderColor: 'blue.500',
              boxShadow: '0 0 0 1px rgba(88, 166, 255, 0.6)'
            }}
            size="sm"
          />
          
          <HStack justify="space-between">
            <HStack gap={1}>
              <IconButton
                aria-label="Match case"
                variant="ghost"
                size="xs"
                color={caseSensitive ? 'blue.500' : 'text.secondary'}
                onClick={() => setCaseSensitive(!caseSensitive)}
              >
                <FiType size={12} />
              </IconButton>
              <IconButton
                aria-label="Whole word"
                variant="ghost"
                size="xs"
                color={wholeWord ? 'blue.500' : 'text.secondary'}
                onClick={() => setWholeWord(!wholeWord)}
              >
                <FiType size={12} />
              </IconButton>
              <IconButton
                aria-label="Use regex"
                variant="ghost"
                size="xs"
                color={useRegex ? 'blue.500' : 'text.secondary'}
                onClick={() => setUseRegex(!useRegex)}
                title="Use regular expressions"
              >
                <FiSearch size={12} />
              </IconButton>
            </HStack>
            
            <Button
              size="xs"
              onClick={handleSearch}
              disabled={isSearching || !ripgrepAvailable || !currentProject}
              colorPalette="blue"
            >
              {isSearching ? <Spinner size="xs" /> : <FiSearch size={12} />}
            </Button>
          </HStack>
        </VStack>
      </Box>

      {/* Error Display */}
      {error && (
        <Box
          bg="red.900"
          color="red.100"
          p={3}
          borderRadius="md"
          mx={3}
          mb={2}
        >
          <HStack>
            <FiAlertCircle size={16} />
            <Text fontSize="sm">{error}</Text>
          </HStack>
        </Box>
      )}
      
      {/* Search Results */}
      <Box flex="1">
        {searchResult && searchResult.total_matches > 0 && (
          <Flex
            align="center"
            justify="space-between"
            p={3}
            bg="rgba(255, 255, 255, 0.02)"
            borderBottom="1px solid"
            borderColor="border.glass"
          >
            <Text fontSize="xs" color="text.muted">
              {searchResult.total_matches} results in {searchResult.total_files} files
              {searchResult.truncated && ' (truncated)'}
              {searchResult.duration_ms && ` - ${searchResult.duration_ms}ms`}
            </Text>
            {isReplaceVisible && (
              <Button
                size="xs"
                variant="outline"
                onClick={handleReplace}
                disabled={!replaceTerm.trim()}
              >
                Replace All
              </Button>
            )}
          </Flex>
        )}
        
        <ScrollArea.Root flex="1">
          <ScrollArea.Viewport>
            {fileResults.map((fileResult) => (
              <Box key={fileResult.file}>
                {/* File Header */}
                <Flex
                  align="center"
                  px={3}
                  py={2}
                  cursor="pointer"
                  _hover={{ bg: 'whiteAlpha.050' }}
                  onClick={() => toggleFileExpansion(fileResult.file)}
                >
                  <IconButton
                    aria-label="Expand"
                    variant="ghost"
                    size="xs"
                    color="text.secondary"
                    mr={1}
                  >
                    {fileResult.isExpanded ? (
                      <FiChevronDown size={12} />
                    ) : (
                      <FiChevronRight size={12} />
                    )}
                  </IconButton>
                  
                  <FiFile size={14} color="#58a6ff" />
                  <Text
                    fontSize="sm"
                    color="text.primary"
                    ml={2}
                    flex="1"
                    whiteSpace="nowrap"
                    overflow="hidden"
                    textOverflow="ellipsis"
                  >
                    {fileResult.file}
                  </Text>
                  
                  <Badge size="sm" colorPalette="blue" ml={2}>
                    {fileResult.matches.length}
                  </Badge>
                </Flex>
                
                {/* Match Results */}
                {fileResult.isExpanded && fileResult.matches.map((match) => (
                  <Flex
                    key={match.id}
                    align="center"
                    px={6}
                    py={1}
                    cursor="pointer"
                    _hover={{ bg: 'whiteAlpha.050', borderColor: 'blue.500' }}
                    onClick={() => handleResultClick(match)}
                    borderLeft="2px solid transparent"
                  >
                    <Text
                      fontSize="xs"
                      color="text.muted"
                      minW="40px"
                      mr={3}
                    >
                      {match.line}
                    </Text>
                    
                    <Text
                      fontSize="xs"
                      color="text.primary"
                      fontFamily="mono"
                      flex="1"
                      whiteSpace="nowrap"
                      overflow="hidden"
                      textOverflow="ellipsis"
                    >
                      {match.context}
                    </Text>
                  </Flex>
                ))}
              </Box>
            ))}
            
            {fileResults.length === 0 && searchTerm && !isSearching && (
              <Flex
                align="center"
                justify="center"
                p={6}
                direction="column"
                color="text.muted"
              >
                <FiSearch size={32} />
                <Text fontSize="sm" mt={2} textAlign="center">
                  No results found for "{searchTerm}"
                </Text>
              </Flex>
            )}
            
            {!searchTerm && (
              <Flex
                align="center"
                justify="center"
                p={6}
                direction="column"
                color="text.muted"
              >
                <FiSearch size={32} />
                <Text fontSize="sm" mt={2} textAlign="center">
                  Search across all files in the workspace
                </Text>
                <Text fontSize="xs" mt={1} color="text.muted">
                  Enter a search term to get started
                </Text>
              </Flex>
            )}
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical">
            <ScrollArea.Thumb />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      </Box>
    </VStack>
  )
}

export default memo(SearchPanel)