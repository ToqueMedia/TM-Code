import React, { useEffect } from 'react'
import {
  Box,
  Flex,
  Grid,
  Heading,
  Text,
  VStack,
} from '@chakra-ui/react'
import type { IconType } from 'react-icons'
import {
  LuRocket,
  LuFolderOpen,
  LuGitBranch,
  LuFileCode,
} from 'react-icons/lu'
import { tokens } from '@/theme/tokens'
import { useSettingsStore, matchesBinding, type ShortcutId } from '@/stores/settingsStore'
import WelcomeFeatureCard from './WelcomeFeatureCard'

interface WelcomeHeroProps {
  onNewProject: () => void
  onOpenFolder: () => void
  onProjectFromScratch: () => void
  onCloneRepository: () => void
}

const featureCards: {
  id: string
  icon: IconType
  title: string
  description: string
  shortcutId: ShortcutId | null
  color: string
}[] = [
  {
    id: 'new',
    icon: LuRocket,
    title: 'New Project',
    description: 'Start fresh with templates and boilerplates for any framework.',
    shortcutId: 'newProject',
    color: tokens.colors.accent.primary,
  },
  {
    id: 'scratch',
    icon: LuFileCode,
    title: 'Project from Scratch',
    description: 'Pick an empty folder and start building from zero.',
    shortcutId: null,
    color: tokens.colors.accent.orange,
  },
  {
    id: 'open',
    icon: LuFolderOpen,
    title: 'Open Folder',
    description: 'Open an existing project and start coding immediately.',
    shortcutId: 'openFile',
    color: tokens.colors.accent.greenBright,
  },
  {
    id: 'clone',
    icon: LuGitBranch,
    title: 'Clone Repository',
    description: 'Clone from GitHub, GitLab, or any Git remote server.',
    shortcutId: null,
    color: tokens.colors.accent.purple,
  },
]

const WelcomeHero: React.FC<WelcomeHeroProps> = ({ onNewProject, onOpenFolder, onProjectFromScratch, onCloneRepository }) => {
  const shortcuts = useSettingsStore(s => s.shortcuts)

  const cardActions: Record<string, () => void> = {
    new: onNewProject,
    scratch: onProjectFromScratch,
    open: onOpenFolder,
    clone: onCloneRepository,
  }

  // Keyboard shortcuts active on WelcomeScreen (no project open, useKeyboardShortcuts won't handle these)
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const sc = useSettingsStore.getState().shortcuts
      if (matchesBinding(e, sc.newProject)) {
        e.preventDefault()
        onNewProject()
      } else if (matchesBinding(e, sc.openFile)) {
        e.preventDefault()
        onOpenFolder()
      } else if (matchesBinding(e, sc.commandPalette)) {
        e.preventDefault()
        onCloneRepository()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onNewProject, onOpenFolder, onCloneRepository])

  return (
    <Flex
      flex={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      p={12}
      position="relative"
      overflow="hidden"
    >
      {/* Background radial accents */}
      <Box
        position="absolute"
        top="10%"
        left="30%"
        width="400px"
        height="400px"
        bg="radial-gradient(ellipse, rgba(254, 16, 99, 0.06) 0%, transparent 70%)"
        pointerEvents="none"
      />
      <Box
        position="absolute"
        bottom="10%"
        right="20%"
        width="300px"
        height="300px"
        bg="radial-gradient(ellipse, rgba(163, 113, 247, 0.04) 0%, transparent 70%)"
        pointerEvents="none"
      />

      <VStack textAlign="center" mb={12} position="relative">
        <Heading
          fontSize={{ base: '28px', md: '40px' }}
          fontWeight="900"
          color="white"
          letterSpacing="-0.5px"
          mb={3}
          lineHeight="1.1"
        >
          Welcome to{' '}
          <Box
            as="span"
            bgGradient="to-r"
            gradientFrom={tokens.colors.accent.primary}
            gradientTo={tokens.colors.accent.purple}
            bgClip="text"
          >
            TM Code
          </Box>
        </Heading>
        <Text
          fontSize="16px"
          color={tokens.colors.text.secondary}
          maxW="460px"
          lineHeight="1.6"
          fontWeight="400"
        >
          A powerful, modern IDE built for today's developers.
          Create, code, and ship with style.
        </Text>
      </VStack>

      <Grid
        templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)' }}
        gap={5}
        maxW="720px"
        w="100%"
        data-no-drag
      >
        {featureCards.map((card) => (
          <WelcomeFeatureCard
            key={card.id}
            icon={card.icon}
            title={card.title}
            description={card.description}
            binding={card.shortcutId ? shortcuts[card.shortcutId] : null}
            color={card.color}
            onClick={cardActions[card.id]}
          />
        ))}
      </Grid>
    </Flex>
  )
}

export default WelcomeHero
