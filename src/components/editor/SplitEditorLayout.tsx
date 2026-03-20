import { memo, Suspense, lazy, useRef, useCallback, useState, useEffect } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiColumns, FiAlignLeft, FiX, FiMaximize2 } from 'react-icons/fi'
import EditorTabs from '../ui/EditorTabs'
import Breadcrumbs from '../ui/Breadcrumbs'
import MonacoBridge from '../../utils/monacoBridge'
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { tokens } from '@/theme/tokens'
import { useEditorRepository, type EditorGroup } from '../../stores/editorStore'
import { logger } from '../../utils/logger'

const MonacoEditor = lazy(() => import('../ui/MonacoEditor'))

const EditorSkeleton = () => (
  <Flex flex={1} align="center" justify="center">
    <LoadingSpinner size="lg" label="Loading editor..." />
  </Flex>
)

const EmptyPane = () => (
  <Flex
    flex={1}
    align="center"
    justify="center"
    direction="column"
    gap={2}
    color={tokens.colors.text.muted}
    fontSize="13px"
  >
    <Text>No file open</Text>
    <Text fontSize="11px" color={tokens.colors.text.disabled}>
      Drag a tab here or open a file
    </Text>
  </Flex>
)

// ── Toolbar icon button ────────────────────────────────────────────────────

const PaneAction = memo<{
  icon: React.ReactNode
  label: string
  onClick: () => void
}>(({ icon, label, onClick }) => (
  <Box
    as="button"
    display="flex"
    alignItems="center"
    justifyContent="center"
    width="26px"
    height="26px"
    borderRadius="4px"
    color={tokens.colors.text.muted}
    bg="transparent"
    cursor="pointer"
    transition={`all ${tokens.transition.fast}`}
    title={label}
    _hover={{
      bg: tokens.colors.bg.hoverSubtle,
      color: tokens.colors.text.primary,
    }}
    onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClick() }}
    flexShrink={0}
  >
    {icon}
  </Box>
))

PaneAction.displayName = 'PaneAction'

// ── Editor Pane ────────────────────────────────────────────────────────────

interface EditorPaneProps {
  group: EditorGroup
  projectPath: string
  isFocused: boolean
  isSplit: boolean
  onFocus: () => void
  onSplit: () => void
  onUnsplit: () => void
  onClosePane: () => void
  onFormat: () => void
  onCursorPositionChange: (line: number, column: number) => void
}

const EditorPane = memo<EditorPaneProps>(({
  group, projectPath, isFocused, isSplit,
  onFocus, onSplit, onUnsplit, onClosePane, onFormat, onCursorPositionChange,
}) => {
  const openFiles = useEditorRepository(s => s.openFiles)
  const closeFileInGroup = useEditorRepository(s => s.closeFileInGroup)
  const openFileInGroup = useEditorRepository(s => s.openFileInGroup)

  const groupFiles = group.files
    .map(path => openFiles.find(f => f.path === path))
    .filter(Boolean)
    .map(f => ({ path: f!.path, isDirty: f!.isDirty }))

  const handleSetActiveFile = useCallback((path: string) => {
    openFileInGroup(path, group.id)
  }, [group.id, openFileInGroup])

  const handleCloseFile = useCallback((path: string, _e: React.MouseEvent) => {
    closeFileInGroup(path, group.id)
  }, [group.id, closeFileInGroup])

  const handleReorder = useCallback((newOrder: string[]) => {
    useEditorRepository.setState(state => {
      const groups = state.editorGroups.map(g => {
        if (g.id !== group.id) return g
        return { ...g, files: newOrder }
      })
      return { editorGroups: groups }
    })
  }, [group.id])

  const handlePaneFocus = useCallback(() => {
    onFocus()
    if (group.activeFile) {
      window.dispatchEvent(new CustomEvent('monaco:claimBridge', { detail: group.activeFile }))
    }
  }, [onFocus, group.activeFile])

  return (
    <Flex
      direction="column"
      flex={1}
      minW={0}
      onClick={handlePaneFocus}
      position="relative"
      _after={isFocused && isSplit ? {
        content: '""',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '2px',
        bg: tokens.colors.accent.primary,
        zIndex: 1,
      } : undefined}
    >
      {/* Tab bar row: Tabs + Action buttons */}
      <Flex
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        align="center"
      >
        {/* Scrollable tabs */}
        <Box flex={1} minW={0} overflow="hidden">
          <EditorTabs
            openFiles={groupFiles}
            activeFile={group.activeFile}
            onSetActiveFile={handleSetActiveFile}
            onCloseFile={handleCloseFile}
            onReorderFiles={handleReorder}
          />
        </Box>

        {/* Action buttons — right side of tab bar */}
        {groupFiles.length > 0 && (
          <Flex
            align="center"
            gap="2px"
            px={1.5}
            flexShrink={0}
            bg={tokens.colors.bg.panel}
            height="30px"
          >
            <PaneAction
              icon={<FiAlignLeft size={13} />}
              label="Format Document (Shift+Alt+F)"
              onClick={onFormat}
            />
            {isSplit ? (
              <>
                <PaneAction
                  icon={<FiMaximize2 size={13} />}
                  label="Unsplit Editor"
                  onClick={onUnsplit}
                />
                <PaneAction
                  icon={<FiX size={13} />}
                  label="Close Split Pane"
                  onClick={onClosePane}
                />
              </>
            ) : (
              <PaneAction
                icon={<FiColumns size={14} />}
                label="Split Editor Right (Cmd+\\)"
                onClick={onSplit}
              />
            )}
          </Flex>
        )}
      </Flex>

      {/* Breadcrumbs */}
      {groupFiles.length > 0 && (
        <Breadcrumbs
          filePath={group.activeFile || undefined}
          projectRoot={projectPath}
          onNavigate={(path) => logger.debug('editor', 'Navigate to:', path)}
        />
      )}

      {/* Editor */}
      <Flex flex={1} overflow="hidden">
        {group.activeFile ? (
          <Suspense fallback={<EditorSkeleton />}>
            <MonacoEditor
              key={`${group.id}-${group.activeFile}`}
              path={group.activeFile}
              onCursorPositionChange={onCursorPositionChange}
            />
          </Suspense>
        ) : (
          <EmptyPane />
        )}
      </Flex>
    </Flex>
  )
})

EditorPane.displayName = 'EditorPane'

// ── Resize Handle ──────────────────────────────────────────────────────────

const SplitResizeHandle = memo<{
  containerRef: React.RefObject<HTMLDivElement | null>
  onSetRatio: (ratio: number) => void
}>(({ containerRef, onSetRatio }) => {
  const handleRef = useRef<HTMLDivElement>(null)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const handle = handleRef.current
    const container = containerRef.current
    if (!handle || !container) return
    const pid = e.pointerId
    try { handle.setPointerCapture(pid) } catch {}

    const containerRect = container.getBoundingClientRect()
    const body = document.body
    const prevCursor = body.style.cursor
    const prevSelect = body.style.userSelect
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'

    function onMove(pe: PointerEvent) {
      const relX = pe.clientX - containerRect.left
      const ratio = relX / containerRect.width
      onSetRatio(Math.max(0.2, Math.min(0.8, ratio)))
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
  }, [containerRef, onSetRatio])

  return (
    <Box
      ref={handleRef}
      width="4px"
      cursor="col-resize"
      bg="transparent"
      flexShrink={0}
      position="relative"
      zIndex={5}
      _hover={{ bg: tokens.colors.accent.primaryGlow }}
      _active={{ bg: tokens.colors.accent.primaryMuted }}
      style={{ touchAction: 'none' }}
      onPointerDown={handlePointerDown}
    >
      <Box
        position="absolute"
        top={0}
        bottom={0}
        left="1px"
        width="1px"
        bg={tokens.colors.border.sidebarPanel}
      />
    </Box>
  )
})

SplitResizeHandle.displayName = 'SplitResizeHandle'

// ── Main Layout ────────────────────────────────────────────────────────────

interface SplitEditorLayoutProps {
  projectPath: string
  onCursorPositionChange: (line: number, column: number) => void
}

function SplitEditorLayout({ projectPath, onCursorPositionChange }: SplitEditorLayoutProps) {
  const editorGroups = useEditorRepository(s => s.editorGroups)
  const openFiles = useEditorRepository(s => s.openFiles)
  const activeFile = useEditorRepository(s => s.activeFile)
  const activeGroupId = useEditorRepository(s => s.activeGroupId)
  const setActiveGroup = useEditorRepository(s => s.setActiveGroup)
  const splitEditor = useEditorRepository(s => s.splitEditor)
  const unsplitEditor = useEditorRepository(s => s.unsplitEditor)

  const [splitRatio, setSplitRatio] = useState(0.5)
  const containerRef = useRef<HTMLDivElement>(null)

  // Sync safety: if openFiles has entries but groups are empty, populate main group
  useEffect(() => {
    const allGroupFiles = editorGroups.flatMap(g => g.files)
    if (allGroupFiles.length === 0 && openFiles.length > 0) {
      useEditorRepository.setState(state => {
        const groupFiles = state.editorGroups.flatMap(g => g.files)
        if (groupFiles.length > 0) return state
        const filePaths = state.openFiles.map(f => f.path)
        return {
          editorGroups: [{ id: 'main', files: filePaths, activeFile: state.activeFile || filePaths[0] || null }],
          activeGroupId: 'main',
        }
      })
    }
  }, [editorGroups, openFiles, activeFile])

  const handleFormat = useCallback(() => {
    const bridge = MonacoBridge.getInstance()
    const action = bridge.getCurrentEditor()?.getAction('editor.action.formatDocument')
    if (action) action.run().catch(() => {})
  }, [])

  const handleClosePane = useCallback((groupId: string) => {
    // Close all files in this group, merge into the other
    const store = useEditorRepository.getState()
    const group = store.editorGroups.find(g => g.id === groupId)
    if (!group) return
    // Move all files to the other group
    const otherId = store.editorGroups.find(g => g.id !== groupId)?.id
    if (otherId) {
      for (const f of group.files) {
        store.moveFileToGroup(f, groupId, otherId)
      }
    }
    unsplitEditor()
  }, [unsplitEditor])

  const isSplit = editorGroups.length >= 2

  if (!isSplit) {
    const group = editorGroups[0] || { id: 'main', files: [], activeFile: null }
    return (
      <EditorPane
        group={group}
        projectPath={projectPath}
        isFocused={false}
        isSplit={false}
        onFocus={() => {}}
        onSplit={splitEditor}
        onUnsplit={unsplitEditor}
        onClosePane={() => {}}
        onFormat={handleFormat}
        onCursorPositionChange={onCursorPositionChange}
      />
    )
  }

  return (
    <Flex ref={containerRef} flex={1} overflow="hidden">
      <Box flex={splitRatio} minW={0} display="flex" flexDirection="column">
        <EditorPane
          group={editorGroups[0]}
          projectPath={projectPath}
          isFocused={activeGroupId === editorGroups[0].id}
          isSplit={true}
          onFocus={() => setActiveGroup(editorGroups[0].id)}
          onSplit={splitEditor}
          onUnsplit={unsplitEditor}
          onClosePane={() => handleClosePane(editorGroups[0].id)}
          onFormat={handleFormat}
          onCursorPositionChange={onCursorPositionChange}
        />
      </Box>

      <SplitResizeHandle containerRef={containerRef} onSetRatio={setSplitRatio} />

      <Box flex={1 - splitRatio} minW={0} display="flex" flexDirection="column">
        <EditorPane
          group={editorGroups[1]}
          projectPath={projectPath}
          isFocused={activeGroupId === editorGroups[1].id}
          isSplit={true}
          onFocus={() => setActiveGroup(editorGroups[1].id)}
          onSplit={splitEditor}
          onUnsplit={unsplitEditor}
          onClosePane={() => handleClosePane(editorGroups[1].id)}
          onFormat={handleFormat}
          onCursorPositionChange={onCursorPositionChange}
        />
      </Box>
    </Flex>
  )
}

export default memo(SplitEditorLayout)
