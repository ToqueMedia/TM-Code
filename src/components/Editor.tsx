// src/components/Editor.tsx
import React from 'react'
import {
  Box,
  Flex,
  Text,
  HStack,
  Icon,
  Button,
  Tabs,
} from '@chakra-ui/react'

interface EditorProps {
  projectName: string
  fileName: string
  filePath: string
}

const Editor: React.FC<EditorProps> = ({ projectName, fileName }) => {
  return (
    <Flex 
      minHeight="100vh" 
      bg="#0d1117"
      color="#c9d1d9"
      direction="column"
    >
      {/* Top Bar */}
      <Flex 
        alignItems="center" 
        px={4} 
        py={2} 
        bg="linear-gradient(135deg, #161b22 0%, #21262d 100%)" 
        borderBottom="1px solid #30363d"
      >
        <Text fontSize="13px" fontWeight="500" color="#8b949e">
          {projectName} - {fileName} - Diamond IDE
        </Text>
        <HStack gap="2" ml="auto">
          <Button 
            width="12px" 
            height="12px" 
            borderRadius="50%" 
            bg="#ffbd2e" 
            minW="auto" 
            p={0}
            _hover={{ bg: "#e6ac22" }}
          />
          <Button 
            width="12px" 
            height="12px" 
            borderRadius="50%" 
            bg="#27ca3f" 
            minW="auto" 
            p={0}
            _hover={{ bg: "#22b739" }}
          />
          <Button 
            width="12px" 
            height="12px" 
            borderRadius="50%" 
            bg="#ff5f56" 
            minW="auto" 
            p={0}
            _hover={{ bg: "#e6554c" }}
          />
        </HStack>
      </Flex>

      <Flex flex={1}>
        {/* Activity Bar */}
        <Flex
          direction="column"
          alignItems="center"
          py={3}
          px={2}
          bg="#161b22"
          borderRight="1px solid #30363d"
        >
          <Button 
            width="40px" 
            height="40px" 
            borderRadius="6px" 
            mb={2}
            bg="#21262d"
            color="#58a6ff"
            _hover={{ bg: "#21262d" }}
          >
            <Icon as={() => <span>📁</span>} fontSize="18px" />
          </Button>
          <Button 
            width="40px" 
            height="40px" 
            borderRadius="6px" 
            mb={2}
            color="#7d8590"
            _hover={{ bg: "#21262d", color: "#58a6ff" }}
          >
            <Icon as={() => <span>🔍</span>} fontSize="18px" />
          </Button>
          <Button 
            width="40px" 
            height="40px" 
            borderRadius="6px" 
            mb={2}
            color="#7d8590"
            _hover={{ bg: "#21262d", color: "#58a6ff" }}
          >
            <Icon as={() => <span>🔀</span>} fontSize="18px" />
          </Button>
          <Button 
            width="40px" 
            height="40px" 
            borderRadius="6px" 
            mb={2}
            color="#7d8590"
            _hover={{ bg: "#21262d", color: "#58a6ff" }}
          >
            <Icon as={() => <span>🐛</span>} fontSize="18px" />
          </Button>
          <Button 
            width="40px" 
            height="40px" 
            borderRadius="6px" 
            color="#7d8590"
            _hover={{ bg: "#21262d", color: "#58a6ff" }}
          >
            <Icon as={() => <span>📦</span>} fontSize="18px" />
          </Button>
        </Flex>

        {/* Sidebar */}
        <Flex
          direction="column"
          width="280px"
          bg="#0d1117"
          borderRight="1px solid #30363d"
        >
          <Box 
            px={4} 
            py={2} 
            fontSize="11px" 
            fontWeight="600" 
            textTransform="uppercase" 
            color="#7d8590" 
            bg="#161b22" 
            borderBottom="1px solid #21262d"
          >
            Explorer
          </Box>
          <Box p={2}>
            <Box 
              display="flex" 
              alignItems="center" 
              p={1} 
              borderRadius="4px" 
              cursor="pointer"
              _hover={{ bg: "rgba(88, 166, 255, 0.1)" }}
            >
              <Icon as={() => <span>📁</span>} mr={2} fontSize="14px" />
              <Text fontSize="13px">{projectName}</Text>
            </Box>
            <Box 
              display="flex" 
              alignItems="center" 
              p={1} 
              borderRadius="4px" 
              cursor="pointer"
              ml={4}
              _hover={{ bg: "rgba(88, 166, 255, 0.1)" }}
            >
              <Icon as={() => <span>📁</span>} mr={2} fontSize="14px" />
              <Text fontSize="13px">src</Text>
            </Box>
            <Box 
              display="flex" 
              alignItems="center" 
              p={1} 
              borderRadius="4px" 
              cursor="pointer"
              ml={4}
              bg="rgba(88, 166, 255, 0.2)"
              color="#58a6ff"
            >
              <Icon as={() => <span>📄</span>} mr={2} fontSize="14px" />
              <Text fontSize="13px">{fileName}</Text>
            </Box>
            <Box 
              display="flex" 
              alignItems="center" 
              p={1} 
              borderRadius="4px" 
              cursor="pointer"
              ml={4}
              _hover={{ bg: "rgba(88, 166, 255, 0.1)" }}
            >
              <Icon as={() => <span>📄</span>} mr={2} fontSize="14px" />
              <Text fontSize="13px">package.json</Text>
            </Box>
            <Box 
              display="flex" 
              alignItems="center" 
              p={1} 
              borderRadius="4px" 
              cursor="pointer"
              ml={4}
              _hover={{ bg: "rgba(88, 166, 255, 0.1)" }}
            >
              <Icon as={() => <span>📄</span>} mr={2} fontSize="14px" />
              <Text fontSize="13px">README.md</Text>
            </Box>
          </Box>
        </Flex>

        {/* Main Editor Area */}
        <Flex flex={1} direction="column">
          <Tabs.Root defaultValue={fileName}>
            <Tabs.List 
              bg="#161b22" 
              borderBottom="1px solid #21262d" 
              minHeight="35px"
            >
              <Tabs.Trigger 
                value={fileName}
                px={4} 
                py={2} 
                fontSize="13px" 
                borderRight="1px solid #21262d"
                _selected={{ 
                  bg: "#0d1117", 
                  borderBottom: "2px solid #58a6ff",
                  color: "#58a6ff"
                }}
                _hover={{ 
                  bg: "#21262d"
                }}
              >
                {fileName}
                <Text ml={2} opacity={0.6}>✕</Text>
              </Tabs.Trigger>
              <Tabs.Trigger 
                value="package.json"
                px={4} 
                py={2} 
                fontSize="13px" 
                borderRight="1px solid #21262d"
                _selected={{ 
                  bg: "#0d1117", 
                  borderBottom: "2px solid #58a6ff"
                }}
                _hover={{ 
                  bg: "#21262d"
                }}
              >
                package.json
                <Text ml={2} opacity={0.6}>✕</Text>
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value={fileName} p={0} flex={1}>
              {/* Code Editor */}
              <Flex flex={1} position="relative">
                <Box 
                  position="absolute" 
                  left={0} 
                  top={4} 
                  width="50px" 
                  color="#484f58" 
                  textAlign="right" 
                  pr={4} 
                  userSelect="none" 
                  fontSize="13px"
                >
                  1<br/>2<br/>3<br/>4<br/>5<br/>6<br/>7<br/>8<br/>9<br/>10<br/>11<br/>12<br/>13<br/>14<br/>15
                </Box>
                <Box 
                  ml="60px" 
                  p={4} 
                  fontFamily="'Fira Code', 'Consolas', monospace" 
                  fontSize="14px" 
                  lineHeight="1.6"
                  whiteSpace="pre"
                >
                  <Text color="#ff7b72">import</Text> <Text color="#a5d6ff">React</Text> <Text color="#ff7b72">from</Text> <Text color="#a5d6ff">'react'</Text>
                  <Text color="#ff7b72">import</Text> {'{ '}<Text color="#a5d6ff">useState</Text>{' }'} <Text color="#ff7b72">from</Text> <Text color="#a5d6ff">'react'</Text>
                  
                  <Text color="#ff7b72">function</Text> <Text color="#d2a8ff">App</Text>() {'{'}
                  
                    <Text color="#ff7b72">const</Text> [<Text color="#79c0ff">count</Text>, <Text color="#79c0ff">setCount</Text>] = <Text color="#d2a8ff">useState</Text>(<Text color="#a5d6ff">0</Text>)
                  
                  
                    <Text color="#ff7b72">return</Text> (
                  
                      &lt;<Text color="#79c0ff">div</Text>&gt;
                  
                        &lt;<Text color="#79c0ff">h1</Text>&gt;Hello, {'{'}<Text color="#79c0ff">projectName</Text>{'}'}!&lt;/<Text color="#79c0ff">h1</Text>&gt;
                  
                        &lt;<Text color="#79c0ff">button</Text> <Text color="#79c0ff">onClick</Text>={'{() => '}<Text color="#79c0ff">setCount</Text>(<Text color="#79c0ff">count</Text> + <Text color="#a5d6ff">1</Text>){'}'}&gt;
                  
                          Count: {'{'}<Text color="#79c0ff">count</Text>{'}'}
                  
                        &lt;/<Text color="#79c0ff">button</Text>&gt;
                  
                      &lt;/<Text color="#79c0ff">div</Text>&gt;
                  
                    )
                  
                  {'}'}
                  
                  
                  <Text color="#ff7b72">export default</Text> <Text color="#79c0ff">App</Text>
                </Box>
              </Flex>
            </Tabs.Content>
          </Tabs.Root>
        </Flex>
      </Flex>

      {/* Terminal */}
      <Flex 
        direction="column" 
        height="200px" 
        bg="#010409" 
        borderTop="1px solid #21262d"
      >
        <Flex 
          alignItems="center" 
          px={4} 
          py={2} 
          bg="#161b22" 
          borderBottom="1px solid #21262d"
          fontSize="13px"
        >
          <HStack gap="1">
            <Button 
              px={3} 
              py={1} 
              bg="#21262d" 
              borderRadius="4px 4px 0 0"
              fontSize="12px"
              _hover={{ bg: "#21262d" }}
            >
              Terminal
            </Button>
            <Button 
              px={3} 
              py={1} 
              bg="transparent" 
              borderRadius="4px 4px 0 0"
              fontSize="12px"
              color="#7d8590"
              _hover={{ bg: "#21262d" }}
            >
              Output
            </Button>
            <Button 
              px={3} 
              py={1} 
              bg="transparent" 
              borderRadius="4px 4px 0 0"
              fontSize="12px"
              color="#7d8590"
              _hover={{ bg: "#21262d" }}
            >
              Debug Console
            </Button>
          </HStack>
        </Flex>
        <Box 
          flex={1} 
          p={3} 
          fontFamily="'Consolas', monospace" 
          fontSize="13px" 
          overflowY="auto"
        >
          <Text color="#58a6ff">Microsoft Windows [Version 10.0.19044.2728]</Text>
          <Text color="#7d8590">(c) Microsoft Corporation. All rights reserved.</Text>
          
          <Text color="#7c3aed">C:\Users\dev&gt;</Text> <Text color="#58a6ff">npm start</Text>
          
          <Text color="#56d364">Starting development server...</Text>
          
          <Text color="#7c3aed">C:\Users\dev&gt;</Text> <Text className="blinking-cursor">_</Text>
        </Box>
      </Flex>
    </Flex>
  )
}

export default Editor