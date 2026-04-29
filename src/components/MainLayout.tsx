import { memo, useEffect, useMemo } from 'react'
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
import { ErrorBoundary } from './ErrorBoundary'
// RequirementsDialog removed — templates disabled
import SettingsView from './views/SettingsView'
import { useCodeEditorState } from '../hooks/useEditorState'
import { usePermissionStore } from '../stores/permissionStore'
import { devServerManager } from '../services/devServerManager'
import DevServerStatus from './chat/DevServerStatus'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'

function MainLayout() {
  const viewMode = useLayoutStore(s => s.viewMode)
  const isSidebarVisible = useLayoutStore(s => s.isSidebarVisible)
  const isProjectsSidebarVisible = useLayoutStore(s => s.isProjectsSidebarVisible)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const currentProject = useCurrentProject()
  const { handleFileSelect } = useCodeEditorState()

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
      useLayoutStore.getState().clearDevServer()
    }
  }, [currentProject?.path])

  // Cleanup dev server on window close. Flow: preventDefault → run stop()
  // (with 1.5s watchdog) → destroy(). destroy() requires the
  // `core:window:allow-destroy` capability — without it, Tauri 2 rejects
  // silently and the window never closes. Errors are logged, not swallowed,
  // so future regressions surface instead of hiding. Last-resort fallback is
  // `process.exit(0)` which goes through the `process:allow-exit` permission.
  // Calling close() again would re-enter onCloseRequested and infinite-loop.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault()
      try {
        await Promise.race([
          devServerManager.stop(),
          new Promise<void>(resolve => setTimeout(resolve, 1500)),
        ])
      } catch (err) {
        console.warn('[close] stop() failed:', err)
      }
      try {
        await getCurrentWindow().destroy()
      } catch (err) {
        console.error('[close] destroy() failed:', err)
        // Fallback: force-exit the whole process. No infinite loop possible
        // since this kills the Tauri runtime itself.
        try {
          const { exit } = await import('@tauri-apps/plugin-process')
          await exit(0)
        } catch (exitErr) {
          console.error('[close] exit() also failed:', exitErr)
        }
      }
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
            {viewMode === 'settings' && (
              <ErrorBoundary>
                <SettingsView />
              </ErrorBoundary>
            )}
          </Flex>

          {/* Permission dialog - shown above PromptBar when agent needs approval */}
          {/* In preview mode, PermissionDialog is rendered inside PreviewView */}
          {pendingPermission && viewMode !== 'editor' && viewMode !== 'preview' && (
            <PermissionDialog
              toolName={pendingPermission.toolName}
              args={pendingPermission.args}
              promptReason={pendingPermission.promptReason}
              onApprove={() => usePermissionStore.getState().approve()}
              onApproveAll={() => usePermissionStore.getState().approveAll()}
              onDeny={() => usePermissionStore.getState().deny()}
            />
          )}

          {/* PromptBar - hidden in editor, preview, and settings */}
          {viewMode !== 'editor' && viewMode !== 'preview' && viewMode !== 'settings' && <PromptBar />}
        </Flex>
      </Flex>

      {/* Template selector removed — all projects start from scratch */}

      {/* Floating dev server status panel */}
      <DevServerStatus />

      {/* Requirements check dialog removed — templates disabled */}
    </Flex>
  )
}

export default memo(MainLayout)
