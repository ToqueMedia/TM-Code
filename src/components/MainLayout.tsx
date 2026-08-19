import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Flex, Box } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useLayoutStore, VIEWS_WITHOUT_DIFF_BAR } from '../stores/layoutStore'
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
import DiffApprovalPanel from './chat/DiffApprovalPanel'
import PlanViewerPanel from './chat/PlanViewerPanel'
import CheckpointDrawerPanel from './chat/CheckpointDrawerPanel'
import TerminalDrawerPanel from './cmd-mode/TerminalDrawerPanel'
import { useTranslation } from '@/i18n'
import { ErrorBoundary } from './ErrorBoundary'

import SettingsView from './views/SettingsView'
import { useCodeEditorState } from '../hooks/useEditorState'
import { usePermissionStore } from '../stores/permissionStore'
import { useChatStore } from '../stores/chatStore'
import { useBillingStore, isTeamCollabActive } from '../stores/billingStore'
import { devServerManager } from '../services/devServerManager'
import { closePreviewWebview } from './ui/TauriWebview'
import DevServerStatus from './chat/DevServerStatus'
import { TeamChatPanel } from './collab/TeamChatPanel'
import { ScreenShareViewer } from './collab/ScreenShareViewer'
import { logger } from '../utils/logger'
import { tokens } from '@/theme/tokens'
import { isAgentBusyNow } from '../utils/agentBusy'
import MonacoBridge from '../utils/monacoBridge'

interface MainLayoutProps {
  embedded?: boolean
}

function MainLayout({ embedded = false }: MainLayoutProps) {
  const t = useTranslation()
  // NB: the collab session lifecycle is driven by useCollabSession() in the
  // always-mounted WelcomeScreen shell — NOT here. MainLayout unmounts on every
  // project switch / Settings open / loading spinner, and driving the session
  // from here tore down chat, voice calls, screen share and preview sharing on
  // each of those IDE operations. The team collaboration must survive them.
  const viewMode = useLayoutStore(s => s.viewMode)
  const isPreviewFullscreen = useLayoutStore(s => s.isPreviewFullscreen)
  const isSidebarVisible = useLayoutStore(s => s.isSidebarVisible)
  // Team chat drawer only exists while the team plan is active — unmounts (not
  // just hides) when the plan expires, so nothing team-related lingers.
  const teamCollabActive = useBillingStore(isTeamCollabActive)
  const previewFillsWorkspace = embedded && viewMode === 'preview'
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const approve = usePermissionStore(s => s.approve)
  const approveAlwaysInProject = usePermissionStore(s => s.approveAlwaysInProject)
  const approveAlwaysGlobal = usePermissionStore(s => s.approveAlwaysGlobal)
  const deny = usePermissionStore(s => s.deny)
  const denyWith = usePermissionStore(s => s.denyWith)
  // Batch diff approval: a barra ACOMPANHA o PromptBar enquanto houver diffs
  // pendentes (prioridade abaixo do PermissionDialog — responder à permissão
  // desbloqueia a produção do resto do lote). Não o substitui: rever um lote
  // é uma sessão de revisão, e quem revê quer poder escrever ao agente no
  // mesmo momento — a mensagem fica na fila e é drenada no turn boundary,
  // logo a seguir à decisão do lote. Ver DiffApprovalPanel.
  const hasPendingDiffs = useChatStore(s => s.pendingDiffs.length > 0)
  const isEmptyChat = useChatStore(s => {
    if (s.isLoadingSession) return false
    const id = s.activeSessionId
    if (!id) return true
    return (s.sessions.get(id)?.messages.length ?? 0) === 0
  })
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
        const currentEditor = MonacoBridge.getInstance().getCurrentEditor()
        const saveAction = currentEditor?.getAction('tmcode.save')
        if (saveAction) {
          saveAction.run().catch(() => {})
          return
        }
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
        } else if (!isAgentBusyNow()) {
          // Mesmo bloqueio do botão "Código-fonte" no PromptActions: com o
          // agente a trabalhar, ENTRAR no editor é que está vedado — SAIR
          // (o ramo acima) nunca. Sem esta guarda o atalho contornava o
          // botão desativado e a UI de aprovação de diffs (que só existe
          // nas vistas chat/preview) ficava inalcançável a meio do run.
          layout.setViewMode('editor')
        }
      }

    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // F5 multi-slot: never stop/clear the dev server from MainLayout lifecycle.
  // WelcomeScreen swaps MainLayout out for a spinner while openProject runs
  // (and for Settings), so unmount is NOT "leave project". Process lifecycle
  // is owned by projectStore (park on switch, stopAll on close) and the
  // window onCloseRequested handler below.
  //
  // We only close the native preview webview on unmount so a ghost WKWebView
  // does not keep retrying the previous project's URL while the spinner shows.
  useEffect(() => {
    return () => {
      closePreviewWebview()
    }
  }, [])

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

  const chatComposer = pendingPermission ? (
    <PermissionDialog
      toolName={pendingPermission.toolName}
      args={pendingPermission.args}
      promptReason={pendingPermission.promptReason ?? null}
      pathAccessTarget={pendingPermission.pathAccessTarget}
      originLabel={pendingPermission.origin?.label}
      approve={approve}
      approveAlwaysInProject={approveAlwaysInProject}
      approveAlwaysGlobal={approveAlwaysGlobal}
      deny={deny}
      denyWith={denyWith}
    />
  ) : (
    <>
      {hasPendingDiffs && (viewMode === 'preview' || !VIEWS_WITHOUT_DIFF_BAR.has(viewMode)) && (
        <DiffApprovalPanel />
      )}
      <PromptBar placement={isEmptyChat ? 'centered' : 'docked'} />
    </>
  )
  const chatViewVisible = viewMode !== 'editor' && viewMode !== 'settings' && !(viewMode === 'generating' && !previewMounted)

  if (!currentProject) {
    if (!embedded) return null
    return (
      <Flex
        direction="column"
        flex="1"
        width="100%"
        height="100%"
        bg="transparent"
        color={tokens.colors.text.primary}
        overflow="hidden"
        fontFamily={tokens.fontFamily.ui}
        position="relative"
      >
        <ChatView composer={chatComposer} />
      </Flex>
    )
  }

  return (
    <Flex
      direction="column"
      flex={embedded ? '1' : undefined}
      width="100%"
      height={embedded ? '100%' : '100vh'}
      bg="transparent"
      color={tokens.colors.text.primary}
      overflow="hidden"
      fontFamily={tokens.fontFamily.ui}
      position="relative"
    >
      {!embedded && <MinimalTitleBar />}

      {/* Main area below title bar: chat row on top, terminal docked at the
          bottom (VS Code / Cursor). The terminal used to be a right-hand
          drawer and stole width from the transcript. */}
      <Flex flex="1" direction="column" overflow="hidden">

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
                ) : viewMode === 'generating' && !previewMounted ? (
                  <ErrorBoundary>
                    <GeneratingView />
                  </ErrorBoundary>
                ) : (
                  <Flex flex="1" overflow="hidden">
                    <Box
                      w={previewFillsWorkspace ? '0px' : viewMode === 'preview'
                        ? (isPreviewFullscreen ? '0px' : `${previewChatWidth}px`)
                        : '100%'}
                      h="100%"
                      flexShrink={0}
                      overflow="hidden"
                      display={previewFillsWorkspace ? 'none' : 'flex'}
                      flexDirection="column"
                      // Width snaps (no transition) — same policy as the side
                      // drawers: animating this column's width re-wraps the
                      // agent transcript on every frame (text wobble).
                    >
                      <ErrorBoundary>
                        <ChatView composer={chatComposer} />
                      </ErrorBoundary>
                    </Box>
                    {viewMode === 'preview' && !isPreviewFullscreen && !previewFillsWorkspace && (
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

            {/* PromptBar vive dentro do ChatView (centrado no empty state,
                a descer para o fundo na 1ª mensagem). GeneratingView não
                monta ChatView — a barra fica aqui. */}
            {!chatViewVisible && viewMode !== 'editor' && viewMode !== 'preview' && viewMode !== 'settings' && (
              chatComposer
            )}
          </Flex>

          {/* Plan Viewer side panel — 600px, full height, pushes everything left */}
          <PlanViewerPanel />
          <CheckpointDrawerPanel />
          {/* Ephemeral team chat (P2P) — drawer like the terminal, toggled
              from the Source Control header. Only while the team plan is active. */}
          {teamCollabActive && <TeamChatPanel />}
        </Flex>
        <TerminalDrawerPanel />
      </Flex>

      {/* Template selector removed — all projects start from scratch */}

      {/* Floating dev server status panel */}
      <DevServerStatus />

      {/* Teammate screen-share viewer (P2P video) — shows while watching;
          stays floating/draggable on purpose (it is a video window). */}
      <ScreenShareViewer />

      {/* Requirements check dialog removed — templates disabled */}
    </Flex>
  )
}

export default memo(MainLayout)
