import React, { useCallback, useEffect, useState } from 'react'
import { Box, Flex, useDialog } from '@chakra-ui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message as tauriMessage } from '@tauri-apps/plugin-dialog'
import { useProjectStore } from '../stores/projectStore'
import { Template } from '../services/templateService'
import { verifyRequirements, CheckResult } from '../services/environmentCheck'
import { setupScaffoldedProject } from '../services/postScaffoldPipeline'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { WelcomeSidebar, WelcomeHero, CloneDialog } from './welcome'
import { RequirementsDialog } from './dialogs'
import TemplateSelector from './TemplateSelector'
import SettingsView from './views/SettingsView'
import WindowControls from './ui/WindowControls'
import { IS_MAC, TEXT_FILE_EXTENSIONS } from '@/utils/platform'

interface WelcomeScreenProps {
  onOpenProject: (path?: string, options?: { initGit?: boolean }) => void
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenProject }) => {
  const cloneDialog = useDialog()
  const { recentProjects, loadRecentProjects } = useProjectStore()
  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [isScaffolding, setIsScaffolding] = useState(false)

  // Environment requirements check state
  const [requirementsResults, setRequirementsResults] = useState<CheckResult[] | null>(null)
  const [pendingScaffold, setPendingScaffold] = useState<{ template: Template; projectPath: string } | null>(null)

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

  const handleOpenFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: false,
        multiple: false,
        title: 'Open File',
        filters: [{ name: 'Text Files', extensions: TEXT_FILE_EXTENSIONS }],
      })
      if (selected) {
        const filePath = String(selected)
        const sep = filePath.includes('/') ? '/' : '\\'
        const parentDir = filePath.substring(0, filePath.lastIndexOf(sep)) || sep
        // Open parent dir as project, then open the file in editor
        await useProjectStore.getState().openProject(parentDir)
        const { useEditorRepository } = await import('../stores/editorStore')
        const { useLayoutStore } = await import('../stores/layoutStore')
        useEditorRepository.getState().openFile(filePath)
        useLayoutStore.getState().setViewMode('editor')
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open file dialog:', error)
    }
  }

  const handleNewProject = () => {
    setShowTemplateSelector(true)
  }

  const doScaffold = async (template: Template, projectPath: string) => {
    try {
      setIsScaffolding(true)
      await setupScaffoldedProject(template, projectPath)
      setShowTemplateSelector(false)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('ui', 'Failed to scaffold template:', error)
      await tauriMessage(
        `${t('misc.failedCreateProject')}: ${msg}`,
        { title: t('misc.error'), kind: 'error' }
      ).catch(() => {})
    } finally {
      setIsScaffolding(false)
    }
  }

  const handleSelectTemplate = async (template: Template, projectName: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('misc.chooseCreateLocation'),
      })
      if (!selected) return

      const projectPath = `${selected as string}/${projectName}`

      // Check environment requirements before scaffolding
      if (template.requirements && template.requirements.length > 0) {
        const checkResult = await verifyRequirements(template.requirements)

        if (!checkResult.allPassed) {
          setPendingScaffold({ template, projectPath })
          setRequirementsResults(checkResult.results)
          return
        }
      }

      await doScaffold(template, projectPath)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('ui', 'Failed to check requirements:', error)
      await tauriMessage(
        `${t('misc.failedCreateProject')}: ${msg}`,
        { title: t('misc.error'), kind: 'error' }
      ).catch(() => {})
    }
  }

  const handleRequirementsContinue = () => {
    if (pendingScaffold) {
      const { template, projectPath } = pendingScaffold
      setRequirementsResults(null)
      setPendingScaffold(null)
      doScaffold(template, projectPath)
    }
  }

  const handleRequirementsCancel = () => {
    setRequirementsResults(null)
    setPendingScaffold(null)
  }

  const handleSelectEmpty = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('misc.chooseFolder'),
      })
      if (selected) {
        setShowTemplateSelector(false)
        onOpenProject(selected as string, { initGit: true })
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }

  if (showTemplateSelector) {
    return (
      <>
        <TemplateSelector
          onSelectTemplate={handleSelectTemplate}
          onSelectEmpty={handleSelectEmpty}
          onBack={() => setShowTemplateSelector(false)}
          isLoading={isScaffolding}
        />
        {requirementsResults && (
          <RequirementsDialog
            results={requirementsResults}
            onContinue={handleRequirementsContinue}
            onCancel={handleRequirementsCancel}
          />
        )}
      </>
    )
  }

  return (
    <Flex
      minHeight="100vh"
      bg="#0a0a0a"
      color={tokens.colors.text.primary}
      data-tauri-drag-region
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
        onProjectFromScratch={handleSelectEmpty}
        onOpenFolder={handleOpenFolder}
        onOpenFile={handleOpenFile}
        onCloneRepository={() => cloneDialog.setOpen(true)}
        onOpenProject={onOpenProject}
        onSettings={() => setShowSettings(true)}
      />

      {showSettings ? (
        <SettingsView onBack={() => setShowSettings(false)} />
      ) : (
        <WelcomeHero
          onNewProject={handleNewProject}
          onProjectFromScratch={handleSelectEmpty}
          onOpenFolder={handleOpenFolder}
          onCloneRepository={() => cloneDialog.setOpen(true)}
        />
      )}

      <CloneDialog dialog={cloneDialog} onCloned={onOpenProject} />
    </Flex>
  )
}

export default WelcomeScreen
