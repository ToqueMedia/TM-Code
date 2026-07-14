import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiCheck, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface DiffActionsBarProps {
  activeDiffsCount: number
  onRejectAll: () => void
  onAcceptAll: () => void
}

function DiffActionsBar({ activeDiffsCount, onRejectAll, onAcceptAll }: DiffActionsBarProps) {
  return (
    <Flex
      align="center"
      justify="space-between"
      gap={3}
      px={{ base: 3, md: 4 }}
      py="10px"
      bg="rgba(10, 10, 10, 0.72)"
      borderBottom="1px solid rgba(255, 255, 255, 0.075)"
      flexShrink={0}
      backdropFilter="blur(14px)"
    >
      <Flex align="center" gap={2} minW={0}>
        <Text fontSize="13px" color={tokens.colors.text.primary} fontWeight="700">
          Changes
        </Text>
        {activeDiffsCount > 0 && (
          <Text
            fontSize="10px"
            fontWeight="700"
            color={tokens.colors.accent.primary}
            bg="rgba(254, 16, 99, 0.12)"
            border="1px solid rgba(254, 16, 99, 0.22)"
            px="7px"
            py="2px"
            borderRadius="999px"
            lineHeight="1"
          >
            {activeDiffsCount}
          </Text>
        )}
      </Flex>
      {activeDiffsCount > 0 && (
        <Flex gap="8px" flexWrap="wrap" justify="flex-end">
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="11px"
            py="6px"
            bg="transparent"
            border="1px solid rgba(248, 81, 73, 0.18)"
            borderRadius="8px"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            transition="all 0.15s ease"
            _hover={{ bg: 'rgba(248, 81, 73, 0.1)', borderColor: 'rgba(248, 81, 73, 0.32)', transform: 'translateY(-1px)' }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            onClick={onRejectAll}
            aria-label="Reject all pending changes"
          >
            <FiX size={12} /> Reject All
          </Box>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="11px"
            py="6px"
            bg="rgba(46, 160, 67, 0.13)"
            border="1px solid rgba(46, 160, 67, 0.24)"
            borderRadius="8px"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            transition="all 0.15s ease"
            _hover={{ bg: 'rgba(46, 160, 67, 0.2)', borderColor: 'rgba(46, 160, 67, 0.38)', transform: 'translateY(-1px)' }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            onClick={onAcceptAll}
            aria-label="Accept all pending changes"
          >
            <FiCheck size={12} /> Accept All
          </Box>
        </Flex>
      )}
    </Flex>
  )
}

export default memo(DiffActionsBar)
