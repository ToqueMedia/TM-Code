import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { Flex, Box } from '@chakra-ui/react'
import { useLayoutStore } from '../../stores/layoutStore'
import { useCurrentProject } from '../../hooks/useProjectState'
import { useCodeEditorState } from '../../hooks/useEditorState'
import { useEditorRepository } from '../../stores/editorStore'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import BottomPanel from '../ui/BottomPanel'
import CommandPalette from '../ui/CommandPalette'
import GoToLineDialog from '../ui/GoToLineDialog'
import StatusBar from '../ui/StatusBar'
import EditorSidebar from './EditorSidebar'
import EditorToolbar, { type SidebarPanel } from './EditorToolbar'
import EmptyEditorState from './EmptyEditorState'
import ExplorerPanel from '../ui/ExplorerPanel'
import ContainersPanel from './ContainersPanel'
import SourceControlPanel from './SourceControlPanel'
import SearchPanel from './SearchPanel'
import SplitEditorLayout from '../editor/SplitEditorLayout'
import { GitService } from '../../services/gitService'
import { tokens } from '@/theme/tokens'

const STORAGE_KEY_BOTTOM_VISIBLE = 'panel-visible-bottom-panel'
const STORAGE_KEY_SIDEBAR_PANEL = 'editor-sidebar-panel'

function EditorView() {
  const currentProject = useCurrentProject()
  const {
    openFiles, activeFile, handleFileSelect
  } = useCodeEditorState()

  const tabSizeSetting = useSettingsStore(s => s.editor.tabSize)
  const insertSpacesSetting = useSettingsStore(s => s.editor.insertSpaces)
  const setInsertSpacesSetting = useSettingsStore(s => s.setInsertSpaces)
  const setTabSizeSetting = useSettingsStore(s => s.setTabSize)
  const detectIndentationSetting = useSettingsStore(s => s.editor.detectIndentation)
  const setDetectIndentationSetting = useSettingsStore(s => s.setDetectIndentation)

  const editorGroups = useEditorRepository(s => s.editorGroups)
  const isRehydrating = useEditorRepository(s => s.isRehydrating)
  // Check both groups and openFiles — during rehydration, groups may be empty while openFiles isn't yet
  const hasOpenFilesInAnyGroup = editorGroups.some(g => g.files.length > 0) || openFiles.length > 0 || isRehydrating

  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 })
  const cursorUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
      if (v === 'sourceControl') return 'sourceControl'
      if (v === 'search') return 'search'
      if (v === 'null' || v === '') return null
      return 'explorer'
    } catch { return 'explorer' }
  })

  const handleCursorPositionChange = useCallback((line: number, column: number) => {
    if (cursorUpdateRef.current) clearTimeout(cursorUpdateRef.current)
    cursorUpdateRef.current = setTimeout(() => {
      setCursorPosition({ line, column })
      if (activeFile) {
        useEditorRepository.getState().setCursorPosition(activeFile, line, column)
      }
    }, 150)
  }, [activeFile])

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

  // Sync Explorer selection with active file
  useEffect(() => {
    if (activeFile) {
      useFileTreeRepository.getState().selectNode(activeFile)
    }
  }, [activeFile])

  useEffect(() => {
    const onLangs = (e: Event) => { const d = (e as CustomEvent<string[]>).detail; if (Array.isArray(d)) setLanguages(d) }
    const onToggle = () => toggleBottomPanel()
    const onOpen = (e: Event) => { const p = (e as CustomEvent<string>).detail; if (p) handleFileSelect(p) }
    const onSidebarToggle = () => setActiveSidebarPanel(prev => {
      const next: SidebarPanel = prev ? null : 'explorer'
      try { localStorage.setItem(STORAGE_KEY_SIDEBAR_PANEL, String(next ?? '')) } catch {}
      return next
    })
    // Split editor event
    const onSplit = () => {
      const store = useEditorRepository.getState()
      if (store.editorGroups.length >= 2) {
        store.unsplitEditor()
      } else {
        store.splitEditor()
      }
    }
    // Open diff view as a tab from Source Control
    const onOpenDiff = async (e: Event) => {
      const { relPath, projectPath: pp } = (e as CustomEvent<{ relPath: string; projectPath: string }>).detail
      if (!relPath || !pp) return
      const fullPath = `${pp}/${relPath}`
      try {
        const originalContent = await GitService.showFile(pp, relPath)
        // Open the file normally first (loads content from disk)
        await useEditorRepository.getState().openFile(fullPath)
        // Then mark it as diff mode
        useEditorRepository.setState(state => {
          const idx = state.openFiles.findIndex(f => f.path === fullPath)
          if (idx === -1) return state
          const files = [...state.openFiles]
          files[idx] = { ...files[idx], diff: { originalContent, relPath } }
          return { openFiles: files }
        })
      } catch {}
    }

    window.addEventListener('monaco:languages', onLangs)
    window.addEventListener('panel:toggle-bottom', onToggle)
    window.addEventListener('editor:open-file', onOpen)
    window.addEventListener('sidebar:toggle', onSidebarToggle)
    window.addEventListener('editor:split', onSplit)
    window.addEventListener('editor:open-diff', onOpenDiff as EventListener)
    return () => {
      window.removeEventListener('monaco:languages', onLangs)
      window.removeEventListener('panel:toggle-bottom', onToggle)
      window.removeEventListener('editor:open-file', onOpen)
      window.removeEventListener('sidebar:toggle', onSidebarToggle)
      window.removeEventListener('editor:split', onSplit)
      window.removeEventListener('editor:open-diff', onOpenDiff as EventListener)
    }
  }, [toggleBottomPanel, handleFileSelect])

  const [bottomSize, setBottomSize] = useState(() =>
    Math.min(250, Math.max(Math.floor(window.innerHeight * 0.15), Math.floor(window.innerHeight * 0.25)))
  )
  const bottomHandleRef = useRef<HTMLDivElement>(null)
  const bottomDragCleanupRef = useRef<(() => void) | null>(null)

  // Cleanup bottom panel drag on unmount
  useEffect(() => {
    return () => { bottomDragCleanupRef.current?.() }
  }, [])

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

        {/* Sidebar — single resizable container for all panels */}
        {activeSidebarPanel && (
          <EditorSidebar onClose={() => handleSelectPanel(null)}>
            {activeSidebarPanel === 'explorer' && (
              <ExplorerPanel onFileSelect={handleFileSelect} />
            )}
            {activeSidebarPanel === 'search' && (
              <SearchPanel />
            )}
            {activeSidebarPanel === 'sourceControl' && (
              <SourceControlPanel />
            )}
            {activeSidebarPanel === 'containers' && (
              <ContainersPanel />
            )}
          </EditorSidebar>
        )}

        {/* Right column: Editor (with split support) + Terminal */}
        <Flex flex="1" direction="column" minW={0}>
          {/* Editor area */}
          <Flex flex="1" overflow="hidden">
            {hasOpenFilesInAnyGroup ? (
              <SplitEditorLayout
                projectPath={currentProject.path}
                onCursorPositionChange={handleCursorPositionChange}
              />
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
            {/* Drag handle — wide hit area (12px) with thin visual line (2px) */}
            {isBottomPanelVisible && (
              <Box
                ref={bottomHandleRef}
                position="absolute"
                top="-6px"
                left="0"
                right="0"
                height="12px"
                cursor="row-resize"
                zIndex={10}
                display="flex"
                alignItems="center"
                justifyContent="center"
                style={{ touchAction: 'none' }}
                _hover={{
                  '& > div': { bg: tokens.colors.accent.primary, opacity: 1 },
                }}
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

                  // Visual feedback during drag
                  const line = handle.querySelector('[data-drag-line]') as HTMLElement | null
                  if (line) { line.style.background = tokens.colors.accent.primary; line.style.opacity = '1' }

                  function cleanup() {
                    try { handle?.releasePointerCapture(pid) } catch {}
                    handle?.removeEventListener('pointermove', onMove)
                    handle?.removeEventListener('pointerup', onUp)
                    body.style.cursor = prevCursor
                    body.style.userSelect = prevSelect
                    if (line) { line.style.background = ''; line.style.opacity = '' }
                    bottomDragCleanupRef.current = null
                  }
                  function onMove(pe: PointerEvent) {
                    const delta = startY - pe.clientY
                    const next = startH + delta
                    if (next < 60) {
                      cleanup()
                      closeBottomPanel()
                      return
                    }
                    const max = Math.floor(window.innerHeight * 0.7)
                    setBottomSize(Math.min(next, max))
                  }
                  function onUp() { cleanup() }
                  bottomDragCleanupRef.current = cleanup
                  handle.addEventListener('pointermove', onMove)
                  handle.addEventListener('pointerup', onUp)
                }}
              >
                <Box
                  data-drag-line
                  w="100%"
                  h="2px"
                  bg="transparent"
                  opacity={0}
                  transition="background 0.15s, opacity 0.15s"
                  borderRadius="1px"
                />
              </Box>
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
      <GoToLineDialog />
    </Flex>
  )
}

export default memo(EditorView)
