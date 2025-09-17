import React, { useEffect } from 'react'
import {
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  Text,
  useDialog,
  Dialog,
  Portal,
  Input,
  NativeSelect,
  VStack,
  HStack,
  Icon,
} from '@chakra-ui/react'
import { useProjectStore } from '../stores/projectStore'

interface WelcomeScreenProps {
  onOpenProject: (path?: string) => void
  onCreateProject: (projectData: any) => void
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject, onCreateProject: _onCreateProject }) => {
  const newProjectDialog = useDialog()
  const cloneDialog = useDialog()
  const { recentProjects, loadRecentProjects } = useProjectStore()
  
  // Load recent projects when component mounts
  useEffect(() => {
    loadRecentProjects()
  }, [loadRecentProjects])

  const handleCreateProject = () => {
    // In a real implementation, this would gather form data and call onCreateProject
    newProjectDialog.setOpen(false)
  }

  const handleOpenFolder = async () => {
    try {
      // Import and use the Tauri dialog plugin
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select project directory'
      });
      if (selected) {
        // Directly open the selected project
        onOpenProject(selected as string);
      }
    } catch (error: unknown) {
      console.error('Failed to open directory dialog:', error);
    }
  };

  /* const handleOpenFolder = async () => {
    try {
      // Debug logging
      console.log('handleOpenFolder called');
      // @ts-ignore
      console.log('Tauri context:', typeof window !== 'undefined' && window.__TAURI__ ? 'Yes' : 'No');
      
      // Check if we're in a Tauri context
      // @ts-ignore
      const isTauri = typeof window !== 'undefined' && window.__TAURI__;
      if (!isTauri) {
        console.log('Not in Tauri context, showing appropriate message');
        // Show a more informative message
        const result = confirm(
          'Directory selection is only available in the desktop app.\n\n' +
          'You can:\n' +
          '1. Download and install the desktop app\n' +
          '2. Enter a project path manually\n\n' +
          'Would you like to enter a project path manually?'
        );
        
        if (result) {
          const path = prompt('Enter the full path to your project:');
          if (path) {
            onOpenProject(path);
          }
        }
        return;
      }
      
      console.log('Calling openDirectoryDialog...');
      const selectedPath = await openDirectoryDialog();
      console.log('openDirectoryDialog returned:', selectedPath);
      
      if (selectedPath) {
        console.log('Selected path:', selectedPath);
        // Open the selected project directly
        onOpenProject(selectedPath);
      }
    } catch (error: unknown) {
      console.error('Failed to open directory dialog:', error);
      // In a real implementation, you might want to show an error message to the user
      if (error instanceof Error) {
        console.error('Error message:', error.message);
        alert(error.message || 'Failed to open directory dialog. Please try again.');
      } else {
        console.error('Unknown error:', error);
        alert('Failed to open directory dialog. Please try again.');
      }
    }
  } */

    const handleCloneProject = () => {
    // In a real implementation, this would gather form data and clone the repository
    cloneDialog.setOpen(false)
  }

  const templates = [
    { label: 'React TypeScript', value: 'react-ts' },
    { label: 'Node.js Express', value: 'node-express' },
    { label: 'Python FastAPI', value: 'python-fastapi' },
    { label: 'Vue.js', value: 'vue' },
    { label: 'Rust', value: 'rust' },
    { label: 'Empty Project', value: 'empty' },
  ]

  return (
    <Flex 
      minHeight="100vh" 
      bg="#0a0e13"
      color="#e6edf3"
    >
      {/* Animated Background */}
      <Box 
        position="fixed" 
        top="0" 
        left="0" 
        width="100%" 
        height="100%" 
        zIndex="-1"
        bgGradient="radial(ellipse at top, rgba(88, 166, 255, 0.05) 0%, transparent 50%), radial(ellipse at bottom, rgba(163, 108, 255, 0.03) 0%, transparent 50%)"
      />
      
      {/* Sidebar */}
      <Box
        width={{ base: '100%', md: '320px' }}
        bg="rgba(13, 17, 23, 0.8)"
        backdropFilter="blur(20px)"
        borderRight="1px solid rgba(48, 54, 61, 0.5)"
        display="flex"
        flexDirection="column"
        p={6}
      >
        <Flex alignItems="center" mb={8}>
          <Box
            width="48px"
            height="48px"
            bgGradient="linear(135deg, #58a6ff 0%, #a371f7 100%)"
            borderRadius="12px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            fontSize="24px"
            mr={3}
            boxShadow="0 8px 32px rgba(88, 166, 255, 0.3)"
          >
            💎
          </Box>
          <Heading 
            fontSize="24px" 
            fontWeight="700"
            bgGradient="linear(135deg, #58a6ff 0%, #a371f7 100%)"
            bgClip="text"
          >
            Diamond
          </Heading>
        </Flex>

        <VStack align="stretch" flex="1">
          <Text 
            fontSize="12px" 
            fontWeight="600" 
            textTransform="uppercase" 
            color="#7d8590" 
            mb={4}
            letterSpacing="0.5px"
          >
            Start
          </Text>
          
          <Button
            variant="ghost"
            justifyContent="flex-start"
            p={4}
            borderRadius="8px"
            mb={1}
            border="1px solid transparent"
            _hover={{
              bg: 'rgba(88, 166, 255, 0.1)',
              borderColor: 'rgba(88, 166, 255, 0.3)',
              transform: 'translateX(4px)',
            }}
            onClick={() => newProjectDialog.setOpen(true)}
          >
            <Icon as={() => <span>📄</span>} mr={3} fontSize="18px" width="20px" />
            New Project
          </Button>
          
          <Button
            variant="ghost"
            justifyContent="flex-start"
            p={4}
            borderRadius="8px"
            mb={1}
            border="1px solid transparent"
            _hover={{
              bg: 'rgba(88, 166, 255, 0.1)',
              borderColor: 'rgba(88, 166, 255, 0.3)',
              transform: 'translateX(4px)',
            }}
            onClick={handleOpenFolder}
          >
            <Icon as={() => <span>📁</span>} mr={3} fontSize="18px" width="20px" />
            Open Folder
          </Button>
          
          <Button
            variant="ghost"
            justifyContent="flex-start"
            p={4}
            borderRadius="8px"
            mb={1}
            border="1px solid transparent"
            _hover={{
              bg: 'rgba(88, 166, 255, 0.1)',
              borderColor: 'rgba(88, 166, 255, 0.3)',
              transform: 'translateX(4px)',
            }}
            onClick={() => cloneDialog.setOpen(true)}
          >
            <Icon as={() => <span>🔗</span>} mr={3} fontSize="18px" width="20px" />
            Clone Repository
          </Button>
          
          <Button
            variant="ghost"
            justifyContent="flex-start"
            p={4}
            borderRadius="8px"
            mb={1}
            border="1px solid transparent"
            _hover={{
              bg: 'rgba(88, 166, 255, 0.1)',
              borderColor: 'rgba(88, 166, 255, 0.3)',
              transform: 'translateX(4px)',
            }}
          >
            <Icon as={() => <span>📦</span>} mr={3} fontSize="18px" width="20px" />
            Import Project
          </Button>
        </VStack>

        <VStack align="stretch" mt={6}>
          <Text 
            fontSize="12px" 
            fontWeight="600" 
            textTransform="uppercase" 
            color="#7d8590" 
            mb={4}
            letterSpacing="0.5px"
          >
            Recent
          </Text>
          
          {recentProjects.map((project, index) => (
            <Box
              key={project.id || index}
              p={2}
              borderRadius="6px"
              cursor="pointer"
              _hover={{
                bg: 'rgba(139, 148, 158, 0.1)',
              }}
              onClick={() => {
                // Open the selected project directly without dialog
                if (project.path) {
                  onOpenProject(project.path)
                }
              }}
            >
              <HStack>
                <Icon as={() => <span>📁</span>} mr={2} fontSize="14px" color="#7d8590" />
                <VStack gap={0} alignItems="flex-start">
                  <Text fontSize="13px" color="#c9d1d9">{project.name}</Text>
                  <Text fontSize="11px" color="#7d8590">{project.path}</Text>
                </VStack>
              </HStack>
            </Box>
          ))}
        </VStack>
      </Box>

      {/* Main Content */}
      <Flex 
        flex={1} 
        flexDirection="column" 
        alignItems="center" 
        justifyContent="center" 
        p={12}
        position="relative"
      >
        <VStack textAlign="center" mb={12}>
          <Heading 
            fontSize={{ base: "32px", md: "48px" }} 
            fontWeight="800"
            bgGradient="linear(135deg, #e6edf3 0%, #58a6ff 50%, #a371f7 100%)"
            bgClip="text"
            letterSpacing="-0.5px"
            mb={4}
          >
            Welcome to Diamond
          </Heading>
          <Text 
            fontSize="18px" 
            color="#8b949e" 
            maxW="500px" 
            lineHeight="1.5"
          >
            The ultimate development environment designed for modern developers. 
            Start building something amazing today.
          </Text>
        </VStack>

        <Grid 
          templateColumns={{ base: "1fr", md: "repeat(auto-fit, minmax(280px, 1fr))" }} 
          gap={6}
          maxW="900px"
          w="100%"
        >
                    <Box
            bg="rgba(21, 32, 43, 0.6)"
            backdropFilter="blur(20px)"
            border="1px solid rgba(48, 54, 61, 0.8)"
            borderRadius="16px"
            p={6}
            cursor="pointer"
            position="relative"
            overflow="hidden"
            _hover={{
              transform: 'translateY(-8px)',
              borderColor: 'rgba(88, 166, 255, 0.6)',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(88, 166, 255, 0.1)',
            }}
            transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
            onClick={handleOpenFolder}
          >
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              height="2px"
              bgGradient="linear(90deg, transparent, rgba(88, 166, 255, 0.5), transparent)"
              transform="translateX(-100%)"
              transition="transform 0.6s ease"
              _groupHover={{
                transform: 'translateX(100%)',
              }}
            />
            <Flex
              width="64px"
              height="64px"
              borderRadius="12px"
              alignItems="center"
              justifyContent="center"
              fontSize="28px"
              mb={5}
              bgGradient="linear(135deg, #56d364 0%, #2ea043 100%)"
              boxShadow="0 8px 24px rgba(86, 211, 100, 0.3)"
            >
              🚀
            </Flex>
            <Heading fontSize="20px" fontWeight="600" mb={2} color="#e6edf3">
              New Project
            </Heading>
            <Text fontSize="14px" color="#8b949e" lineHeight="1.5" mb={4}>
              Create a new project from scratch with templates and boilerplates.
            </Text>
            <Text fontSize="12px" color="#7d8590" bg="rgba(110, 118, 129, 0.1)" p={1} borderRadius="4px" display="inline-block">
              Ctrl+Shift+N
            </Text>
          </Box>

          <Box
            bg="rgba(21, 32, 43, 0.6)"
            backdropFilter="blur(20px)"
            border="1px solid rgba(48, 54, 61, 0.8)"
            borderRadius="16px"
            p={6}
            cursor="pointer"
            position="relative"
            overflow="hidden"
            _hover={{
              transform: 'translateY(-8px)',
              borderColor: 'rgba(88, 166, 255, 0.6)',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(88, 166, 255, 0.1)',
            }}
            transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
            onClick={handleOpenFolder}
          >
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              height="2px"
              bgGradient="linear(90deg, transparent, rgba(88, 166, 255, 0.5), transparent)"
              transform="translateX(-100%)"
              transition="transform 0.6s ease"
              _groupHover={{
                transform: 'translateX(100%)',
              }}
            />
            <Flex
              width="64px"
              height="64px"
              borderRadius="12px"
              alignItems="center"
              justifyContent="center"
              fontSize="28px"
              mb={5}
              bgGradient="linear(135deg, #58a6ff 0%, #0969da 100%)"
              boxShadow="0 8px 24px rgba(88, 166, 255, 0.3)"
            >
              📁
            </Flex>
            <Heading fontSize="20px" fontWeight="600" mb={2} color="#e6edf3">
              Open Folder
            </Heading>
            <Text fontSize="14px" color="#8b949e" lineHeight="1.5" mb={4}>
              Open an existing project folder and start coding immediately.
            </Text>
            <Text fontSize="12px" color="#7d8590" bg="rgba(110, 118, 129, 0.1)" p={1} borderRadius="4px" display="inline-block">
              Ctrl+K Ctrl+O
            </Text>
          </Box>

          <Box
            bg="rgba(21, 32, 43, 0.6)"
            backdropFilter="blur(20px)"
            border="1px solid rgba(48, 54, 61, 0.8)"
            borderRadius="16px"
            p={6}
            cursor="pointer"
            position="relative"
            overflow="hidden"
            _hover={{
              transform: 'translateY(-8px)',
              borderColor: 'rgba(88, 166, 255, 0.6)',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(88, 166, 255, 0.1)',
            }}
            transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
            onClick={handleOpenFolder}
          >
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              height="2px"
              bgGradient="linear(90deg, transparent, rgba(88, 166, 255, 0.5), transparent)"
              transform="translateX(-100%)"
              transition="transform 0.6s ease"
              _groupHover={{
                transform: 'translateX(100%)',
              }}
            />
            <Flex
              width="64px"
              height="64px"
              borderRadius="12px"
              alignItems="center"
              justifyContent="center"
              fontSize="28px"
              mb={5}
              bgGradient="linear(135deg, #a371f7 0%, #8250df 100%)"
              boxShadow="0 8px 24px rgba(163, 113, 247, 0.3)"
            >
              🔗
            </Flex>
            <Heading fontSize="20px" fontWeight="600" mb={2} color="#e6edf3">
              Clone Repository
            </Heading>
            <Text fontSize="14px" color="#8b949e" lineHeight="1.5" mb={4}>
              Clone a Git repository from GitHub, GitLab, or any Git server.
            </Text>
            <Text fontSize="12px" color="#7d8590" bg="rgba(110, 118, 129, 0.1)" p={1} borderRadius="4px" display="inline-block">
              Ctrl+Shift+P
            </Text>
          </Box>

          <Box
            bg="rgba(21, 32, 43, 0.6)"
            backdropFilter="blur(20px)"
            border="1px solid rgba(48, 54, 61, 0.8)"
            borderRadius="16px"
            p={6}
            cursor="pointer"
            position="relative"
            overflow="hidden"
            _hover={{
              transform: 'translateY(-8px)',
              borderColor: 'rgba(88, 166, 255, 0.6)',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(88, 166, 255, 0.1)',
            }}
            transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
          >
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              height="2px"
              bgGradient="linear(90deg, transparent, rgba(88, 166, 255, 0.5), transparent)"
              transform="translateX(-100%)"
              transition="transform 0.6s ease"
              _groupHover={{
                transform: 'translateX(100%)',
              }}
            />
            <Flex
              width="64px"
              height="64px"
              borderRadius="12px"
              alignItems="center"
              justifyContent="center"
              fontSize="28px"
              mb={5}
              bgGradient="linear(135deg, #fb8500 0%, #f77f00 100%)"
              boxShadow="0 8px 24px rgba(251, 133, 0, 0.3)"
            >
              📦
            </Flex>
            <Heading fontSize="20px" fontWeight="600" mb={2} color="#e6edf3">
              Import Project
            </Heading>
            <Text fontSize="14px" color="#8b949e" lineHeight="1.5" mb={4}>
              Import existing projects and configure them automatically.
            </Text>
            <Text fontSize="12px" color="#7d8590" bg="rgba(110, 118, 129, 0.1)" p={1} borderRadius="4px" display="inline-block">
              Ctrl+Shift+I
            </Text>
          </Box>
        </Grid>

        <HStack position="absolute" bottom={6} right={6} gap={4}>
          <HStack gap={2} fontSize="12px" color="#7d8590">
            <Box width="16px" height="16px" bg="rgba(88, 166, 255, 0.2)" borderRadius="50%" display="flex" alignItems="center" justifyContent="center" fontSize="10px">
              🔥
            </Box>
            <Text>12 Projects</Text>
          </HStack>
          <HStack gap={2} fontSize="12px" color="#7d8590">
            <Box width="16px" height="16px" bg="rgba(88, 166, 255, 0.2)" borderRadius="50%" display="flex" alignItems="center" justifyContent="center" fontSize="10px">
              ⚡
            </Box>
            <Text>Fast Launch</Text>
          </HStack>
          <HStack gap={2} fontSize="12px" color="#7d8590">
            <Box width="16px" height="16px" bg="rgba(88, 166, 255, 0.2)" borderRadius="50%" display="flex" alignItems="center" justifyContent="center" fontSize="10px">
              🎯
            </Box>
            <Text>Smart Tools</Text>
          </HStack>
        </HStack>
      </Flex>

      {/* New Project Dialog */}
      <Dialog.RootProvider value={newProjectDialog}>
        <Portal>
          <Dialog.Backdrop bg="rgba(0, 0, 0, 0.8)" backdropFilter="blur(8px)" />
          <Dialog.Positioner>
            <Dialog.Content 
              bg="rgba(13, 17, 23, 0.95)" 
              border="1px solid rgba(48, 54, 61, 0.8)" 
              borderRadius="16px"
              color="#e6edf3"
              maxW="500px"
              w="90%"
            >
              <Dialog.Header>
                <Heading fontSize="24px" fontWeight="600">Create New Project</Heading>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild>
                <Button 
                  position="absolute" 
                  top="16px" 
                  right="16px" 
                  bg="none" 
                  border="none" 
                  color="#7d8590" 
                  fontSize="18px" 
                  cursor="pointer" 
                  p={1} 
                  borderRadius="4px"
                  _hover={{
                    bg: 'rgba(248, 81, 73, 0.1)',
                    color: '#f85149',
                  }}
                >
                  &times;
                </Button>
              </Dialog.CloseTrigger>
              <Dialog.Body pb={6}>
                <VStack gap={4} align="stretch">
                  <Box>
                    <Text fontSize="14px" color="#c9d1d9" mb={2}>Project Name</Text>
                    <Input 
                      placeholder="my-awesome-project" 
                      bg="rgba(21, 32, 43, 0.8)"
                      border="1px solid rgba(48, 54, 61, 0.8)"
                      borderRadius="8px"
                      color="#e6edf3"
                      _focus={{
                        borderColor: '#58a6ff',
                        boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)',
                      }}
                    />
                  </Box>
                  
                  <Box>
                    <Text fontSize="14px" color="#c9d1d9" mb={2}>Template</Text>
                    <NativeSelect.Root size="sm">
                      <NativeSelect.Field placeholder="Select template">
                        {templates.map((template) => (
                          <option key={template.value} value={template.value}>
                            {template.label}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  </Box>
                  
                  <Box>
                    <Text fontSize="14px" color="#c9d1d9" mb={2}>Location</Text>
                    <Input 
                      placeholder="~/Projects" 
                      bg="rgba(21, 32, 43, 0.8)"
                      border="1px solid rgba(48, 54, 61, 0.8)"
                      borderRadius="8px"
                      color="#e6edf3"
                      _focus={{
                        borderColor: '#58a6ff',
                        boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)',
                      }}
                    />
                  </Box>
                </VStack>
              </Dialog.Body>

              <Dialog.Footer>
                <Button 
                  variant="outline"
                  mr={3} 
                  onClick={() => newProjectDialog.setOpen(false)}
                  border="1px solid rgba(48, 54, 61, 0.8)"
                  _hover={{
                    bg: 'rgba(139, 148, 158, 0.1)',
                    color: '#c9d1d9',
                  }}
                >
                  Cancel
                </Button>
                <Button 
                  colorPalette="blue"
                  onClick={handleCreateProject}
                  bgGradient="linear(135deg, #58a6ff 0%, #0969da 100%)"
                  color="white"
                  _hover={{
                    transform: 'translateY(-2px)',
                    boxShadow: '0 8px 16px rgba(88, 166, 255, 0.3)',
                  }}
                >
                  Create Project
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.RootProvider>

      {/* Clone Repository Dialog */}
      <Dialog.RootProvider value={cloneDialog}>
        <Portal>
          <Dialog.Backdrop bg="rgba(0, 0, 0, 0.8)" backdropFilter="blur(8px)" />
          <Dialog.Positioner>
            <Dialog.Content 
              bg="rgba(13, 17, 23, 0.95)" 
              border="1px solid rgba(48, 54, 61, 0.8)" 
              borderRadius="16px"
              color="#e6edf3"
              maxW="500px"
              w="90%"
            >
              <Dialog.Header>
                <Heading fontSize="24px" fontWeight="600">Clone Repository</Heading>
              </Dialog.Header>
              <Dialog.CloseTrigger asChild>
                <Button 
                  position="absolute" 
                  top="16px" 
                  right="16px" 
                  bg="none" 
                  border="none" 
                  color="#7d8590" 
                  fontSize="18px" 
                  cursor="pointer" 
                  p={1} 
                  borderRadius="4px"
                  _hover={{
                    bg: 'rgba(248, 81, 73, 0.1)',
                    color: '#f85149',
                  }}
                >
                  &times;
                </Button>
              </Dialog.CloseTrigger>
              <Dialog.Body pb={6}>
                <VStack gap={4} align="stretch">
                  <Box>
                    <Text fontSize="14px" color="#c9d1d9" mb={2}>Repository URL</Text>
                    <Input 
                      placeholder="https://github.com/user/repo.git" 
                      bg="rgba(21, 32, 43, 0.8)"
                      border="1px solid rgba(48, 54, 61, 0.8)"
                      borderRadius="8px"
                      color="#e6edf3"
                      _focus={{
                        borderColor: '#58a6ff',
                        boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)',
                      }}
                    />
                  </Box>
                  
                  <Box>
                    <Text fontSize="14px" color="#c9d1d9" mb={2}>Local Path</Text>
                    <Input 
                      placeholder="~/Projects/repo" 
                      bg="rgba(21, 32, 43, 0.8)"
                      border="1px solid rgba(48, 54, 61, 0.8)"
                      borderRadius="8px"
                      color="#e6edf3"
                      _focus={{
                        borderColor: '#58a6ff',
                        boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)',
                      }}
                    />
                  </Box>
                  
                  <Box>
                    <Text fontSize="14px" color="#c9d1d9" mb={2}>Branch (optional)</Text>
                    <Input 
                      placeholder="main" 
                      bg="rgba(21, 32, 43, 0.8)"
                      border="1px solid rgba(48, 54, 61, 0.8)"
                      borderRadius="8px"
                      color="#e6edf3"
                      _focus={{
                        borderColor: '#58a6ff',
                        boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)',
                      }}
                    />
                  </Box>
                </VStack>
              </Dialog.Body>

              <Dialog.Footer>
                <Button 
                  variant="outline"
                  mr={3} 
                  onClick={() => cloneDialog.setOpen(false)}
                  border="1px solid rgba(48, 54, 61, 0.8)"
                  _hover={{
                    bg: 'rgba(139, 148, 158, 0.1)',
                    color: '#c9d1d9',
                  }}
                >
                  Cancel
                </Button>
                <Button 
                  colorPalette="blue"
                  onClick={handleCloneProject}
                  bgGradient="linear(135deg, #58a6ff 0%, #0969da 100%)"
                  color="white"
                  _hover={{
                    transform: 'translateY(-2px)',
                    boxShadow: '0 8px 16px rgba(88, 166, 255, 0.3)',
                  }}
                >
                  Clone Repository
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.RootProvider>
    </Flex>
  )
}

export default WelcomeScreen