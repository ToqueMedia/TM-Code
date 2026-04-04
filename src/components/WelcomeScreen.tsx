import React, { useCallback, useEffect, useState } from 'react'
import { Box, Flex, useDialog } from '@chakra-ui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
// tauriMessage removed — templates disabled
import { useProjectStore } from '../stores/projectStore'
// Template import removed — templates disabled
// environmentCheck removed — templates disabled
// postScaffoldPipeline removed — templates disabled
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { WelcomeSidebar, WelcomeHero, CloneDialog } from './welcome'
// RequirementsDialog removed — templates disabled
// TemplateSelector removed — all projects start from scratch
import SettingsView from './views/SettingsView'
import WindowControls from './ui/WindowControls'
import { IS_MAC } from '@/utils/platform'

interface WelcomeScreenProps {
  onOpenProject: (path?: string, options?: { initGit?: boolean }) => void
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject }) => {
  const cloneDialog = useDialog()
  const { recentProjects, loadRecentProjects } = useProjectStore()
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    loadRecentProjects()
  }, [loadRecentProjects])

  const handleDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'svg', 'path', 'a'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    if (t.closest?.('[data-no-drag]')) return
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  async function handleClose() {
    try { await getCurrentWindow().close() } catch { /* noop */ }
  }

  async function handleMinimize() {
    try { await getCurrentWindow().minimize() } catch { /* noop */ }
  }

  async function handleFullToggle() {
    try {
      const win = getCurrentWindow()
      if (/Mac/.test(navigator.platform || '')) {
        const fs = await win.isFullscreen()
        await win.setFullscreen(!fs)
      } else {
        const isMax = await win.isMaximized()
        if (isMax) await win.unmaximize()
        else await win.maximize()
      }
    } catch { /* noop */ }
  }

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

  // All projects start from scratch — 3 options: New Project, Open Project, Clone Repository.

  return (
    <Flex
      minHeight="100vh"
      bg="#0a0a0a"
      color={tokens.colors.text.primary}
      onMouseDown={handleDrag}
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

      <WelcomeSidebar
        recentProjects={recentProjects}
        onNewProject={handleNewProject}
        onOpenFolder={handleOpenFolder}
        onCloneRepository={() => cloneDialog.setOpen(true)}
        onOpenProject={onOpenProject}
        onSettings={() => setShowSettings(true)}
      />

      {showSettings ? (
        <SettingsView onBack={() => setShowSettings(false)} />
      ) : (
        <WelcomeHero
          onNewProject={handleNewProject}
          onOpenFolder={handleOpenFolder}
          onCloneRepository={() => cloneDialog.setOpen(true)}
        />
      )}

      <CloneDialog dialog={cloneDialog} onCloned={onOpenProject} />
    </Flex>
  )
}

export default WelcomeScreen
