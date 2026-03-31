import { memo, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronRight, FiChevronDown } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface ReasoningBlockProps {
  content: string
  isVisible: boolean
  isStreaming: boolean
  durationMs?: number
  onToggle: () => void
}

/**
 * Formats reasoning duration using only Intl APIs — zero hardcoded strings.
 * Intl.NumberFormat with style:'unit' returns localized text like
 * "5 segundos" (pt), "5 seconds" (en), "5 秒" (ja) etc.
 */
function formatDuration(ms: number): string {
  const locale = navigator.language || 'en'
  const totalSeconds = Math.max(1, Math.round(ms / 1000))

  const unit = totalSeconds >= 60 ? 'minute' : 'second'
  const value = unit === 'minute' ? Math.round(totalSeconds / 60) : totalSeconds

  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'long',
    }).format(value)
  } catch {
    // Fallback for older engines without unit style
    return `${value}s`
  }
}

function ReasoningBlock({ content, isVisible, isStreaming, durationMs, onToggle }: ReasoningBlockProps) {
  if (!content) return null

  const isExpanded = isStreaming || isVisible

  const durationLabel = useMemo(
    () => (durationMs != null ? formatDuration(durationMs) : null),
    [durationMs]
  )

  return (
    <Box mb={3}>
      <Flex
        align="center"
        gap={1.5}
        cursor="pointer"
        onClick={onToggle}
        py="5px"
        px="8px"
        borderRadius="6px"
        _hover={{ bg: 'rgba(255, 255, 255, 0.04)' }}
        transition="background 0.12s"
        userSelect="none"
      >
        <Box color={tokens.colors.text.disabled} transition="transform 0.15s" flexShrink={0}>
          {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
        </Box>

        {isStreaming ? (
          /* Streaming: animated dots — no text label needed, reasoning content is visible */
          <Flex gap="3px" align="center">
            {[0, 1, 2].map(i => (
              <Box
                key={i}
                w="4px"
                h="4px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                animation={`pulseDot 1.4s ease-in-out ${i * 0.2}s infinite`}
              />
            ))}
          </Flex>
        ) : (
          /* Collapsed: Intl-formatted duration only (e.g. "5 segundos", "12 seconds") */
          <Flex align="center" gap={1.5}>
            <Text fontSize="13px" color={tokens.colors.text.disabled} lineHeight="1">
              {'💭'}
            </Text>
            {durationLabel && (
              <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500" letterSpacing="0.01em">
                {durationLabel}
              </Text>
            )}
          </Flex>
        )}
      </Flex>

      {isExpanded && (
        <Box
          mt="4px"
          ml="6px"
          pl={3}
          borderLeft={`2px solid rgba(254, 16, 99, 0.15)`}
          maxH="320px"
          overflowY="auto"
          py="10px"
          px="12px"
          css={{
            '&::-webkit-scrollbar': { width: '3px' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
          }}
        >
          <Text
            fontSize="12px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.ui}
            lineHeight="1.7"
            whiteSpace="pre-wrap"
            fontStyle="italic"
            letterSpacing="-0.005em"
          >
            {content}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default memo(ReasoningBlock)
