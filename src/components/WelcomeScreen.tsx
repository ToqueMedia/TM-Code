import React, { useEffect } from 'react'
import { Box, Flex, useDialog } from '@chakra-ui/react'
import { useProjectStore } from '../stores/projectStore'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { WelcomeSidebar, WelcomeHero, CloneDialog } from './welcome'

interface WelcomeScreenProps {
  onOpenProject: (path?: string) => void
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject }) => {
  const cloneDialog = useDialog()
  const { recentProjects, loadRecentProjects } = useProjectStore()

  useEffect(() => {
    loadRecentProjects()
  }, [loadRecentProjects])

  const handleOpenFolder = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select project directory',
      })
      if (selected) {
        onOpenProject(selected as string)
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }

  const handleNewProject = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a folder for your new project',
      })
      if (selected) {
        onOpenProject(selected as string)
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }

  return (
    <Flex
      minHeight="100vh"
      bg={tokens.colors.bg.welcome}
      color={tokens.colors.text.primary}
    >
      {/* Animated Background */}
      <Box
        position="fixed"
        top="0"
        left="0"
        width="100%"
        height="100%"
        zIndex="-1"
        background={tokens.gradient.welcomeBg}
      />

      <WelcomeSidebar
        recentProjects={recentProjects}
        onNewProject={handleNewProject}
        onOpenFolder={handleOpenFolder}
        onCloneRepository={() => cloneDialog.setOpen(true)}
        onOpenProject={onOpenProject}
      />

      <WelcomeHero onOpenFolder={handleOpenFolder} />

      <CloneDialog dialog={cloneDialog} />
    </Flex>
  )
}

export default WelcomeScreen
