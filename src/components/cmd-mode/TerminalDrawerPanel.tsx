import { memo, useCallback, useEffect, useRef } from 'react'
import { Box, Flex } from '@chakra-ui/react'
import { useCurrentProject } from '@/hooks/useProjectState'
import { useTerminalPanelStore } from '@/stores/terminalPanelStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { TerminalPanel } from './TerminalPanel'

function TerminalDrawerPanel() {
  const currentProject = useCurrentProject()
  const isOpen = useTerminalPanelStore(s => s.isOpen)
  const heightPx = useTerminalPanelStore(s => s.heightPx)
  const setHeight = useTerminalPanelStore(s => s.setHeight)
  const close = useTerminalPanelStore(s => s.close)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const handleClose = useCallback(() => {
    close()
  }, [close])

  useEffect(() => {
    if (!isOpen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, handleClose])

  useEffect(() => {
    if (isOpen && !currentProject?.path) {
      close()
    }
  }, [isOpen, currentProject?.path, close])

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startH: useTerminalPanelStore.getState().heightPx }
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      // Dragging the TOP edge up increases height.
      setHeight(drag.startH + (drag.startY - e.clientY))
    }
    const onUp = () => {
      dragRef.current = null
      target.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [setHeight])

  return (
    <Flex
      direction="column"
      w="100%"
      h={isOpen ? `${heightPx}px` : '0px'}
      flexShrink={0}
      bg={tokens.colors.terminal.background}
      borderTop={isOpen ? `1px solid ${tokens.colors.border.panel}` : 'none'}
      overflow="hidden"
    >
      {isOpen && (
        <Box
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('activity.terminal')}
          h="4px"
          cursor="row-resize"
          flexShrink={0}
          bg="transparent"
          _hover={{ bg: tokens.colors.accent.primary }}
          onPointerDown={handleResizeStart}
        />
      )}
      <Box flex={1} minH={0} overflow="hidden">
        {currentProject?.path && (
          <TerminalPanel projectPath={currentProject.path} showBorder={false} />
        )}
      </Box>
    </Flex>
  )
}

export default memo(TerminalDrawerPanel)
