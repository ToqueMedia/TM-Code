import { memo, useEffect, useMemo, useState } from 'react'
import { Flex, Box } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useLayoutStore } from '../stores/layoutStore'
import { useCurrentProject } from '../hooks/useProjectState'
import { useProjectStore, autoSaveProjectState } from '../stores/projectStore'
import { useEditorRepository } from '../stores/editorStore'
import TypeScriptLspService from '../services/typescriptLspService'
import RecoveryService from '../services/recoveryService'
import WindowService from '../services/windowService'
import ExplorerPanel from './ui/ExplorerPanel'
import MinimalTitleBar from './MinimalTitleBar'
import PromptBar from './PromptBar'
import ChatView from './views/ChatView'
import GeneratingView from './views/GeneratingView'
import PreviewView from './views/PreviewView'
import EditorView from './views/EditorView'
import PermissionDialog from './chat/PermissionDialog'
import ProjectsSidebar from './chat/ProjectsSidebar'
import TemplateSelector from './TemplateSelector'
import { ErrorBoundary } from './ErrorBoundary'
import { RequirementsDialog } from './dialogs'
import { useCodeEditorState } from '../hooks/useEditorState'
import { usePermissionStore } from '../stores/permissionStore'
import { Template } from '../services/templateService'
import { verifyRequirements, CheckResult } from '../services/environmentCheck'
import { setupScaffoldedProject } from '../services/postScaffoldPipeline'
import { devServerManager } from '../services/devServerManager'
import { message as tauriMessage } from '@tauri-apps/plugin-dialog'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'

function MainLayout() {
  const viewMode = useLayoutStore(s => s.viewMode)
  const isSidebarVisible = useLayoutStore(s => s.isSidebarVisible)
  const isProjectsSidebarVisible = useLayoutStore(s => s.isProjectsSidebarVisible)
  const showTemplateSelector = useLayoutStore(s => s.showTemplateSelector)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const currentProject = useCurrentProject()
  const { handleFileSelect } = useCodeEditorState()
  const [isScaffolding, setIsScaffolding] = useState(false)

  // Environment requirements check state
  const [requirementsResults, setRequirementsResults] = useState<CheckResult[] | null>(null)
  const [pendingScaffold, setPendingScaffold] = useState<{ template: Template; projectPath: string } | null>(null)

  const doScaffold = async (template: Template, projectPath: string) => {
    try {
      setIsScaffolding(true)
      await setupScaffoldedProject(template, projectPath)
      useLayoutStore.getState().setShowTemplateSelector(false)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('ui', 'Failed to scaffold template:', error)
      await tauriMessage(`Failed to create project: ${msg}`, { title: 'Error', kind: 'error' }).catch(() => {})
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
        title: 'Choose where to create the project',
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
      await tauriMessage(`Failed to create project: ${msg}`, { title: 'Error', kind: 'error' }).catch(() => {})
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
        title: 'Choose a folder for your new project',
      })
      if (selected) {
        useLayoutStore.getState().setShowTemplateSelector(false)
        await useProjectStore.getState().openProject(selected as string)
        // Session creation is handled by App.tsx's useEffect on currentProject change
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }

  // Initialize services
  const lspServiceRef = useMemo(() => TypeScriptLspService.getInstance(), [])
  const recoveryServiceRef = useMemo(() => RecoveryService.getInstance(), [])
  const windowServiceRef = useMemo(() => WindowService.getInstance(), [])

  useEffect(() => {
    if (!currentProject) {
      lspServiceRef.reset()
      recoveryServiceRef.stopRecoveryMonitoring()
      windowServiceRef.reset()
      return
    }

    const abortController = new AbortController()

    const initializeServices = async () => {
      try {
        await lspServiceRef.initialize(currentProject.path)
        recoveryServiceRef.startRecoveryMonitoring()
        await windowServiceRef.initialize()
      } catch (error) {
        logger.error('editor', 'Failed to initialize services:', error)
      }
    }

    initializeServices()

    const handleWindowStateChange = (event: CustomEvent) => {
      if (!abortController.signal.aborted) {
        useProjectStore.getState().setWindowState(event.detail)
      }
    }

    window.addEventListener('windowStateChange', handleWindowStateChange as EventListener, { signal: abortController.signal })

    return () => {
      abortController.abort()
      lspServiceRef.reset()
      recoveryServiceRef.stopRecoveryMonitoring()
      windowServiceRef.reset()
    }
  }, [currentProject, lspServiceRef, recoveryServiceRef, windowServiceRef])

  // Save project state periodically
  useEffect(() => {
    if (!currentProject) return
    const unsubscribe = useEditorRepository.subscribe(() => {
      autoSaveProjectState()
    })
    return unsubscribe
  }, [currentProject])

  // Keyboard shortcuts: Cmd+B for sidebar, Cmd+Shift+E for editor
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey

      // Cmd+B: Toggle sidebar
      if (isMeta && e.key === 'b' && !e.shiftKey) {
        e.preventDefault()
        useLayoutStore.getState().toggleSidebar()
      }

      // Cmd+Shift+E: Toggle editor
      if (isMeta && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        const layout = useLayoutStore.getState()
        if (layout.viewMode === 'editor') {
          layout.goBack()
        } else {
          layout.setViewMode('editor')
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Stop dev server when project changes
  useEffect(() => {
    return () => {
      devServerManager.stop().catch(() => {})
      useLayoutStore.getState().clearPreviewServer()
    }
  }, [currentProject?.path])

  // Cleanup dev server on window close (Tauri event — awaits async cleanup)
  useEffect(() => {
    let unlisten: (() => void) | undefined
    getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault()
      await devServerManager.stop().catch(() => {})
      await getCurrentWindow().destroy()
    }).then(fn => { unlisten = fn })

    return () => unlisten?.()
  }, [])

  if (!currentProject) return null

  return (
    <Flex
      direction="column"
      height="100vh"
      bg="transparent"
      color={tokens.colors.text.primary}
      overflow="hidden"
      fontFamily={tokens.fontFamily.ui}
    >
      <MinimalTitleBar />

      {/* Main area below title bar: optional projects sidebar + content column */}
      <Flex flex="1" overflow="hidden">
        {/* Projects sidebar — full height from title bar to bottom */}
        <AnimatePresence>
          {isProjectsSidebarVisible && viewMode !== 'editor' && (
            <motion.div
              key="projects-sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 240, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden', flexShrink: 0, height: '100%' }}
            >
              <ProjectsSidebar />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content + prompt column */}
        <Flex direction="column" flex="1" overflow="hidden">
          {/* Content area */}
          <Flex flex="1" overflow="hidden" position="relative">
            {/* Sidebar overlay (file tree) */}
            {isSidebarVisible && (
              <>
                <Box
                  position="absolute"
                  inset={0}
                  bg={tokens.colors.bg.sidebarBackdrop}
                  zIndex={19}
                  onClick={() => useLayoutStore.getState().toggleSidebar()}
                />
                <Box
                  position="absolute"
                  left={0}
                  top={0}
                  bottom={0}
                  width="260px"
                  bg={tokens.colors.bg.mainLayout}
                  borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
                  zIndex={20}
                  boxShadow={tokens.shadow.sidebarOverlay}
                  css={{
                    animation: 'slideIn 0.2s ease-out',
                    '@keyframes slideIn': {
                      from: { transform: 'translateX(-100%)' },
                      to: { transform: 'translateX(0)' },
                    },
                  }}
                >
                  <ExplorerPanel onFileSelect={(path) => {
                    handleFileSelect(path)
                    const layout = useLayoutStore.getState()
                    if (layout.viewMode !== 'editor') {
                      layout.setViewMode('editor')
                    }
                    layout.toggleSidebar()
                  }} />
                </Box>
              </>
            )}

            {/* Main view content */}
            {/* ChatView stays mounted (hidden via CSS) to preserve session, messages and scroll position */}
            <Box display={viewMode === 'chat' ? 'flex' : 'none'} flex="1" overflow="hidden">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </Box>
            {viewMode === 'generating' && (
              <ErrorBoundary>
                <GeneratingView />
              </ErrorBoundary>
            )}
            {viewMode === 'preview' && (
              <ErrorBoundary>
                <PreviewView />
              </ErrorBoundary>
            )}
            {viewMode === 'editor' && (
              <ErrorBoundary>
                <EditorView />
              </ErrorBoundary>
            )}
          </Flex>

          {/* Permission dialog - shown above PromptBar when agent needs approval */}
          {/* In preview mode, PermissionDialog is rendered inside PreviewView */}
          {pendingPermission && viewMode !== 'editor' && viewMode !== 'preview' && (
            <PermissionDialog
              toolName={pendingPermission.toolName}
              args={pendingPermission.args}
              sensitive={pendingPermission.sensitive}
              onApprove={() => usePermissionStore.getState().approve()}
              onApproveAll={() => usePermissionStore.getState().approveAll()}
              onDeny={() => usePermissionStore.getState().deny()}
            />
          )}

          {/* PromptBar - hidden in editor and preview (preview has its own) */}
          {viewMode !== 'editor' && viewMode !== 'preview' && <PromptBar />}
        </Flex>
      </Flex>

      {/* Template selector overlay */}
      {showTemplateSelector && (
        <TemplateSelector
          onSelectTemplate={handleSelectTemplate}
          onSelectEmpty={handleSelectEmpty}
          onBack={() => useLayoutStore.getState().setShowTemplateSelector(false)}
          isLoading={isScaffolding}
        />
      )}

      {/* Requirements check dialog */}
      {requirementsResults && (
        <RequirementsDialog
          results={requirementsResults}
          onContinue={handleRequirementsContinue}
          onCancel={handleRequirementsCancel}
        />
      )}
    </Flex>
  )
}

export default memo(MainLayout)
