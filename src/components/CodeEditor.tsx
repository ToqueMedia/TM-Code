import { Box, Flex, Text } from '@chakra-ui/react';
import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { FileTreeManager } from '../utils/fileTreeManager';

const fileTreeManager = FileTreeManager.getInstance();

export function CodeEditor() {
  const { currentProject, closeProject } = useProjectStore();

  // Initialize file tree when project changes
  useEffect(() => {
    if (!currentProject) return;

    fileTreeManager.initialize(currentProject.path).catch(console.error);

    return () => {
      fileTreeManager.destroy();
    };
  }, [currentProject]);

  // Save project state periodically
  useEffect(() => {
    if (!currentProject) return;

    const saveInterval = setInterval(() => {
      // In a real implementation, we would save the actual editor state
      console.log('Saving project state...');
    }, 5000); // Save every 5 seconds

    return () => clearInterval(saveInterval);
  }, [currentProject]);

  // Handle window close event
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Cancel the event to prompt the user
      e.preventDefault();
      e.returnValue = ''; // Required for Chrome
      return ''; // Required for other browsers
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  if (!currentProject) {
    return null;
  }

  return (
    <Flex 
      height="100vh" 
      bg="bg.editor"
      color="text.primary"
      direction="column"
    >
      {/* Top Bar */}
      <Flex
        height="35px"
        bgGradient="linear(135deg, #161b22 0%, #21262d 100%)"
        alignItems="center"
        padding="0 16px"
        borderBottom="1px solid"
        borderColor="glass.border"
      >
        <Text fontSize="13px" fontWeight="500" color="text.muted">
          {currentProject.name} - Diamond IDE
        </Text>
        <Flex gap="8px" marginLeft="auto">
          <Box 
            width="12px" 
            height="12px" 
            borderRadius="50%" 
            bg="#ff5f56" 
            cursor="pointer"
            onClick={closeProject}
          />
          <Box 
            width="12px" 
            height="12px" 
            borderRadius="50%" 
            bg="#ffbd2e" 
            cursor="pointer"
          />
          <Box 
            width="12px" 
            height="12px" 
            borderRadius="50%" 
            bg="#27ca3f" 
            cursor="pointer"
          />
        </Flex>
      </Flex>

      {/* Main Content */}
      <Flex flex="1" overflow="hidden">
        {/* Activity Bar */}
        <Flex
          width="60px"
          bg="bg.sidebar"
          direction="column"
          alignItems="center"
          padding="12px 0"
          borderRight="1px solid"
          borderColor="glass.border"
        >
          <Flex
            width="40px"
            height="40px"
            alignItems="center"
            justifyContent="center"
            marginBottom="8px"
            borderRadius="6px"
            cursor="pointer"
            color="primary.blue"
            bg="rgba(88, 166, 255, 0.1)"
          >
            📁
          </Flex>
          <Flex
            width="40px"
            height="40px"
            alignItems="center"
            justifyContent="center"
            marginBottom="8px"
            borderRadius="6px"
            cursor="pointer"
            color="text.muted"
            _hover={{ color: "primary.blue" }}
          >
            🔍
          </Flex>
          <Flex
            width="40px"
            height="40px"
            alignItems="center"
            justifyContent="center"
            marginBottom="8px"
            borderRadius="6px"
            cursor="pointer"
            color="text.muted"
            _hover={{ color: "primary.blue" }}
          >
            🔀
          </Flex>
          <Flex
            width="40px"
            height="40px"
            alignItems="center"
            justifyContent="center"
            marginBottom="8px"
            borderRadius="6px"
            cursor="pointer"
            color="text.muted"
            _hover={{ color: "primary.blue" }}
          >
            🐛
          </Flex>
          <Flex
            width="40px"
            height="40px"
            alignItems="center"
            justifyContent="center"
            borderRadius="6px"
            cursor="pointer"
            color="text.muted"
            _hover={{ color: "primary.blue" }}
          >
            📦
          </Flex>
        </Flex>

        {/* Sidebar */}
        <Flex
          width="280px"
          bg="bg.editor"
          borderRight="1px solid"
          borderColor="glass.border"
          direction="column"
        >
          <Box
            padding="8px 16px"
            fontSize="11px"
            fontWeight="600"
            textTransform="uppercase"
            color="text.muted"
            bg="bg.sidebar"
            borderBottom="1px solid"
            borderColor="glass.border"
          >
            Explorer
          </Box>
          <Box
            flex="1"
            padding="8px"
            overflowY="auto"
          >
            {/* TODO: Implement file tree */}
            <Text fontSize="13px" color="text.secondary">
              File tree will be implemented here
            </Text>
          </Box>
        </Flex>

        {/* Editor Area */}
        <Flex
          flex="1"
          bg="bg.editor"
          direction="column"
        >
          {/* Tab Bar */}
          <Flex
            minHeight="35px"
            bg="bg.sidebar"
            borderBottom="1px solid"
            borderColor="glass.border"
          >
            <Flex
              alignItems="center"
              padding="0 16px"
              borderRight="1px solid"
              borderColor="glass.border"
              bg="bg.editor"
              borderBottom="2px solid"
              minWidth="120px"
            >
              <Text fontSize="13px">README.md</Text>
              <Text 
                marginLeft="8px" 
                opacity="0.6" 
                cursor="pointer"
                _hover={{ opacity: 1 }}
              >
                ✕
              </Text>
            </Flex>
          </Flex>

          {/* Editor Content */}
          <Flex
            flex="1"
            padding="16px"
            fontFamily="mono"
            fontSize="14px"
            lineHeight="1.6"
            overflow="auto"
          >
            {/* TODO: Implement Monaco Editor */}
            <Text color="text.secondary">
              Monaco Editor will be implemented here
            </Text>
          </Flex>
        </Flex>
      </Flex>

      {/* Terminal */}
      <Flex
        height="200px"
        bg="#010409"
        borderTop="1px solid"
        borderColor="glass.border"
        direction="column"
      >
        <Flex
          alignItems="center"
          padding="8px 16px"
          bg="bg.sidebar"
          borderBottom="1px solid"
          borderColor="glass.border"
          fontSize="13px"
        >
          <Flex gap="1px">
            <Box
              padding="4px 12px"
              bg="rgba(1, 4, 9, 0.8)"
              borderRadius="4px 4px 0 0"
              color="primary.blue"
              cursor="pointer"
            >
              Terminal
            </Box>
            <Box
              padding="4px 12px"
              bg="bg.overlay"
              borderRadius="4px 4px 0 0"
              cursor="pointer"
              _hover={{ bg: "rgba(139, 148, 158, 0.1)" }}
            >
              Output
            </Box>
            <Box
              padding="4px 12px"
              bg="bg.overlay"
              borderRadius="4px 4px 0 0"
              cursor="pointer"
              _hover={{ bg: "rgba(139, 148, 158, 0.1)" }}
            >
              Debug Console
            </Box>
          </Flex>
        </Flex>
        <Box
          flex="1"
          padding="12px"
          fontFamily="mono"
          fontSize="13px"
          overflowY="auto"
        >
          <Text color="#58a6ff">
            Microsoft Windows [Version 10.0.19044.2728]
          </Text>
          <Text color="#7d8590">
            (c) Microsoft Corporation. All rights reserved.
          </Text>
          <Box height="8px" />
          <Text>
            <Text as="span" color="#7c3aed">C:\Users\dev&gt;</Text>
            <Text as="span" color="#58a6ff">npm start</Text>
          </Text>
          <Text color="#56d364">
            Starting development server...
          </Text>
        </Box>
      </Flex>
    </Flex>
  );
}