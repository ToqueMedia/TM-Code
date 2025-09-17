import { useState, useEffect, useCallback } from 'react'
import { 
  Box, 
  Input, 
  Button, 
  Text, 
  Spinner,
  Stack,
  Badge,
  HStack,
  VStack,
  Separator,
  IconButton,
  Heading
} from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useFileTreeWorkerStore } from '../../stores/fileTreeWorkerStore'
import type { FileTreeFilter } from '../../types/fileTree'

interface FileTreeWorkerPanelProps {
  isVisible: boolean
  onClose?: () => void
}

export default function FileTreeWorkerPanel({ isVisible, onClose }: FileTreeWorkerPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [filterOptions, setFilterOptions] = useState<FileTreeFilter>({
    showHidden: true,
    extensions: [],
    maxDepth: -1
  })

  // Zustand stores
  const isProcessingInBackground = useFileTreeRepository(state => state.isProcessingInBackground)
  const searchResults = useFileTreeRepository(state => state.searchResults)
  const processingStats = useFileTreeRepository(state => state.processingStats)
  const root = useFileTreeRepository(state => state.root)
  const initWorker = useFileTreeRepository(state => state.initWorker)
  const processTreeInBackground = useFileTreeRepository(state => state.processTreeInBackground)
  const searchInTree = useFileTreeRepository(state => state.searchInTree)
  const filterTreeInBackground = useFileTreeRepository(state => state.filterTreeInBackground)
  const clearSearch = useFileTreeRepository(state => state.clearSearch)

  // Worker store
  const workerError = useFileTreeWorkerStore(state => state.error)
  const isWorkerLoading = useFileTreeWorkerStore(state => state.isLoading)

  // Inicializa worker quando o componente monta
  useEffect(() => {
    initWorker()
  }, [initWorker])

  // Função para processar árvore em background
  const handleProcessTree = useCallback(async () => {
    try {
      await processTreeInBackground({
        sort: true,
        createIndex: true
      })
    } catch (error) {
      console.error('Failed to process tree in background:', error)
    }
  }, [processTreeInBackground])

  // Função para busca
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      clearSearch()
      return
    }
    
    try {
      await searchInTree(searchQuery)
    } catch (error) {
      console.error('Failed to search in tree:', error)
    }
  }, [searchQuery, searchInTree, clearSearch])

  // Função para filtrar
  const handleFilter = useCallback(async () => {
    try {
      await filterTreeInBackground(filterOptions)
    } catch (error) {
      console.error('Failed to filter tree:', error)
    }
  }, [filterOptions, filterTreeInBackground])

  // Limpa busca quando query fica vazia
  useEffect(() => {
    if (!searchQuery.trim()) {
      clearSearch()
    }
  }, [searchQuery, clearSearch])

  if (!isVisible) return null

  return (
    <Box
      position="fixed"
      top="0"
      right="0"
      width="400px"
      height="100vh"
      bg="gray.900"
      borderLeft="1px solid"
      borderColor="gray.700"
      zIndex="1000"
      p={4}
      overflowY="auto"
    >
      <VStack
        gap={4}
        align="stretch"
      >
        {/* Header */}
        <HStack
          justify="space-between"
          align="center"
        >
          <Heading 
            size="md"
            color="white"
          >
            FileTree Worker
          </Heading>
          
          {onClose && (
            <IconButton
              aria-label="Close panel"
              size="sm"
              variant="ghost"
              onClick={onClose}
            >
              <FiX size={16} />
            </IconButton>
          )}
        </HStack>

        {/* Status */}
        <Box>
          <HStack
            gap={2}
          >
            <Badge 
              colorPalette={isProcessingInBackground || isWorkerLoading ? 'yellow' : 'green'}
              variant="solid"
            >
              {isProcessingInBackground || isWorkerLoading ? 'Processing...' : 'Ready'}
            </Badge>
            
            {(isProcessingInBackground || isWorkerLoading) && (
              <Spinner 
                size="sm" 
                color="yellow.500"
              />
            )}
          </HStack>

          {/* Processing Stats */}
          {processingStats && (
            <Text 
              fontSize="xs" 
              color="gray.400"
              mt={1}
            >
              Last processing: {processingStats.lastProcessingTime?.toFixed(2)}ms 
              ({processingStats.nodeCount} nodes)
            </Text>
          )}

          {/* Error Display */}
          {workerError && (
            <Text 
              fontSize="sm" 
              color="red.400"
              mt={2}
              p={2}
              bg="red.900"
              borderRadius="md"
            >
              Error: {workerError.message}
            </Text>
          )}
        </Box>

        <Separator />

        {/* Process Tree Controls */}
        <VStack
          align="stretch"
          gap={2}
        >
          <Text 
            fontSize="sm" 
            fontWeight="semibold"
            color="white"
          >
            Tree Processing
          </Text>
          
          <Button
            size="sm"
            colorPalette="blue"
            onClick={handleProcessTree}
            loading={isProcessingInBackground}
            disabled={!root || isProcessingInBackground}
          >
            Process Tree in Background
          </Button>
          
          <Text 
            fontSize="xs" 
            color="gray.400"
          >
            Sorts and indexes the file tree using Web Worker
          </Text>
        </VStack>

        <Separator />

        {/* Search Controls */}
        <VStack
          align="stretch"
          gap={2}
        >
          <Text 
            fontSize="sm" 
            fontWeight="semibold"
            color="white"
          >
            Search Files
          </Text>
          
          <HStack>
            <Input
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSearch()
                }
              }}
              bg="gray.800"
              border="1px solid"
              borderColor="gray.600"
              color="white"
              fontSize="sm"
              _placeholder={{ color: 'gray.400' }}
            />
            
            <Button
              size="sm"
              colorPalette="green"
              onClick={handleSearch}
              loading={isProcessingInBackground}
              disabled={!root || !searchQuery.trim()}
            >
              Search
            </Button>
          </HStack>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <Box
              maxHeight="200px"
              overflowY="auto"
              bg="gray.800"
              borderRadius="md"
              p={2}
            >
              <Text 
                fontSize="xs" 
                color="gray.400"
                mb={2}
              >
                Found {searchResults.length} results:
              </Text>
              
              {searchResults.map((result, index) => (
                <Box
                  key={index}
                  p={1}
                  fontSize="xs"
                  color="white"
                  _hover={{ bg: 'gray.700' }}
                  borderRadius="sm"
                  cursor="pointer"
                >
                  <Text fontWeight="medium">{result.name}</Text>
                  <Text 
                    color="gray.400" 
                    fontSize="2xs"
                  >
                    {result.path}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          
          {searchQuery && searchResults.length === 0 && !isProcessingInBackground && (
            <Text 
              fontSize="xs" 
              color="gray.400"
            >
              No results found for "{searchQuery}"
            </Text>
          )}
        </VStack>

        <Separator />

        {/* Filter Controls */}
        <VStack
          align="stretch"
          gap={2}
        >
          <Text 
            fontSize="sm" 
            fontWeight="semibold"
            color="white"
          >
            Filter Options
          </Text>
          
          <Stack
            gap={2}
          >
            <HStack
              justify="space-between"
            >
              <Text 
                fontSize="xs" 
                color="gray.300"
              >
                Show Hidden Files
              </Text>
              <input
                type="checkbox"
                checked={filterOptions.showHidden}
                onChange={(e) => setFilterOptions(prev => ({
                  ...prev,
                  showHidden: e.target.checked
                }))}
              />
            </HStack>

            <VStack
              align="stretch"
              gap={1}
            >
              <Text 
                fontSize="xs" 
                color="gray.300"
              >
                Max Depth (-1 = unlimited)
              </Text>
              <Input
                type="number"
                value={filterOptions.maxDepth}
                onChange={(e) => setFilterOptions(prev => ({
                  ...prev,
                  maxDepth: parseInt(e.target.value) || -1
                }))}
                bg="gray.800"
                border="1px solid"
                borderColor="gray.600"
                color="white"
                fontSize="xs"
                size="sm"
              />
            </VStack>

            <VStack
              align="stretch"
              gap={1}
            >
              <Text 
                fontSize="xs" 
                color="gray.300"
              >
                File Extensions (comma-separated)
              </Text>
              <Input
                placeholder="js,ts,tsx,jsx"
                value={filterOptions.extensions?.join(',')}
                onChange={(e) => setFilterOptions(prev => ({
                  ...prev,
                  extensions: e.target.value.split(',').map(ext => ext.trim()).filter(Boolean)
                }))}
                bg="gray.800"
                border="1px solid"
                borderColor="gray.600"
                color="white"
                fontSize="xs"
                size="sm"
                _placeholder={{ color: 'gray.400' }}
              />
            </VStack>
          </Stack>

          <Button
            size="sm"
            colorPalette="purple"
            onClick={handleFilter}
            loading={isProcessingInBackground}
            disabled={!root || isProcessingInBackground}
          >
            Apply Filter
          </Button>
        </VStack>
      </VStack>
    </Box>
  )
}