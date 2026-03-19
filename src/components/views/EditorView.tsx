import { memo, useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react'
import { Flex, Box } from '@chakra-ui/react'
import { useLayoutStore } from '../../stores/layoutStore'
import { useCurrentProject } from '../../hooks/useProjectState'
import { useCodeEditorState } from '../../hooks/useEditorState'
import { useSettingsStore } from '../../stores/settingsStore'
import EditorTabs from '../ui/EditorTabs'
import Breadcrumbs from '../ui/Breadcrumbs'
import BottomPanel from '../ui/BottomPanel'
import CommandPalette from '../ui/CommandPalette'
import StatusBar from '../ui/StatusBar'
import EditorSidebar from './EditorSidebar'
import EditorToolbar, { type SidebarPanel } from './EditorToolbar'
import EmptyEditorState from './EmptyEditorState'
import ContainersPanel from './ContainersPanel'
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { logger } from '../../utils/logger'
import { tokens } from '@/theme/tokens'

const MonacoEditor = lazy(() => import('../ui/MonacoEditor'))

const STORAGE_KEY_BOTTOM_VISIBLE = 'panel-visible-bottom-panel'
const STORAGE_KEY_SIDEBAR_PANEL = 'editor-sidebar-panel'

const EditorSkeleton = () => (
  <Flex flex={1} align="center" justify="center">
    <LoadingSpinner size="lg" label="Loading editor..." />
  </Flex>
)

function EditorView() {
  const currentProject = useCurrentProject()
  const {
    openFiles, activeFile, handleFileSelect, handleCloseFile, handleSetActiveFile
  } = useCodeEditorState()

  const tabSizeSetting = useSettingsStore(s => s.editor.tabSize)
  const insertSpacesSetting = useSettingsStore(s => s.editor.insertSpaces)
  const setInsertSpacesSetting = useSettingsStore(s => s.setInsertSpaces)
  const setTabSizeSetting = useSettingsStore(s => s.setTabSize)
  const detectIndentationSetting = useSettingsStore(s => s.editor.detectIndentation)
  const setDetectIndentationSetting = useSettingsStore(s => s.setDetectIndentation)

  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 })
  const [languages, setLanguages] = useState<string[]>([])

  const [isBottomPanelVisible, setIsBottomPanelVisible] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY_BOTTOM_VISIBLE)
      return v === null ? true : v === 'true'
    } catch { return true }
  })

  const [activeSidebarPanel, setActiveSidebarPanel] = useState<SidebarPanel>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY_SIDEBAR_PANEL)
      if (v === 'containers') return 'containers'
      if (v === 'null' || v === '') return null
      return 'explorer'
    } catch { return 'explorer' }
  })

  const handleCursorPositionChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column })
  }, [])

  const toggleBottomPanel = useCallback(() => {
    setIsBottomPanelVisible(prev => {
      const next = !prev
      try { localStorage.setItem(STORAGE_KEY_BOTTOM_VISIBLE, String(next)) } catch {}
      return next
    })
  }, [])

  const closeBottomPanel = useCallback(() => {
    setIsBottomPanelVisible(false)
    try { localStorage.setItem(STORAGE_KEY_BOTTOM_VISIBLE, 'false') } catch {}
  }, [])

  const handleSelectPanel = useCallback((panel: SidebarPanel) => {
    setActiveSidebarPanel(panel)
    try { localStorage.setItem(STORAGE_KEY_SIDEBAR_PANEL, String(panel ?? '')) } catch {}
  }, [])

  useEffect(() => {
    const onLangs = (e: Event) => { const d = (e as CustomEvent<string[]>).detail; if (Array.isArray(d)) setLanguages(d) }
    const onToggle = () => toggleBottomPanel()
    const onOpen = (e: Event) => { const p = (e as CustomEvent<string>).detail; if (p) handleFileSelect(p) }
    window.addEventListener('monaco:languages', onLangs)
    window.addEventListener('panel:toggle-bottom', onToggle)
    window.addEventListener('editor:open-file', onOpen)
    return () => {
      window.removeEventListener('monaco:languages', onLangs)
      window.removeEventListener('panel:toggle-bottom', onToggle)
      window.removeEventListener('editor:open-file', onOpen)
    }
  }, [toggleBottomPanel, handleFileSelect])

  const [bottomSize, setBottomSize] = useState(() =>
    Math.min(250, Math.max(Math.floor(window.innerHeight * 0.15), Math.floor(window.innerHeight * 0.25)))
  )
  const bottomHandleRef = useRef<HTMLDivElement>(null)

  if (!currentProject) return null

  return (
    <Flex direction="column" flex="1" overflow="hidden">
      {/* Full-height layout: Toolbar + Sidebar + Editor column */}
      <Flex flex="1" overflow="hidden">
        {/* Left toolbar — full height from top to status bar */}
        <EditorToolbar
          activePanel={activeSidebarPanel}
          isBottomPanelVisible={isBottomPanelVisible}
          onSelectPanel={handleSelectPanel}
          onToggleBottomPanel={toggleBottomPanel}
          onBackToChat={() => useLayoutStore.getState().goBack()}
        />

        {/* Sidebar — full height, never overlapped by terminal */}
        {activeSidebarPanel === 'explorer' && (
          <EditorSidebar
            onFileSelect={handleFileSelect}
            onClose={() => handleSelectPanel(null)}
          />
        )}
        {activeSidebarPanel === 'containers' && (
          <Box
            width="280px"
            bg={tokens.colors.bg.mainLayout}
            borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
            overflow="hidden"
            flexShrink={0}
          >
            <ContainersPanel />
          </Box>
        )}

        {/* Right column: Tabs + Breadcrumbs + Editor + Terminal */}
        <Flex flex="1" direction="column" minW={0}>
          {/* Tabs + Breadcrumbs — only when files are open */}
          {openFiles.length > 0 && (
            <>
              <Box flexShrink={0} borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}>
                <EditorTabs
                  openFiles={openFiles}
                  activeFile={activeFile}
                  onSetActiveFile={handleSetActiveFile}
                  onCloseFile={handleCloseFile}
                />
              </Box>
              <Breadcrumbs
                filePath={activeFile || undefined}
                projectRoot={currentProject.path}
                onNavigate={(path) => logger.debug('editor', 'Navigate to:', path)}
              />
            </>
          )}

          {/* Editor */}
          <Flex flex="1" overflow="hidden">
            {activeFile ? (
              <Suspense fallback={<EditorSkeleton />}>
                <MonacoEditor
                  key={activeFile}
                  path={activeFile}
                  onCursorPositionChange={handleCursorPositionChange}
                />
              </Suspense>
            ) : (
              <EmptyEditorState
                onBackToChat={() => useLayoutStore.getState().goBack()}
                onToggleExplorer={() => handleSelectPanel(activeSidebarPanel === 'explorer' ? null : 'explorer')}
                onToggleTerminal={toggleBottomPanel}
              />
            )}
          </Flex>

          {/* Terminal — inside the right column, drag to resize/close */}
          <Box
            height={isBottomPanelVisible ? `${bottomSize}px` : '0px'}
            bg={tokens.colors.bg.mainLayout}
            position="relative"
            borderTop={isBottomPanelVisible ? `1px solid ${tokens.colors.border.sidebarPanel}` : 'none'}
            overflow="hidden"
            transition={isBottomPanelVisible ? 'none' : 'height 0.2s cubic-bezier(0.4, 0, 0.2, 1)'}
            flexShrink={0}
          >
            {/* Drag handle */}
            {isBottomPanelVisible && (
              <Box
                ref={bottomHandleRef}
                position="absolute"
                top="0"
                left="0"
                right="0"
                height="6px"
                cursor="row-resize"
                zIndex={10}
                bg="transparent"
                _hover={{ bg: tokens.colors.accent.primaryGlow }}
                style={{ touchAction: 'none' }}
                onPointerDown={(e: React.PointerEvent) => {
                  e.preventDefault()
                  const handle = bottomHandleRef.current
                  if (!handle) return
                  const pid = e.pointerId
                  try { handle.setPointerCapture(pid) } catch {}
                  const startY = e.clientY
                  const startH = bottomSize
                  const body = document.body
                  const prevCursor = body.style.cursor
                  const prevSelect = body.style.userSelect
                  body.style.cursor = 'row-resize'
                  body.style.userSelect = 'none'

                  function onMove(pe: PointerEvent) {
                    const delta = startY - pe.clientY
                    const next = startH + delta
                    if (next < 60) {
                      // Close immediately when dragged below threshold
                      try { handle?.releasePointerCapture(pid) } catch {}
                      handle?.removeEventListener('pointermove', onMove)
                      handle?.removeEventListener('pointerup', onUp)
                      body.style.cursor = prevCursor
                      body.style.userSelect = prevSelect
                      closeBottomPanel()
                      return
                    }
                    const max = Math.floor(window.innerHeight * 0.7)
                    setBottomSize(Math.min(next, max))
                  }
                  function onUp() {
                    try { handle?.releasePointerCapture(pid) } catch {}
                    handle?.removeEventListener('pointermove', onMove)
                    handle?.removeEventListener('pointerup', onUp)
                    body.style.cursor = prevCursor
                    body.style.userSelect = prevSelect
                  }
                  handle.addEventListener('pointermove', onMove)
                  handle.addEventListener('pointerup', onUp)
                }}
              />
            )}
            {isBottomPanelVisible && (
              <BottomPanel
                isVisible={isBottomPanelVisible}
                onToggle={toggleBottomPanel}
                onClose={closeBottomPanel}
              />
            )}
          </Box>
        </Flex>
      </Flex>

      <StatusBar
        currentProject={currentProject}
        activeFile={activeFile}
        openFiles={openFiles}
        cursorPosition={cursorPosition}
        languages={languages}
        tabSizeSetting={tabSizeSetting}
        insertSpacesSetting={insertSpacesSetting}
        detectIndentationSetting={detectIndentationSetting}
        setTabSizeSetting={setTabSizeSetting}
        setInsertSpacesSetting={setInsertSpacesSetting}
        setDetectIndentationSetting={setDetectIndentationSetting}
      />

      <CommandPalette />
    </Flex>
  )
}

export default memo(EditorView)
