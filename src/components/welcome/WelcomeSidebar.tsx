import React from 'react'
import {
  Box,
  Flex,
  Heading,
  Text,
  VStack,
  HStack,
  Icon,
} from '@chakra-ui/react'
import {
  LuFilePlus2,
  LuFolderOpen,
  LuGitBranch,
  LuFolder,
  LuClock,
  LuChevronRight,
  LuSettings,
} from 'react-icons/lu'
import { tokens } from '@/theme/tokens'

interface RecentProject {
  id?: string
  name: string
  path: string
  lastOpened?: string
}

interface WelcomeSidebarProps {
  recentProjects: RecentProject[]
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepository: () => void
  onOpenProject: (path?: string) => void
  onSettings?: () => void
}

const actionItems = [
  { id: 'new', icon: LuFilePlus2, label: 'New Project', color: tokens.colors.accent.primary },
  { id: 'open', icon: LuFolderOpen, label: 'Open Project', color: tokens.colors.accent.greenBright },
  { id: 'clone', icon: LuGitBranch, label: 'Clone Repository', color: tokens.colors.accent.purple },
]

const WelcomeSidebar: React.FC<WelcomeSidebarProps> = ({
  recentProjects,
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onOpenProject,
  onSettings,
}) => {
  const handleAction = (id: string) => {
    if (id === 'new') onNewProject()
    else if (id === 'open') onOpenFolder()
    else if (id === 'clone') onCloneRepository()
  }

  const truncatePath = (path: string, maxLen = 38) => {
    if (path.length <= maxLen) return path
    const parts = path.split('/')
    if (parts.length <= 3) return '...' + path.slice(-maxLen)
    return parts[0] + '/.../' + parts.slice(-2).join('/')
  }

  return (
    <Box
      width="300px"
      minWidth="300px"
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(24px)"
      borderRight="1px solid"
      borderColor="rgba(254, 16, 99, 0.15)"
      display="flex"
      flexDirection="column"
      py={8}
      px={5}
      pt={12}
      data-no-drag
      position="relative"
      overflow="hidden"
    >
      {/* Subtle glow at top */}
      <Box
        position="absolute"
        top="-60px"
        left="50%"
        transform="translateX(-50%)"
        width="200px"
        height="120px"
        bg="radial-gradient(ellipse, rgba(254, 16, 99, 0.12) 0%, transparent 70%)"
        pointerEvents="none"
      />

      {/* Logo */}
      <Flex alignItems="center" mb={10} position="relative">
        <Box
          width="36px"
          height="36px"
          mr={3}
          flexShrink={0}
          filter="drop-shadow(0 4px 12px rgba(254, 16, 99, 0.4))"
        >
          <img
            src="/isologo.svg"
            alt="TM Code"
            style={{ width: '100%', height: '100%' }}
          />
        </Box>
        <Heading
          fontSize="18px"
          fontWeight="800"
          color="white"
          letterSpacing="-0.3px"
        >
          TM Code
        </Heading>
      </Flex>

      {/* Action buttons */}
      <VStack align="stretch" gap={1} mb={8}>
        <Text
          fontSize="11px"
          fontWeight="700"
          textTransform="uppercase"
          color={tokens.colors.text.muted}
          mb={3}
          letterSpacing="1px"
          px={2}
        >
          Start
        </Text>

        {actionItems.map((item) => (
          <Flex
            key={item.id}
            alignItems="center"
            gap={3}
            px={3}
            py={2.5}
            borderRadius="10px"
            cursor="pointer"
            transition="all 0.2s ease"
            _hover={{
              bg: 'rgba(254, 16, 99, 0.08)',
              transform: 'translateX(4px)',
            }}
            onClick={() => handleAction(item.id)}
          >
            <Flex
              width="32px"
              height="32px"
              borderRadius="8px"
              alignItems="center"
              justifyContent="center"
              bg="rgba(255, 255, 255, 0.05)"
              border="1px solid"
              borderColor="rgba(255, 255, 255, 0.08)"
              flexShrink={0}
            >
              <Icon color={item.color} fontSize="15px">
                {React.createElement(item.icon)}
              </Icon>
            </Flex>
            <Text
              fontSize="13px"
              fontWeight="500"
              color={tokens.colors.text.primary}
            >
              {item.label}
            </Text>
          </Flex>
        ))}
      </VStack>

      {/* Recent projects */}
      <VStack align="stretch" flex={1} overflow="hidden">
        <HStack px={2} mb={3}>
          <Icon color={tokens.colors.text.muted} fontSize="12px">
            <LuClock />
          </Icon>
          <Text
            fontSize="11px"
            fontWeight="700"
            textTransform="uppercase"
            color={tokens.colors.text.muted}
            letterSpacing="1px"
          >
            Recent
          </Text>
        </HStack>

        <VStack
          align="stretch"
          gap={0.5}
          flex={1}
          overflowY="auto"
          css={{
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '4px',
            },
          }}
        >
          {recentProjects.length === 0 && (
            <Text fontSize="12px" color={tokens.colors.text.muted} px={3} py={4} textAlign="center">
              No recent projects
            </Text>
          )}

          {recentProjects.map((project, index) => (
            <Flex
              key={project.id || index}
              alignItems="center"
              gap={3}
              px={3}
              py={2}
              borderRadius="8px"
              cursor="pointer"
              transition="all 0.2s ease"
              _hover={{
                bg: 'rgba(255, 255, 255, 0.05)',
              }}
              onClick={() => project.path && onOpenProject(project.path)}
            >
              <Icon color={tokens.colors.accent.primary} fontSize="14px" flexShrink={0} opacity={0.7}>
                <LuFolder />
              </Icon>
              <VStack gap={0} alignItems="flex-start" flex={1} minWidth={0}>
                <Text
                  fontSize="13px"
                  fontWeight="500"
                  color={tokens.colors.text.primary}
                  lineClamp={1}
                >
                  {project.name}
                </Text>
                <Text
                  fontSize="10px"
                  color={tokens.colors.text.muted}
                  lineClamp={1}
                  opacity={0.7}
                >
                  {truncatePath(project.path)}
                </Text>
              </VStack>
              <Icon color={tokens.colors.text.muted} fontSize="12px" opacity={0} transition="opacity 0.2s" css={{ '.group:hover &, *:hover > &': { opacity: 1 } }}>
                <LuChevronRight />
              </Icon>
            </Flex>
          ))}
        </VStack>
      </VStack>

      {/* Footer — settings + version */}
      <Flex pt={4} mt={4} borderTop="1px solid rgba(255,255,255,0.05)" alignItems="center" justifyContent="space-between" px={2}>
        <Flex
          width="28px"
          height="28px"
          alignItems="center"
          justifyContent="center"
          borderRadius="6px"
          cursor="pointer"
          transition="all 0.2s ease"
          _hover={{ bg: 'rgba(255, 255, 255, 0.06)' }}
          onClick={onSettings}
        >
          <Icon color={tokens.colors.text.muted} fontSize="15px">
            <LuSettings />
          </Icon>
        </Flex>
        <Text fontSize="10px" color={tokens.colors.text.muted} opacity={0.5}>
          v0.1.3
        </Text>
      </Flex>
    </Box>
  )
}

export default WelcomeSidebar
