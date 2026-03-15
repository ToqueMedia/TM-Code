import { memo, useState, useEffect, useCallback, Suspense, lazy } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiArrowLeft } from 'react-icons/fi'
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
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { logger } from '../../utils/logger'
import { tokens } from '@/theme/tokens'

const MonacoEditor = lazy(() => import('../ui/MonacoEditor'))

const STORAGE_KEY_BOTTOM_VISIBLE = 'panel-visible-bottom-panel'

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
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)

  const [isBottomPanelVisible, setIsBottomPanelVisible] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY_BOTTOM_VISIBLE)
      return v === null ? true : v === 'true'
    } catch { return true }
  })

  const handleCursorPositionChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column })
  }, [])

  const toggleBottomPanel = useCallback(() => {
    setIsBottomPanelVisible(prev => {
      const newValue = !prev
      try { localStorage.setItem(STORAGE_KEY_BOTTOM_VISIBLE, String(newValue)) } catch {}
      return newValue
    })
  }, [])

  const closeBottomPanel = useCallback(() => {
    setIsBottomPanelVisible(false)
    try { localStorage.setItem(STORAGE_KEY_BOTTOM_VISIBLE, 'false') } catch {}
  }, [])

  useEffect(() => {
    const onLangs = (e: Event) => { const d = (e as CustomEvent<string[]>).detail; if (Array.isArray(d)) setLanguages(d) }
    const onResize = () => setWindowHeight(window.innerHeight)
    const onToggle = () => toggleBottomPanel()
    const onOpen = (e: Event) => { const p = (e as CustomEvent<string>).detail; if (p) handleFileSelect(p) }
    window.addEventListener('monaco:languages', onLangs)
    window.addEventListener('resize', onResize)
    window.addEventListener('panel:toggle-bottom', onToggle)
    window.addEventListener('editor:open-file', onOpen)
    return () => {
      window.removeEventListener('monaco:languages', onLangs)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('panel:toggle-bottom', onToggle)
      window.removeEventListener('editor:open-file', onOpen)
    }
  }, [toggleBottomPanel, handleFileSelect])

  const bottomMinSize = Math.floor(windowHeight * 0.15)
  const bottomDefaultSize = Math.min(250, Math.max(bottomMinSize, Math.floor(windowHeight * 0.25)))

  if (!currentProject) return null

  return (
    <Flex direction="column" flex="1" overflow="hidden">
      {/* Back button bar */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py={1.5}
        bg={tokens.colors.bg.panel}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        flexShrink={0}
      >
        <Box
          as="button"
          display="flex"
          alignItems="center"
          gap={1.5}
          px={2}
          py={1}
          borderRadius="6px"
          color={tokens.colors.text.secondary}
          fontSize={tokens.fontSize.sm}
          cursor="pointer"
          transition={`all ${tokens.transition.fast}`}
          _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
          onClick={() => useLayoutStore.getState().goBack()}
        >
          <FiArrowLeft size={14} />
          Back to Chat
        </Box>

        <Box flex="1" overflow="hidden">
          <EditorTabs
            openFiles={openFiles}
            activeFile={activeFile}
            onSetActiveFile={handleSetActiveFile}
            onCloseFile={handleCloseFile}
          />
        </Box>
      </Flex>

      {/* Main editor area */}
      <Flex flex="1" overflow="hidden">
        <EditorSidebar onFileSelect={handleFileSelect} />

        {/* Editor content */}
        <Flex flex="1" direction="column" minW={0}>
          <Breadcrumbs
            filePath={activeFile || undefined}
            projectRoot={currentProject.path}
            onNavigate={(path) => logger.debug('editor', 'Navigate to:', path)}
          />

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
              <Flex flex="1" align="center" justify="center" direction="column" color={tokens.colors.text.disabled}>
                <Text fontSize={tokens.fontSize.lg}>Select a file to edit</Text>
              </Flex>
            )}
          </Flex>
        </Flex>
      </Flex>

      {/* Bottom panel (terminal) */}
      {isBottomPanelVisible && (
        <Box
          height={`${bottomDefaultSize}px`}
          bg={tokens.colors.bg.mainLayout}
          position="relative"
          borderTop={`1px solid ${tokens.colors.border.sidebarPanel}`}
        >
          <BottomPanel
            isVisible={isBottomPanelVisible}
            onToggle={toggleBottomPanel}
            onClose={closeBottomPanel}
          />
        </Box>
      )}

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
