import { useCallback, useEffect, useState } from 'react'
import { Flex, useDialog } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useProjectStore } from '../stores/projectStore'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { WelcomeSidebar, CloneDialog, StartupRequirementsBanner } from './welcome'
import SettingsView from './views/SettingsView'
import MinimalTitleBar from './MinimalTitleBar'
import { WindowTitleManager } from '../utils/windowTitleManager'
import MainLayout from './MainLayout'
import { LoadingSpinner } from './ui/LoadingSpinner'
import { useLayoutStore } from '../stores/layoutStore'

interface WelcomeScreenProps {
  onOpenProject: (path?: string, options?: { initGit?: boolean }) => void | Promise<void>
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject }) => {
  // While a clone is in flight the dialog must be non-dismissable (no escape,
  // no outside-click, no ×). These machine props are reactive, so flipping
  // cloneBusy re-syncs them; CloneDialog reports the state via onBusyChange.
  const [cloneBusy, setCloneBusy] = useState(false)
  const cloneDialog = useDialog({
    closeOnEscape: !cloneBusy,
    closeOnInteractOutside: !cloneBusy,
  })
  const { recentProjects, loadRecentProjects, clearAllRecent, welcomeScreen, setWelcomeScreen } = useProjectStore()
  const currentProject = useProjectStore(s => s.currentProject)
  const viewMode = useLayoutStore(s => s.viewMode)
  const isPreviewFullscreen = useLayoutStore(s => s.isPreviewFullscreen)
  const [openingProjectPath, setOpeningProjectPath] = useState<string | null>(null)
  const showSettings = welcomeScreen === 'settings'
  const previewOwnsWorkspace = Boolean(currentProject?.path) && !showSettings && viewMode === 'preview' && isPreviewFullscreen
  const editorOwnsWorkspace = Boolean(currentProject?.path) && !showSettings && viewMode === 'editor'
  const hideWorkspaceSidebar = previewOwnsWorkspace || editorOwnsWorkspace

  useEffect(() => {
    loadRecentProjects()
    const manager = WindowTitleManager.getInstance()
    manager.startManaging()
    return () => manager.stopManaging()
  }, [loadRecentProjects])

  // Mark that the user is on the Welcome screen so the next app start
  // returns here instead of auto-opening the most recent project.
  useEffect(() => {
    if (welcomeScreen === null) {
      setWelcomeScreen('hero')
    }
  }, [welcomeScreen, setWelcomeScreen])

  const handleOpenFolder = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('misc.selectProjectDir'),
      })
      if (selected) {
        const path = selected as string
        setOpeningProjectPath(path)
        await onOpenProject(path)
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    } finally {
      setOpeningProjectPath(null)
    }
  }, [onOpenProject])

  const handleNewProject = useCallback(async () => {
    // All projects start from scratch — open folder dialog directly
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        title: t('misc.chooseFolder'),
      })
      if (selected) {
        const path = selected as string
        setOpeningProjectPath(path)
        await onOpenProject(path, { initGit: true })
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    } finally {
      setOpeningProjectPath(null)
    }
  }, [onOpenProject])

  const handleOpenRecentProject = useCallback(async (path?: string) => {
    if (!path) return
    setOpeningProjectPath(path)
    try {
      await onOpenProject(path)
    } finally {
      setOpeningProjectPath(null)
    }
  }, [onOpenProject])

  return (
    <Flex
      direction="column"
      height="100vh"
      overflow="hidden"
      bg="#0a0a0a"
      color={tokens.colors.text.primary}
    >
      {/* Global header — provides window controls and drag area */}
      <MinimalTitleBar />

      {/* Main content area below the header */}
      <Flex flex="1" overflow="hidden" position="relative">
        <AnimatePresence initial={false}>
          {!hideWorkspaceSidebar && (
            <motion.div
              key="welcome-sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'clamp(200px, 30vw, 300px)', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
              style={{ height: '100%', overflow: 'hidden', flexShrink: 0 }}
            >
              <WelcomeSidebar
                recentProjects={recentProjects}
                onNewProject={handleNewProject}
                onOpenFolder={handleOpenFolder}
                onCloneRepository={() => cloneDialog.setOpen(true)}
                onOpenProject={handleOpenRecentProject}
                onClearRecent={clearAllRecent}
                activeProjectPath={currentProject?.path ?? null}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {showSettings ? (
          <SettingsView onBack={() => setWelcomeScreen('hero')} />
        ) : null}

        {!showSettings && openingProjectPath ? (
          <Flex flex="1" minW={0} minH={0} align="center" justify="center" overflow="hidden">
            <LoadingSpinner size="lg" label={t('welcome.openingProject')} />
          </Flex>
        ) : !showSettings ? (
          <Flex flex="1" minW={0} minH={0} overflow="hidden">
            <MainLayout embedded />
          </Flex>
        ) : null}

        <CloneDialog dialog={cloneDialog} onCloned={onOpenProject} onBusyChange={setCloneBusy} />

        {/* Non-blocking prereq banner — only shows when a tool is missing/outdated.
            Positioned absolute near the top so it doesn't reflow the hero layout. */}
        {!showSettings && !hideWorkspaceSidebar && <StartupRequirementsBanner />}
      </Flex>
    </Flex>
  )
}

export default WelcomeScreen
