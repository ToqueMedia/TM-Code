import React, { memo, Suspense, useCallback } from 'react'
import {
  VStack,
  HStack,
  Text,
  Box,
  ScrollArea,
  Spinner} from '@chakra-ui/react'
import {
  FiFolder,
  FiRefreshCw,
  FiPlus,
  FiMoreHorizontal,
  FiSearch} from 'react-icons/fi'
import { useCurrentProject } from '../../hooks/useProjectState'
import { PanelHeader } from './PanelHeader'
import { SearchInput } from './SearchInput'
import { OptionButton } from './OptionButton'

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

  const handleMoreActions = useCallback(() => {
    // Handle more actions
    console.log('More actions')
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
      bg="#252526"
      align="stretch"
      gap={0}
    >
      <PanelHeader 
        title="Explorer"
        rightControls={
          <>
            <OptionButton 
              label="Search in files"
              icon={FiSearch}
              isActive={isSearching}
              onClick={handleSearchToggle}
            />
            <OptionButton 
              label="Refresh Explorer"
              icon={FiRefreshCw}
              onClick={handleRefresh}
            />
            <OptionButton 
              label="New File"
              icon={FiPlus}
              onClick={handleNewFile}
            />
            <OptionButton 
              label="More actions"
              icon={FiMoreHorizontal}
              onClick={handleMoreActions}
            />
          </>
        }
      />
      
      {/* Search Input */}
      {isSearching && (
        <Box p={2} borderBottom="1px solid" borderColor="border.glass">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            onClear={() => setSearchTerm('')}
            placeholder="Search files..."
            compact
          />
        </Box>
      )}

      {/* File Tree */}
      <ScrollArea.Root flex="1">
        <ScrollArea.Viewport>
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
        borderColor="#444"
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