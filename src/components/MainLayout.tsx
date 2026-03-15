import { memo, useEffect, useMemo } from 'react'
import { Flex, Box } from '@chakra-ui/react'
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
import { ErrorBoundary } from './ErrorBoundary'
import { useCodeEditorState } from '../hooks/useEditorState'
import { usePermissionStore } from '../stores/permissionStore'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'

function MainLayout() {
  const viewMode = useLayoutStore(s => s.viewMode)
  const isSidebarVisible = useLayoutStore(s => s.isSidebarVisible)
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

  // Handle window close
  useEffect(() => {
    const abortController = new AbortController()
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload, { signal: abortController.signal })
    return () => abortController.abort()
  }, [])

  if (!currentProject) return null

  return (
    <Flex
      direction="column"
      height="100vh"
      bg={tokens.colors.bg.mainLayout}
      color={tokens.colors.text.primary}
      overflow="hidden"
      fontFamily={tokens.fontFamily.ui}
    >
      <MinimalTitleBar />

      {/* Content area */}
      <Flex flex="1" overflow="hidden" position="relative">
        {/* Sidebar overlay (file tree) */}
        {isSidebarVisible && (
          <>
            {/* Backdrop */}
            <Box
              position="absolute"
              inset={0}
              bg={tokens.colors.bg.sidebarBackdrop}
              zIndex={19}
              onClick={() => useLayoutStore.getState().toggleSidebar()}
            />
            {/* Sidebar panel */}
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
                // If not in editor view, switch to it
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
        {viewMode === 'chat' && (
          <ErrorBoundary>
            <ChatView />
          </ErrorBoundary>
        )}
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
      {pendingPermission && viewMode !== 'editor' && (
        <PermissionDialog
          toolName={pendingPermission.toolName}
          args={pendingPermission.args}
          onApprove={() => usePermissionStore.getState().approve()}
          onApproveAll={() => usePermissionStore.getState().approveAll()}
          onDeny={() => usePermissionStore.getState().deny()}
        />
      )}

      {/* PromptBar - always visible except in full editor mode */}
      {viewMode !== 'editor' && <PromptBar />}
    </Flex>
  )
}

export default memo(MainLayout)
