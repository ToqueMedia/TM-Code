import {
  Box,
  VStack,
  HStack,
  Text,
  IconButton
} from '@chakra-ui/react'
import { FiCircle, FiTrash2, FiChevronDown } from 'react-icons/fi'
import { t } from '@/i18n'
import { tokens } from '@/theme/tokens'
import type { BreakpointsSectionProps } from './types'

function BreakpointsSection({
  breakpoints,
  expanded,
  onToggle,
  onRemoveBreakpoint
}: BreakpointsSectionProps) {
  return (
    <Box>
      <HStack
        justify="space-between"
        mb={2}
        cursor="pointer"
        onClick={onToggle}
      >
        <Text fontSize="sm" fontWeight="semibold" color={tokens.colors.text.primary}>
          Breakpoints ({breakpoints.length})
        </Text>
        <FiChevronDown
          style={{
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: `transform ${tokens.transition.normal}`,
            color: tokens.colors.text.secondary
          }}
        />
      </HStack>
      {expanded && (
        <Box
          maxHeight="120px"
          overflowY="auto"
          bg={tokens.colors.bg.sidebar}
          borderRadius="md"
          p={2}
        >
          {breakpoints.length === 0 ? (
            <Text fontSize="sm" color={tokens.colors.text.subtle}>
              No breakpoints set
            </Text>
          ) : (
            breakpoints.map(bp => (
              <HStack
                key={bp.id}
                justify="space-between"
                p={2}
                bg={tokens.colors.bg.overlay}
                borderRadius="sm"
                mb={1}
              >
                <HStack>
                  <FiCircle
                    color={bp.verified ? tokens.colors.accent.red : tokens.colors.text.subtle}
                    size={8}
                  />
                  <VStack align="start" gap={0}>
                    <Text fontSize="xs" fontWeight="semibold" color={tokens.colors.text.primary}>
                      {bp.file.split('/').pop()}:{bp.line}
                    </Text>
                  </VStack>
                </HStack>
                <IconButton
                  aria-label={t("misc.removeBreakpoint")}
                  size="xs"
                  variant="ghost"
                  onClick={() => onRemoveBreakpoint(bp.id)}
                >
                  <FiTrash2 />
                </IconButton>
              </HStack>
            ))
          )}
        </Box>
      )}
    </Box>
  )
}

export default BreakpointsSection
