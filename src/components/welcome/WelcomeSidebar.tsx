import React from 'react'
import {
  Box,
  Button,
  Flex,
  Heading,
  Text,
  VStack,
  HStack,
  Icon,
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface RecentProject {
  id?: string
  name: string
  path: string
}

interface WelcomeSidebarProps {
  recentProjects: RecentProject[]
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepository: () => void
  onOpenProject: (path?: string) => void
}

const sidebarButtonHover = {
  bg: tokens.colors.accent.primarySubtle,
  borderColor: tokens.colors.accent.primaryMuted,
  transform: 'translateX(4px)',
}

const WelcomeSidebar: React.FC<WelcomeSidebarProps> = ({
  recentProjects,
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onOpenProject,
}) => {
  return (
    <Box
      width={{ base: '100%', md: '320px' }}
      bg={tokens.colors.bg.sidebarGlass}
      backdropFilter="blur(20px)"
      borderRight={`1px solid ${tokens.colors.border.sidebar}`}
      display="flex"
      flexDirection="column"
      p={6}
    >
      <Flex alignItems="center" mb={8}>
        <Box
          width="48px"
          height="48px"
          background={tokens.gradient.logoTitle}
          borderRadius="12px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          fontSize="24px"
          mr={3}
          boxShadow={tokens.shadow.logoGlow}
        >
          💎
        </Box>
        <Heading
          fontSize="24px"
          fontWeight="700"
          background={tokens.gradient.logoTitle}
          backgroundClip="text"
          color="transparent"
        >
          ToqueMedia Studio
        </Heading>
      </Flex>

      <VStack align="stretch" flex="1">
        <Text
          fontSize="12px"
          fontWeight="600"
          textTransform="uppercase"
          color={tokens.colors.text.muted}
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
          _hover={sidebarButtonHover}
          onClick={onNewProject}
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
          _hover={sidebarButtonHover}
          onClick={onOpenFolder}
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
          _hover={sidebarButtonHover}
          onClick={onCloneRepository}
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
          _hover={sidebarButtonHover}
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
          color={tokens.colors.text.muted}
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
              bg: tokens.colors.bg.hoverSubtle,
            }}
            onClick={() => {
              if (project.path) {
                onOpenProject(project.path)
              }
            }}
          >
            <HStack>
              <Icon as={() => <span>📁</span>} mr={2} fontSize="14px" color={tokens.colors.text.muted} />
              <VStack gap={0} alignItems="flex-start">
                <Text fontSize="13px" color={tokens.colors.text.primary}>{project.name}</Text>
                <Text fontSize="11px" color={tokens.colors.text.muted}>{project.path}</Text>
              </VStack>
            </HStack>
          </Box>
        ))}
      </VStack>
    </Box>
  )
}

export default WelcomeSidebar
