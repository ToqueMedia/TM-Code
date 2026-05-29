import { memo, useState } from 'react'
import { Flex, Text, Collapsible } from '@chakra-ui/react'
import { FiChevronDown, FiChevronUp } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import type { CompactMetadata } from '@/types/chat'
import { t } from '@/i18n/useTranslation'

interface CompactSummaryProps {
  metadata: CompactMetadata
  /** The summary text content (from the summary message that follows the boundary). */
  summaryText?: string
}

function formatCompressionPercent(before: number, after: number): string {
  if (before <= 0) return '0%'
  const percent = Math.round(((before - after) / before) * 100)
  return `${percent}%`
}

function CompactSummary({ metadata, summaryText }: CompactSummaryProps) {
  const [expanded, setExpanded] = useState(false)

  // Estimate after-tokens from summary text length (rough: 4 chars ≈ 1 token)
  const afterEstimate = summaryText ? Math.ceil(summaryText.length / 4) : 0
  const percentSmaller = formatCompressionPercent(metadata.beforeTokens, afterEstimate)

  return (
    <Flex
      direction="column"
      mx={4}
      mb={2}
      borderRadius="md"
      bg="rgba(255, 255, 255, 0.02)"
      border="1px solid rgba(255, 255, 255, 0.06)"
      overflow="hidden"
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py={2}
        cursor={summaryText ? 'pointer' : 'default'}
        onClick={() => summaryText && setExpanded(!expanded)}
        _hover={summaryText ? { bg: 'rgba(255, 255, 255, 0.02)' } : undefined}
      >
        <Flex align="center" gap={2}>
          <Text fontSize="12px" color={tokens.colors.accent.primary} fontWeight="600">
            ✻
          </Text>
          <Text fontSize="12px" color={tokens.colors.text.muted}>
            {metadata.trigger === 'auto' || metadata.trigger === 'reactive'
              ? t('chat.compact.autoSummary')
              : t('chat.compact.manualSummary')}
          </Text>
        </Flex>
        <Flex align="center" gap={2}>
          {metadata.messagesSummarized !== undefined && (
            <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              {metadata.messagesSummarized} msgs
            </Text>
          )}
          <Text fontSize="11px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono}>
            {percentSmaller} {t('chat.compact.smaller')}
          </Text>
          {summaryText && (
            expanded ? <FiChevronUp size={14} color={tokens.colors.text.disabled} /> : <FiChevronDown size={14} color={tokens.colors.text.disabled} />
          )}
        </Flex>
      </Flex>

      {/* Expandable summary */}
      {summaryText && (
        <Collapsible.Root open={expanded}>
          <Collapsible.Content>
            <Flex
              direction="column"
              px={3}
              pb={3}
              pt={1}
              maxH="240px"
              overflowY="auto"
              css={{
                '&::-webkit-scrollbar': { width: '4px' },
                '&::-webkit-scrollbar-thumb': { bg: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
              }}
            >
              <Text
                fontSize="12px"
                color={tokens.colors.text.muted}
                whiteSpace="pre-wrap"
                lineHeight="1.5"
              >
                {summaryText}
              </Text>
            </Flex>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </Flex>
  )
}

export default memo(CompactSummary)
