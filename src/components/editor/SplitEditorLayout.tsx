import { memo, Suspense, lazy, useRef, useCallback, useState } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import EditorTabs from '../ui/EditorTabs'
import Breadcrumbs from '../ui/Breadcrumbs'
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { tokens } from '@/theme/tokens'
import { useEditorRepository, type EditorGroup } from '../../stores/editorStore'
import MonacoBridge from '../../utils/monacoBridge'
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

interface EditorPaneProps {
  group: EditorGroup
  projectPath: string
  isFocused: boolean
  onFocus: () => void
  onCursorPositionChange: (line: number, column: number) => void
}

const EditorPane = memo<EditorPaneProps>(({ group, projectPath, isFocused, onFocus, onCursorPositionChange }) => {
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

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    // Reorder within this group's files
    useEditorRepository.setState(state => {
      const groups = state.editorGroups.map(g => {
        if (g.id !== group.id) return g
        if (fromIndex === toIndex) return g
        const files = [...g.files]
        const [moved] = files.splice(fromIndex, 1)
        files.splice(toIndex, 0, moved)
        return { ...g, files }
      })
      return { editorGroups: groups }
    })
  }, [group.id])

  const handlePaneFocus = useCallback(() => {
    onFocus()
    // Tell the MonacoEditor inside this pane to claim the bridge
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
      _after={isFocused ? {
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
      {groupFiles.length > 0 && (
        <>
          <Box flexShrink={0} borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}>
            <EditorTabs
              openFiles={groupFiles}
              activeFile={group.activeFile}
              onSetActiveFile={handleSetActiveFile}
              onCloseFile={handleCloseFile}
              onReorderFiles={handleReorder}
            />
          </Box>
          <Breadcrumbs
            filePath={group.activeFile || undefined}
            projectRoot={projectPath}
            onNavigate={(path) => logger.debug('editor', 'Navigate to:', path)}
          />
        </>
      )}

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

const SplitResizeHandle = memo<{ containerRef: React.RefObject<HTMLDivElement | null>; onSetRatio: (ratio: number) => void }>(({ containerRef, onSetRatio }) => {
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
  const activeGroupId = useEditorRepository(s => s.activeGroupId)
  const setActiveGroup = useEditorRepository(s => s.setActiveGroup)

  const [splitRatio, setSplitRatio] = useState(0.5)
  const containerRef = useRef<HTMLDivElement>(null)

  if (editorGroups.length <= 1) {
    // No split — just render the single pane (no focus indicator needed)
    const group = editorGroups[0] || { id: 'main', files: [], activeFile: null }
    return (
      <EditorPane
        group={group}
        projectPath={projectPath}
        isFocused={false}
        onFocus={() => {}}
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
          onFocus={() => setActiveGroup(editorGroups[0].id)}
          onCursorPositionChange={onCursorPositionChange}
        />
      </Box>

      <SplitResizeHandle containerRef={containerRef} onSetRatio={setSplitRatio} />

      <Box flex={1 - splitRatio} minW={0} display="flex" flexDirection="column">
        <EditorPane
          group={editorGroups[1]}
          projectPath={projectPath}
          isFocused={activeGroupId === editorGroups[1].id}
          onFocus={() => setActiveGroup(editorGroups[1].id)}
          onCursorPositionChange={onCursorPositionChange}
        />
      </Box>
    </Flex>
  )
}

export default memo(SplitEditorLayout)
