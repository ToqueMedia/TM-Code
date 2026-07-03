import { memo, useCallback, useEffect } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiClock, FiX } from 'react-icons/fi'
import CheckpointPanel from './CheckpointPanel'
import { useCheckpointStore } from '@/stores/checkpointStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function CheckpointDrawerPanel() {
  const isOpen = useLayoutStore(s => s.isCheckpointDrawerOpen)
  const setCheckpointDrawerOpen = useLayoutStore(s => s.setCheckpointDrawerOpen)
  const checkpointCount = useCheckpointStore(s => s.checkpoints.length)

  const handleClose = useCallback(() => {
    setCheckpointDrawerOpen(false)
  }, [setCheckpointDrawerOpen])

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

  return (
    <Flex
      direction="column"
      w={isOpen ? '420px' : '0px'}
      h="100%"
      flexShrink={0}
      bg={tokens.colors.bg.mainLayout}
      borderLeft={isOpen ? '1px solid rgba(255, 255, 255, 0.06)' : 'none'}
      overflow="hidden"
      transition="width 0.35s cubic-bezier(0.32, 0.72, 0, 1), border-left 0.25s ease"
    >
      <Flex
        direction="column"
        w="420px"
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
            <FiClock size={14} color={tokens.colors.text.secondary} />
            <Text fontSize="13px" fontWeight={600} color={tokens.colors.text.primary}>
              {t('checkpoint.title')}
            </Text>
            {checkpointCount > 0 && (
              <Text
                fontSize="10px"
                color={tokens.colors.text.muted}
                bg={tokens.colors.bg.hoverSubtle}
                px="6px"
                py="1px"
                borderRadius="999px"
              >
                {checkpointCount}
              </Text>
            )}
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

        <Box flex={1} minH={0} overflow="auto" px={3} py={3}>
          <CheckpointPanel surface="drawer" />
        </Box>
      </Flex>
    </Flex>
  )
}

export default memo(CheckpointDrawerPanel)
