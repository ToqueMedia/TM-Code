import React from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import ExplorerPanel from './ui/ExplorerPanel'
import BottomPanel from './ui/BottomPanel'
import { useCurrentProject } from '../hooks/useProjectState'
import { useCodeEditorState } from '../hooks/useEditorState'

// Simplified version for debugging resizable panels
export function CodeEditorSimple() {
  const currentProject = useCurrentProject()
  const { handleFileSelect } = useCodeEditorState()

  if (!currentProject) {
    return (
      <Box height="100vh" display="flex" alignItems="center" justifyContent="center">
        <Text>No project loaded</Text>
      </Box>
    )
  }

  return (
    <Flex height="100vh" direction="column" bg="gray.900">
      {/* Simple Title Bar */}
      <Box
        height="35px"
        bg="gray.800"
        display="flex"
        alignItems="center"
        px={4}
        borderBottom="1px solid"
        borderColor="gray.700"
      >
        <Text color="white" fontSize="sm">
          {currentProject.name} - Debug Mode
        </Text>
      </Box>

      {/* Main Content Area */}
      <Flex flex="1">
        {/* Simple Activity Bar */}
        <Box
          width="48px"
          bg="gray.800"
          borderRight="1px solid"
          borderColor="gray.700"
        >
          {/* Placeholder for activity bar */}
        </Box>

        {/* Static Explorer Panel */}
        <Box
          width="300px"
          bg="gray.800"
          height="100%"
          borderRight="1px solid"
          borderColor="gray.700"
        >
          <ExplorerPanel onFileSelect={handleFileSelect} />
        </Box>

        {/* Editor Area */}
        <Flex flex="1" bg="gray.700" align="center" justify="center">
          <Text color="white" fontSize="lg">
            🎯 Editor Area - Test the left panel resize!
          </Text>
        </Flex>
      </Flex>

      {/* Static Bottom Panel */}
      <Box
        height="200px"
        bg="gray.800"
        borderTop="1px solid"
        borderColor="gray.700"
      >
        <BottomPanel
          isVisible={true}
          onToggle={() => {}}
          onClose={() => {}}
        />
      </Box>

      {/* Simple Status Bar */}
      <Box
        height="24px"
        bg="blue.600"
        color="white"
        fontSize="xs"
        display="flex"
        alignItems="center"
        px={2}
      >
        <Text>Status Bar - Debug Mode Active</Text>
      </Box>
    </Flex>
  )
}

export default CodeEditorSimple