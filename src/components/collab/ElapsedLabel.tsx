import { memo } from 'react'
import { Text, type TextProps } from '@chakra-ui/react'
import { useElapsedLabel } from '@/hooks/useElapsedLabel'

/**
 * Self-ticking `m:ss` label. Isolated in its own memo component so the 1 Hz
 * tick re-renders THIS text node only — never the hosting panel (whose chat
 * list is hundreds of nodes; re-rendering it every second for a timer was
 * measurable waste on long calls).
 */
export const ElapsedLabel = memo(function ElapsedLabel({
  since,
  ...text
}: { since: number | null } & TextProps) {
  const label = useElapsedLabel(since)
  if (!label) return null
  return <Text {...text}>{label}</Text>
})
