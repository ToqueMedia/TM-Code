import React, { memo, Suspense } from 'react'
import {
  VStack,
  HStack,
  Text,
  Box,
  ScrollArea,
  Spinner} from '@chakra-ui/react'
import { FiFolder } from 'react-icons/fi'
import { useCurrentProject } from '../../hooks/useProjectState'
import { PanelHeader } from './PanelHeader'
import { useFileTreeRepository } from '../../stores/fileTreeStore'

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
  useFileTreeRepository()

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
      />
      

      {/* File Tree */}
      <ScrollArea.Root flex="1">
        <ScrollArea.Viewport className="explorer-viewport">
          <Suspense fallback={<FileTreeSkeleton />}>
            <FileTree 
              rootPath={currentProject.path}
              onFileSelect={onFileSelect}
            />
          </Suspense>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          position="absolute"
          orientation="vertical"
          right="2px"
          top="2px"
          bottom="2px"
          width="8px"
          borderRadius="4px"
          bg="transparent"
          _hover={{ bg: 'rgba(128, 128, 128, 0.2)' }}
          _active={{ bg: 'rgba(128, 128, 128, 0.4)' }}
          transition="background 0.2s"
          zIndex={1}
        >
          <ScrollArea.Thumb 
            bg="rgba(128, 128, 128, 0.4)"
            borderRadius="4px"
            minH="20px"
            _hover={{ bg: 'rgba(128, 128, 128, 0.6)' }}
            _active={{ bg: 'rgba(128, 128, 128, 0.8)' }}
            transition="background 0.2s"
          />
        </ScrollArea.Scrollbar>
        <ScrollArea.Scrollbar
          position="absolute"
          orientation="horizontal"
          bottom="2px"
          left="2px"
          right="2px"
          height="8px"
          borderRadius="4px"
          bg="transparent"
          _hover={{ bg: 'rgba(128, 128, 128, 0.2)' }}
          _active={{ bg: 'rgba(128, 128, 128, 0.4)' }}
          transition="background 0.2s"
          zIndex={1}
        >
          <ScrollArea.Thumb 
            bg="rgba(128, 128, 128, 0.4)"
            borderRadius="4px"
            minW="20px"
            _hover={{ bg: 'rgba(128, 128, 128, 0.6)' }}
            _active={{ bg: 'rgba(128, 128, 128, 0.8)' }}
            transition="background 0.2s"
          />
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