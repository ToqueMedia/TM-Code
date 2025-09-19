import { Box, HStack, Text, Flex } from '@chakra-ui/react'

interface TitleBarProps {
  title?: string
  subtitle?: string
}

function TitleBar({ title = "todo-list-app", subtitle }: TitleBarProps) {
  return (
    <Box
      className="vscode-titlebar"
      height="37px"
      bg="#323233"
      borderBottom="1px solid #2b2b2c"
      display="flex"
      alignItems="center"
      px={3}
      position="relative"
      userSelect="none"
      // Make the titlebar draggable (Tauri specific)
      data-tauri-drag-region
    >
      {/* Window Controls - macOS style */}
      <HStack gap={2} position="absolute" left={3}>
        <Box
          width="12px"
          height="12px"
          borderRadius="full"
          bg="#ff5f57"
          cursor="pointer"
          _hover={{ brightness: 1.1 }}
          transition="filter 0.2s"
        />
        <Box
          width="12px"
          height="12px"
          borderRadius="full"
          bg="#ffbd2e"
          cursor="pointer"
          _hover={{ brightness: 1.1 }}
          transition="filter 0.2s"
        />
        <Box
          width="12px"
          height="12px"
          borderRadius="full"
          bg="#28ca42"
          cursor="pointer"
          _hover={{ brightness: 1.1 }}
          transition="filter 0.2s"
        />
      </HStack>

      {/* Title and Project Info */}
      <Flex
        flex={1}
        justifyContent="center"
        alignItems="center"
        gap={2}
      >
        <HStack gap={1}>
          <Text
            fontSize="13px"
            color="#cccccc"
            fontWeight="400"
            lineHeight="1"
          >
            {title}
          </Text>
          {subtitle && (
            <>
              <Text fontSize="13px" color="#858585">•</Text>
              <Text
                fontSize="13px"
                color="#858585"
                fontWeight="400"
                lineHeight="1"
              >
                {subtitle}
              </Text>
            </>
          )}
        </HStack>
      </Flex>

      {/* Right side - can add search or other controls here */}
      <Box position="absolute" right={3}>
        {/* Space for future controls */}
      </Box>
    </Box>
  )
}

export default TitleBar