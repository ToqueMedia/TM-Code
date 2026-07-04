import { memo, useCallback, useEffect } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiTerminal, FiX } from 'react-icons/fi'
import { useCurrentProject } from '@/hooks/useProjectState'
import { useTerminalPanelStore } from '@/stores/terminalPanelStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { TerminalPanel } from './TerminalPanel'

function TerminalDrawerPanel() {
  const currentProject = useCurrentProject()
  const isOpen = useTerminalPanelStore(s => s.isOpen)
  const widthPx = useTerminalPanelStore(s => s.widthPx)
  const close = useTerminalPanelStore(s => s.close)

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

  return (
    <Flex
      direction="column"
      w={isOpen ? `${widthPx}px` : '0px'}
      h="100%"
      flexShrink={0}
      bg={tokens.colors.terminal.background}
      borderLeft={isOpen ? '1px solid rgba(255, 255, 255, 0.08)' : 'none'}
      overflow="hidden"
      transition="width 0.35s cubic-bezier(0.32, 0.72, 0, 1), border-left 0.25s ease"
    >
      <Flex
        direction="column"
        w={`${widthPx}px`}
        h="100%"
        transform={isOpen ? 'translateX(0)' : 'translateX(100%)'}
        opacity={isOpen ? 1 : 0}
        transition="transform 0.35s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease 0.05s"
      >
        <Flex
          align="center"
          justify="space-between"
          px={4}
          py={2.5}
          borderBottom="1px solid rgba(255, 255, 255, 0.06)"
          flexShrink={0}
        >
          <Flex align="center" gap={2}>
            <FiTerminal size={14} color={tokens.colors.text.secondary} />
            <Text fontSize="13px" fontWeight={600} color={tokens.colors.text.primary}>
              {t('activity.terminal')}
            </Text>
          </Flex>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="24px"
            h="24px"
            borderRadius="6px"
            color={tokens.colors.text.secondary}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary }}
            onClick={handleClose}
            aria-label={t('misc.close')}
          >
            <FiX size={14} />
          </Box>
        </Flex>

        <Box flex={1} minH={0} overflow="hidden">
          {currentProject?.path && (
            <TerminalPanel projectPath={currentProject.path} widthPx={widthPx} showBorder={false} />
          )}
        </Box>
      </Flex>
    </Flex>
  )
}

export default memo(TerminalDrawerPanel)
