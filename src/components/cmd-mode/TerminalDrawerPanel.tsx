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
  const instances = useTerminalPanelStore(s => s.instances)
  const requestFocus = useTerminalPanelStore(s => s.requestFocus)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  // Keep xterm mounted while PTYs are alive so reopen is instant, but do
  // not steal Esc — that belongs to vim/less/fzf inside the PTY.
  const keepAlive = instances.length > 0
  const show = isOpen && !!currentProject?.path

  useEffect(() => {
    if (isOpen && !currentProject?.path) {
      useTerminalPanelStore.getState().close()
    }
  }, [isOpen, currentProject?.path])

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startH: useTerminalPanelStore.getState().heightPx }
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      setHeight(drag.startH + (drag.startY - e.clientY))
    }
    const onUp = () => {
      dragRef.current = null
      target.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      requestFocus()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [setHeight, requestFocus])

  return (
    <Flex
      direction="column"
      w="100%"
      h={show ? `${heightPx}px` : '0px'}
      flexShrink={0}
      bg={tokens.colors.terminal.background}
      borderTop={show ? `1px solid ${tokens.colors.border.panel}` : 'none'}
      overflow="hidden"
    >
      {show && (
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
      <Box
        flex={1}
        minH={0}
        overflow="hidden"
        visibility={show ? 'visible' : 'hidden'}
        aria-hidden={!show}
      >
        {currentProject?.path && (show || keepAlive) && (
          <TerminalPanel projectPath={currentProject.path} showBorder={false} />
        )}
      </Box>
    </Flex>
  )
}

export default memo(TerminalDrawerPanel)
