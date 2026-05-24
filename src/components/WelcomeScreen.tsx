import { useCallback, useEffect } from 'react'
import { Box, Flex, useDialog } from '@chakra-ui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useProjectStore } from '../stores/projectStore'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { WelcomeSidebar, WelcomeHero, CloneDialog, StartupRequirementsBanner, WelcomePlanBanner } from './welcome'
import SettingsView from './views/SettingsView'
import WindowControls from './ui/WindowControls'
import { IS_MAC } from '@/utils/platform'
import { TerminalView } from './cmd-mode'
import { useWindowControls } from '../hooks/useWindowControls'
import { WindowTitleManager } from '../utils/windowTitleManager'

interface WelcomeScreenProps {
  onOpenProject: (path?: string, options?: { initGit?: boolean }) => void
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject }) => {
  const cloneDialog = useDialog()
  const { recentProjects, loadRecentProjects, cmdModeProjectPath, cmdModeProjectPaths, setCmdModeProjectPath, removeCmdModePath, clearAllRecent, welcomeScreen, setWelcomeScreen } = useProjectStore()
  const showSettings = welcomeScreen === 'settings'

  // Window controls — shared hook eliminates duplication
  const { handleClose, handleMinimize, handleFullToggle } = useWindowControls()

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

  const handleDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // Walk up the DOM from the click target to determine if the user
    // clicked on an interactive element.  A tag-name allowlist is never
    // complete (Chakra renders <Text> as <span>, <Flex> as <div>), so we
    // also check cursor: pointer which Chakra sets via CSS for every
    // interactive element.
    let el: HTMLElement | null = e.target as HTMLElement
    for (let i = 0; i < 8 && el && el !== e.currentTarget; i++) {
      const tag = el.tagName?.toLowerCase() || ''
      if (['button', 'input', 'svg', 'path', 'a', 'select', 'textarea'].includes(tag)) return
      if (el.getAttribute('role') === 'button') return
      if (el.hasAttribute('data-no-drag')) return
      try {
        if (window.getComputedStyle(el).cursor === 'pointer') return
      } catch { /* getComputedStyle can throw on detached nodes */ }
      el = el.parentElement
    }
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  const handleOpenFolder = async () => {
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
  }

  const handleNewProject = async () => {
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
  }

  const handleCmdMode = async () => {
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
  }

  // 4 options available: New Project, Open Project, Clone Repository, CMD Mode.

  return (
    <Flex
      height="100vh"
      overflow="hidden"
      bg="#0a0a0a"
      color={tokens.colors.text.primary}
      onMouseDown={cmdModeProjectPath ? undefined : handleDrag}
      position="relative"
    >
      {/* Window controls — macOS: top-left, Windows/Linux: top-right */}
      {IS_MAC ? (
        <Box position="absolute" top={3} left={4} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      ) : (
        <Box position="absolute" top={0} right={0} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      )}

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

      {cmdModeProjectPath ? (
        <Box flex="1" minH={0} display="flex" flexDirection="column">
          <TerminalView
            key={cmdModeProjectPath}
            projectPath={cmdModeProjectPath}
            onBack={() => setCmdModeProjectPath(null)}
          />
        </Box>
      ) : showSettings ? (
        <SettingsView onBack={() => setWelcomeScreen('hero')} />
      ) : (
        <WelcomeHero
          onNewProject={handleNewProject}
          onOpenFolder={handleOpenFolder}
          onCloneRepository={() => cloneDialog.setOpen(true)}
          onCmdMode={handleCmdMode}
        >
          <WelcomePlanBanner />
        </WelcomeHero>
      )}

      <CloneDialog dialog={cloneDialog} onCloned={onOpenProject} />

      {/* Non-blocking prereq banner — only shows when a tool is missing/outdated.
          Positioned absolute near the top so it doesn't reflow the hero layout. */}
      {!cmdModeProjectPath && !showSettings && <StartupRequirementsBanner />}
    </Flex>
  )
}

export default WelcomeScreen
