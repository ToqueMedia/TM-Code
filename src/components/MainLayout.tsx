import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import PlanViewerPanel from './chat/PlanViewerPanel'
import { useTranslation } from '@/i18n'
import ProjectsSidebar from './chat/ProjectsSidebar'
import { ErrorBoundary } from './ErrorBoundary'

import SettingsView from './views/SettingsView'
import DataViewerView from './views/DataViewerView'
import { useCodeEditorState } from '../hooks/useEditorState'
import { usePermissionStore } from '../stores/permissionStore'
import { devServerManager } from '../services/devServerManager'
import DevServerStatus from './chat/DevServerStatus'
import PublishModal from './dialogs/PublishModal'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'

function MainLayout() {
  const t = useTranslation()
  const viewMode = useLayoutStore(s => s.viewMode)
  const isSidebarVisible = useLayoutStore(s => s.isSidebarVisible)
  const isProjectsSidebarVisible = useLayoutStore(s => s.isProjectsSidebarVisible)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const approve = usePermissionStore(s => s.approve)
  const approveAlwaysInProject = usePermissionStore(s => s.approveAlwaysInProject)
  const approveAlwaysGlobal = usePermissionStore(s => s.approveAlwaysGlobal)
  const deny = usePermissionStore(s => s.deny)
  const denyWith = usePermissionStore(s => s.denyWith)
  const currentProject = useCurrentProject()
  const { handleFileSelect } = useCodeEditorState()

  // Sticky-mount the Preview view from the first time it's opened. After
  // that toggling views is a CSS display flip, not unmount/remount — the
  // mount cost (1400-LOC component + Tauri webview boot) happens once per
  // session. The "tudo escuro" regression from a previous attempt is now
  // masked by an explicit activation overlay inside PreviewView itself
  // (see `showActivationOverlay` over the iframe region) so the NSView's
  // few-frame reposition gap is no longer visible.
  const [previewMounted, setPreviewMounted] = useState(viewMode === 'preview')
  useEffect(() => {
    if (viewMode === 'preview' && !previewMounted) setPreviewMounted(true)
  }, [viewMode, previewMounted])

  // Chat panel width when preview is active (resizable, persisted)
  const MIN_CHAT_W = 320
  const MAX_CHAT_W = 640
  const DEFAULT_CHAT_W = 380
  const [previewChatWidth, setPreviewChatWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('main-chat-panel-width')
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_CHAT_W && parsed <= MAX_CHAT_W) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_CHAT_W
  })
  const [isResizing, setIsResizing] = useState(false)
  const resizeHandleRef = useRef<HTMLDivElement>(null)

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handleEl = resizeHandleRef.current
    if (!handleEl) return
    const pid = e.pointerId
    try { handleEl.setPointerCapture(pid) } catch { /* ignore */ }
    let current = previewChatWidth
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'
    setIsResizing(true)
    function onPointerMove(pe: PointerEvent) {
      let next = pe.clientX
      if (next < MIN_CHAT_W) next = MIN_CHAT_W
      if (next > MAX_CHAT_W) next = MAX_CHAT_W
      current = next
      setPreviewChatWidth(next)
    }
    function onPointerUp() {
      try { localStorage.setItem('main-chat-panel-width', String(current)) } catch { /* ignore */ }
      try { handleEl?.releasePointerCapture(pid) } catch { /* ignore */ }
      handleEl?.removeEventListener('pointermove', onPointerMove)
      handleEl?.removeEventListener('pointerup', onPointerUp)
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
      setIsResizing(false)
    }
    handleEl.addEventListener('pointermove', onPointerMove)
    handleEl.addEventListener('pointerup', onPointerUp)
  }, [previewChatWidth])

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
      const isShift = e.shiftKey
      const isAlt = e.altKey
      const key = e.key ? e.key.toLowerCase() : ''

      // Block default Safari/Chrome browser actions that disrupt the standalone IDE app experience:

      // 1. Reload page: Cmd+R, Ctrl+R, Cmd+Shift+R, Ctrl+Shift+R, F5
      if ((isMeta && key === 'r') || e.key === 'F5') {
        e.preventDefault()
        return
      }

      // 2. Print page: Cmd+P, Ctrl+P
      if (isMeta && key === 'p' && !isShift && !isAlt) {
        e.preventDefault()
        return
      }

      // 3. Save page: Cmd+S, Ctrl+S (avoid native browser html saving)
      if (isMeta && key === 's' && !isShift && !isAlt) {
        e.preventDefault()
        const editorRepo = useEditorRepository.getState()
        if (editorRepo.activeFile) {
          editorRepo.saveFile(editorRepo.activeFile).catch(() => {})
        }
        return
      }

      // 4. Back/Forward Navigation: Cmd+[, Cmd+], Alt+ArrowLeft, Alt+ArrowRight
      if (
        (isMeta && (e.key === '[' || e.key === ']')) ||
        (isAlt && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
      ) {
        const tag = document.activeElement?.tagName.toLowerCase()
        const isEditable = tag === 'input' || tag === 'textarea' || document.activeElement?.hasAttribute('contenteditable')
        if (isMeta && (e.key === '[' || e.key === ']')) {
          e.preventDefault()
          return
        } else if (!isEditable) {
          e.preventDefault()
          return
        }
      }

      // 5. New Tab/Window / Open File: Cmd+T, Ctrl+T, Cmd+N, Ctrl+N, Cmd+O, Ctrl+O
      if (isMeta && (key === 't' || key === 'n' || key === 'o') && !isShift && !isAlt) {
        e.preventDefault()
        return
      }

      // 6. Close Window/Tab: Cmd+W, Ctrl+W
      if (isMeta && key === 'w' && !isShift && !isAlt) {
        e.preventDefault()
        return
      }

      // 7. Find in Page (browser default search widget): Cmd+F, Ctrl+F
      if (isMeta && key === 'f' && !isShift && !isAlt) {
        const isInsideMonaco = document.activeElement?.closest('.monaco-editor')
        if (!isInsideMonaco) {
          e.preventDefault()
          return
        }
      }

      // 8. Focus Address Bar: Cmd+L, Ctrl+L, F6
      if (isMeta && key === 'l' && !isShift && !isAlt) {
        e.preventDefault()
        return
      }
      if (e.key === 'F6') {
        e.preventDefault()
        return
      }

      // 9. DevTools: Cmd+Alt+I (macOS), Ctrl+Shift+I (Windows/Linux), F12 (All)
      if (
        (isMeta && isAlt && key === 'i') ||
        (isMeta && isShift && key === 'i') ||
        e.key === 'F12'
      ) {
        e.preventDefault()
        return
      }

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

      // Cmd+Shift+B: Toggle Data Viewer ("B for Browse"). Mirrors the
      // editor toggle's shape — entering when not in `data`, going back
      // when already there. Keeps the existing chat-header FiDatabase
      // button as the discoverable entry; this is the power-user path.
      if (isMeta && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        const layout = useLayoutStore.getState()
        if (layout.viewMode === 'data') {
          layout.goBack()
        } else {
          layout.setViewMode('data')
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
              transition={{ duration: 0.18, ease: 'easeOut' }}
              style={{ overflow: 'hidden', flexShrink: 0, height: '100%' }}
            >
              <ProjectsSidebar />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content + prompt area — row flex with PlanViewerPanel on the right.
            The column wrapper holds content + prompt; the plan panel is a
            sibling so it pushes BOTH the content and the prompt bar. */}
        <Flex flex="1" minH={0} overflow="hidden">
          {/* Column: content area + prompt bar */}
          <Flex direction="column" flex="1" minW={0} minH={0} overflow="hidden">
            {/* Content area */}
            <Flex flex="1" minH={0} overflow="hidden" position="relative">
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
              <Box flex="1" minW={0} overflow="hidden" display="flex" flexDirection="column">
                {viewMode === 'editor' ? (
                  <ErrorBoundary>
                    <EditorView />
                  </ErrorBoundary>
                ) : viewMode === 'settings' ? (
                  <ErrorBoundary>
                    <SettingsView />
                  </ErrorBoundary>
                ) : viewMode === 'data' ? (
                  <ErrorBoundary>
                    <DataViewerView />
                  </ErrorBoundary>
                ) : viewMode === 'generating' && !previewMounted ? (
                  <ErrorBoundary>
                    <GeneratingView />
                  </ErrorBoundary>
                ) : (
                  <Flex flex="1" overflow="hidden">
                    <Box
                      w={viewMode === 'preview' ? `${previewChatWidth}px` : '100%'}
                      h="100%"
                      flexShrink={0}
                      overflow="hidden"
                      display="flex"
                      flexDirection="column"
                      transition={isResizing ? 'none' : 'width 0.3s ease'}
                    >
                      <ErrorBoundary>
                        <ChatView />
                      </ErrorBoundary>
                      {viewMode === 'preview' && (
                        pendingPermission ? (
                          <PermissionDialog
                            toolName={pendingPermission.toolName}
                            args={pendingPermission.args}
                            promptReason={pendingPermission.promptReason ?? null}
                            pathAccessTarget={pendingPermission.pathAccessTarget}
                            approve={approve}
                            approveAlwaysInProject={approveAlwaysInProject}
                            approveAlwaysGlobal={approveAlwaysGlobal}
                            deny={deny}
                            denyWith={denyWith}
                          />
                        ) : (
                          <PromptBar />
                        )
                      )}
                    </Box>
                    {viewMode === 'preview' && (
                      <Box
                        ref={resizeHandleRef}
                        role="separator"
                        aria-label={t('mainLayout.resizeChat')}
                        aria-orientation="vertical"
                        w="4px"
                        cursor="col-resize"
                        flexShrink={0}
                        bg={isResizing ? tokens.colors.accent.primary : 'transparent'}
                        transition={isResizing ? 'none' : 'background 0.15s ease'}
                        _hover={{ bg: tokens.colors.accent.primary }}
                        onPointerDown={handleResizeStart}
                        position="relative"
                        zIndex={2}
                      />
                    )}
                    <AnimatePresence>
                      {viewMode === 'preview' && (
                        <motion.div
                          key="preview-pane"
                          style={{ flex: 1, overflow: 'hidden', display: 'flex' }}
                          initial={{ opacity: 0, x: 40 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 40 }}
                          transition={{ duration: 0.25, ease: 'easeOut' }}
                        >
                          <ErrorBoundary>
                            <PreviewView />
                          </ErrorBoundary>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </Flex>
                )}
              </Box>
            </Flex>

            {/* Permission dialog / PromptBar — in preview mode, rendered inside the chat sidebar wrapper */}
            {viewMode !== 'editor' && viewMode !== 'preview' && viewMode !== 'settings' && viewMode !== 'data' && (
              pendingPermission ? (
                <PermissionDialog
                  toolName={pendingPermission.toolName}
                  args={pendingPermission.args}
                  promptReason={pendingPermission.promptReason ?? null}
                  pathAccessTarget={pendingPermission.pathAccessTarget}
                  approve={approve}
                  approveAlwaysInProject={approveAlwaysInProject}
                  approveAlwaysGlobal={approveAlwaysGlobal}
                  deny={deny}
                  denyWith={denyWith}
                />
              ) : (
                <PromptBar />
              )
            )}
          </Flex>

          {/* Plan Viewer side panel — 600px, full height, pushes everything left */}
          <PlanViewerPanel />
        </Flex>
      </Flex>

      {/* Template selector removed — all projects start from scratch */}

      {/* Floating dev server status panel */}
      <DevServerStatus />

      {/* Publish modal — single mount; trigger via layoutStore.setPublishModalOpen */}
      <PublishModalMount />

      {/* Requirements check dialog removed — templates disabled */}
    </Flex>
  )
}

/**
 * Thin wrapper so MainLayout doesn't re-render when only the modal-open
 * flag flips. Subscribes to just the boolean and the close action.
 */
function PublishModalMount() {
  const isOpen = useLayoutStore((s) => s.isPublishModalOpen)
  const setOpen = useLayoutStore((s) => s.setPublishModalOpen)
  return <PublishModal isOpen={isOpen} onClose={() => setOpen(false)} />
}

export default memo(MainLayout)
