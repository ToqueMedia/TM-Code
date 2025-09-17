import { memo, useState, useCallback } from 'react'
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
  Badge
} from '@chakra-ui/react'
import {
  FiSearch,
  FiMoreHorizontal,
  FiChevronDown,
  FiChevronRight,
  FiFile,
  FiX,
  FiType
} from 'react-icons/fi'

interface SearchResult {
  id: string
  file: string
  line: number
  column: number
  text: string
  match: string
  context: string
}

interface FileResult {
  file: string
  matches: SearchResult[]
  isExpanded: boolean
}

interface SearchPanelProps {
  onFileSelect?: (path: string) => void
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
  const [totalMatches, setTotalMatches] = useState(0)

  // Mock search results for demonstration
  const mockResults: FileResult[] = [
    {
      file: 'src/components/App.tsx',
      isExpanded: true,
      matches: [
        {
          id: '1',
          file: 'src/components/App.tsx',
          line: 12,
          column: 15,
          text: 'function App() {',
          match: 'App',
          context: 'function App() {'
        },
        {
          id: '2',
          file: 'src/components/App.tsx',
          line: 25,
          column: 8,
          text: 'export default App',
          match: 'App',
          context: 'export default App'
        }
      ]
    },
    {
      file: 'src/hooks/useApp.ts',
      isExpanded: false,
      matches: [
        {
          id: '3',
          file: 'src/hooks/useApp.ts',
          line: 5,
          column: 20,
          text: 'const useApp = () => {',
          match: 'App',
          context: 'const useApp = () => {'
        }
      ]
    }
  ]

  const handleSearch = useCallback(async () => {
    if (!searchTerm.trim()) return

    setIsSearching(true)
    
    // Simulate search delay
    setTimeout(() => {
      setFileResults(mockResults)
      setTotalMatches(mockResults.reduce((sum, file) => sum + file.matches.length, 0))
      setIsSearching(false)
    }, 500)
  }, [searchTerm])

  const toggleFileExpansion = useCallback((filePath: string) => {
    setFileResults(prev => 
      prev.map(file => 
        file.file === filePath 
          ? { ...file, isExpanded: !file.isExpanded }
          : file
      )
    )
  }, [])

  const handleResultClick = useCallback((result: SearchResult) => {
    if (onFileSelect) {
      onFileSelect(result.file)
    }
    console.log('Go to:', result.file, 'line:', result.line)
  }, [onFileSelect])

  const toggleReplace = useCallback(() => {
    setIsReplaceVisible(!isReplaceVisible)
  }, [isReplaceVisible])

  const handleReplace = useCallback(() => {
    console.log('Replace all:', searchTerm, 'with:', replaceTerm)
  }, [searchTerm, replaceTerm])

  const clearSearch = useCallback(() => {
    setSearchTerm('')
    setReplaceTerm('')
    setFileResults([])
    setTotalMatches(0)
  }, [])

  return (
    <VStack
      height="100%"
      bg="bg.sidebar"
      align="stretch"
      gap={0}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        p={3}
        borderBottom="1px solid"
        borderColor="border.glass"
      >
        <Text
          fontSize="xs"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="wide"
          color="text.secondary"
        >
          Search
        </Text>
        
        <HStack gap={1}>
          <IconButton
            aria-label="Toggle replace"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={toggleReplace}
            bg={isReplaceVisible ? 'whiteAlpha.100' : 'transparent'}
          >
            <FiSearch size={14} />
          </IconButton>
          <IconButton
            aria-label="Clear search"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={clearSearch}
          >
            <FiX size={14} />
          </IconButton>
          <IconButton
            aria-label="More options"
            variant="ghost"
            size="xs"
            color="text.secondary"
          >
            <FiMoreHorizontal size={14} />
          </IconButton>
        </HStack>
      </Flex>

      {/* Search Input */}
      <Box p={3} borderBottom="1px solid" borderColor="border.glass">
        <VStack gap={2} align="stretch">
          <Input
            placeholder="Search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
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
              >
                <FiSearch size={12} />
              </IconButton>
            </HStack>
            
            <Button
              size="xs"
              onClick={handleSearch}
              loading={isSearching}
              colorPalette="blue"
            >
              <FiSearch size={12} />
            </Button>
          </HStack>
        </VStack>
      </Box>

      {/* Search Results */}
      <Box flex="1">
        {totalMatches > 0 && (
          <Flex
            align="center"
            justify="space-between"
            p={3}
            bg="rgba(255, 255, 255, 0.02)"
            borderBottom="1px solid"
            borderColor="border.glass"
          >
            <Text fontSize="xs" color="text.muted">
              {totalMatches} results in {fileResults.length} files
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