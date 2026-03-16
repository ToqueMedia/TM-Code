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
      px={4}
      py="8px"
      bg="rgba(255, 255, 255, 0.02)"
      borderBottom="1px solid rgba(255, 255, 255, 0.05)"
      flexShrink={0}
    >
      <Flex align="center" gap={2}>
        <Text fontSize="13px" color={tokens.colors.text.primary} fontWeight="600" letterSpacing="-0.01em">
          Changes
        </Text>
        {activeDiffsCount > 0 && (
          <Text
            fontSize="10px"
            fontWeight="600"
            color={tokens.colors.accent.primary}
            bg="rgba(254, 16, 99, 0.1)"
            px="6px"
            py="1px"
            borderRadius="4px"
          >
            {activeDiffsCount}
          </Text>
        )}
      </Flex>
      {activeDiffsCount > 0 && (
        <Flex gap="6px">
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="10px"
            py="4px"
            bg="transparent"
            border="1px solid rgba(248, 81, 73, 0.2)"
            borderRadius="6px"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.1)', borderColor: 'rgba(248, 81, 73, 0.35)' }}
            _active={{ transform: 'scale(0.97)' }}
            onClick={onRejectAll}
          >
            <FiX size={12} /> Reject All
          </Box>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="10px"
            py="4px"
            bg="rgba(46, 160, 67, 0.1)"
            border="1px solid rgba(46, 160, 67, 0.2)"
            borderRadius="6px"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(46, 160, 67, 0.18)', borderColor: 'rgba(46, 160, 67, 0.35)' }}
            _active={{ transform: 'scale(0.97)' }}
            onClick={onAcceptAll}
          >
            <FiCheck size={12} /> Accept All
          </Box>
        </Flex>
      )}
    </Flex>
  )
}

export default memo(DiffActionsBar)
