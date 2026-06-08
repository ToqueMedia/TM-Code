import { useCallback, useEffect } from 'react'
import { Box, Flex, useDialog } from '@chakra-ui/react'
import { useProjectStore } from '../stores/projectStore'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { WelcomeSidebar, WelcomeHero, CloneDialog, StartupRequirementsBanner, PromoBanner } from './welcome'
import SettingsView from './views/SettingsView'
import MinimalTitleBar from './MinimalTitleBar'
import { TerminalView } from './cmd-mode'
import { WindowTitleManager } from '../utils/windowTitleManager'

interface WelcomeScreenProps {
  onOpenProject: (path?: string, options?: { initGit?: boolean }) => void
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject }) => {
  const cloneDialog = useDialog()
  const { recentProjects, loadRecentProjects, cmdModeProjectPath, cmdModeProjectPaths, setCmdModeProjectPath, removeCmdModePath, clearAllRecent, welcomeScreen, setWelcomeScreen } = useProjectStore()
  const showSettings = welcomeScreen === 'settings'

  useEffect(() => {
    loadRecentProjects()
    const manager = WindowTitleManager.getInstance()
    manager.startManaging()
    return () => manager.stopManaging()
  }, [loadRecentProjects])

  // Mark that the user is on the Welcome screen so the next app start
  // returns here instead of auto-opening the most recent project. Null →
  // 'hero' promotion is a no-op if cmdMode is active; the user is in that
  // sub-screen instead and its own persistence covers that case.
  useEffect(() => {
    if (!cmdModeProjectPath && welcomeScreen === null) {
      setWelcomeScreen('hero')
    }
  }, [cmdModeProjectPath, welcomeScreen, setWelcomeScreen])

  const handleOpenFolder = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('misc.selectProjectDir'),
      })
      if (selected) {
        onOpenProject(selected as string)
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
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
        onOpenProject(selected as string, { initGit: true })
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }, [onOpenProject])

  const handleCmdMode = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        title: t('misc.chooseFolder'),
      })
      if (selected) {
        setCmdModeProjectPath(selected as string)
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }, [setCmdModeProjectPath])

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
        {!cmdModeProjectPath && (
          <WelcomeSidebar
            recentProjects={recentProjects}
            cmdModeProjectPaths={cmdModeProjectPaths}
            onOpenCmdProject={setCmdModeProjectPath}
            onOpenCmdProjectAsIde={(path) => { removeCmdModePath(path); onOpenProject(path) }}
            onOpenProject={onOpenProject}
            onSettings={() => setWelcomeScreen('settings')}
            onClearRecent={clearAllRecent}
          />
        )}

        {showSettings ? (
          <SettingsView onBack={() => setWelcomeScreen(cmdModeProjectPath ? null : 'hero')} />
        ) : null}

        {cmdModeProjectPath ? (
          <Box flex="1" minH={0} display={showSettings ? 'none' : 'flex'} flexDirection="column">
            <TerminalView
              key={cmdModeProjectPath}
              projectPath={cmdModeProjectPath}
              onBack={() => setCmdModeProjectPath(null)}
            />
          </Box>
        ) : !showSettings ? (
          <WelcomeHero
            onNewProject={handleNewProject}
            onOpenFolder={handleOpenFolder}
            onCloneRepository={() => cloneDialog.setOpen(true)}
            onCmdMode={handleCmdMode}
          >
            <PromoBanner />
          </WelcomeHero>
        ) : null}

        <CloneDialog dialog={cloneDialog} onCloned={onOpenProject} />

        {/* Non-blocking prereq banner — only shows when a tool is missing/outdated.
            Positioned absolute near the top so it doesn't reflow the hero layout. */}
        {!cmdModeProjectPath && !showSettings && <StartupRequirementsBanner />}
      </Flex>
    </Flex>
  )
}

export default WelcomeScreen
