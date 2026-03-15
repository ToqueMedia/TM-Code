import React, { useEffect, useState } from 'react'
import { Box, Flex, useDialog } from '@chakra-ui/react'
import { useProjectStore } from '../stores/projectStore'
import { useChatStore } from '../stores/chatStore'
import { templateService, Template } from '../services/templateService'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { WelcomeSidebar, WelcomeHero, CloneDialog } from './welcome'
import TemplateSelector from './TemplateSelector'

interface WelcomeScreenProps {
  onOpenProject: (path?: string) => void
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject }) => {
  const cloneDialog = useDialog()
  const { recentProjects, loadRecentProjects } = useProjectStore()
  const [showTemplateSelector, setShowTemplateSelector] = useState(false)

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

  const handleNewProject = () => {
    setShowTemplateSelector(true)
  }

  const handleSelectTemplate = async (template: Template) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a folder for your new project',
      })
      if (!selected) return

      const projectPath = selected as string

      // Scaffold the template
      await templateService.scaffold(template.id, projectPath)

      // Open the project
      await useProjectStore.getState().openProject(projectPath)

      // Create a new chat session
      const chatStore = useChatStore.getState()
      await chatStore.createNewSession(projectPath)

      setShowTemplateSelector(false)
    } catch (error: unknown) {
      logger.error('ui', 'Failed to scaffold template:', error)
    }
  }

  const handleSelectEmpty = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a folder for your new project',
      })
      if (selected) {
        setShowTemplateSelector(false)
        onOpenProject(selected as string)
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }

  if (showTemplateSelector) {
    return (
      <TemplateSelector
        onSelectTemplate={handleSelectTemplate}
        onSelectEmpty={handleSelectEmpty}
        onBack={() => setShowTemplateSelector(false)}
      />
    )
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
