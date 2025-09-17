import React, { memo, Suspense, useCallback } from 'react'
import {
  VStack,
  HStack,
  Text,
  IconButton,
  Box,
  Flex,
  ScrollArea,
  Spinner,
  Input
} from '@chakra-ui/react'
import {
  FiFolder,
  FiRefreshCw,
  FiPlus,
  FiMoreHorizontal,
  FiSearch,
  FiX
} from 'react-icons/fi'
import { useCurrentProject } from '../../hooks/useProjectState'

const FileTree = React.lazy(() => import('./FileTree'))

interface ExplorerPanelProps {
  onFileSelect: (path: string) => void
}

const FileTreeSkeleton = memo(() => (
  <Box p={4}>
    <HStack mb={2}>
      <Spinner size="sm" />
      <Text fontSize="sm" color="text.muted">Loading project files...</Text>
    </HStack>
  </Box>
))

FileTreeSkeleton.displayName = 'FileTreeSkeleton'

function ExplorerPanel({ onFileSelect }: ExplorerPanelProps) {
  const currentProject = useCurrentProject()
  const [searchTerm, setSearchTerm] = React.useState('')
  const [isSearching, setIsSearching] = React.useState(false)

  const handleSearchToggle = useCallback(() => {
    setIsSearching(!isSearching)
    if (isSearching) {
      setSearchTerm('')
    }
  }, [isSearching])

  const handleRefresh = useCallback(() => {
    // Trigger file tree refresh
    window.location.reload()
  }, [])

  const handleNewFile = useCallback(() => {
    // Open new file dialog
    console.log('New file')
  }, [])


  if (!currentProject) {
    return (
      <VStack
        height="100%"
        justify="center"
        align="center"
        p={6}
        color="text.muted"
      >
        <FiFolder size={48} />
        <Text fontSize="sm" textAlign="center">
          No folder opened
        </Text>
        <Text fontSize="xs" textAlign="center" mt={2}>
          Open a folder to start exploring
        </Text>
      </VStack>
    )
  }

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
          Explorer
        </Text>
        
        <HStack gap={1}>
          <IconButton
            aria-label="Search in files"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={handleSearchToggle}
            bg={isSearching ? 'whiteAlpha.100' : 'transparent'}
          >
            <FiSearch size={14} />
          </IconButton>
          <IconButton
            aria-label="Refresh Explorer"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={handleRefresh}
          >
            <FiRefreshCw size={14} />
          </IconButton>
          <IconButton
            aria-label="New File"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={handleNewFile}
          >
            <FiPlus size={14} />
          </IconButton>
          <IconButton
            aria-label="More actions"
            variant="ghost"
            size="xs"
            color="text.secondary"
          >
            <FiMoreHorizontal size={14} />
          </IconButton>
        </HStack>
      </Flex>

      {/* Search Input */}
      {isSearching && (
        <Box p={2} borderBottom="1px solid" borderColor="border.glass">
          <HStack>
            <Input
              placeholder="Search files..."
              size="sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              bg="transparent"
              border="1px solid"
              borderColor="border.glass"
              _focus={{
                borderColor: 'blue.500',
                boxShadow: '0 0 0 1px rgba(88, 166, 255, 0.6)'
              }}
            />
            <IconButton
              aria-label="Clear search"
              variant="ghost"
              size="xs"
              color="text.secondary"
              onClick={() => setSearchTerm('')}
            >
              <FiX size={12} />
            </IconButton>
          </HStack>
        </Box>
      )}

      {/* File Tree */}
      <ScrollArea.Root flex="1">
        <ScrollArea.Viewport px={1} py={1}>
          <Suspense fallback={<FileTreeSkeleton />}>
            <FileTree 
              rootPath={currentProject.path}
              onFileSelect={onFileSelect}
            />
          </Suspense>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical">
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      {/* Footer Info */}
      <Box
        px={3}
        py={2}
        borderTop="1px solid"
        borderColor="border.glass"
        bg="rgba(255, 255, 255, 0.02)"
      >
        <Text
          fontSize="xs"
          color="text.muted"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
        >
          {currentProject.path}
        </Text>
      </Box>
    </VStack>
  )
}

export default memo(ExplorerPanel)