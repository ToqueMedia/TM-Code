import { memo, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'
import { VscLoading, VscSearch } from 'react-icons/vsc'
import { ExpandReveal } from './ExpandReveal'
import { TranscriptToggle } from './TranscriptToggle'
import type { ToolCallDisplay as ToolCallDisplayType } from '../../types/chat'
import {
  explorationCounts,
  foldExplorationItems,
  type ExplorationCategory,
} from '../../utils/groupToolCalls'
import ToolCallDisplayComponent, { getInputSummary } from './ToolCallDisplay'
import ReadOutputBatch from './ReadOutputBatch'
import { useProjectStore } from '../../stores/projectStore'
import { shallowArrayEqual } from '@/utils/shallowArrayEqual'
import { canonicalToolName, normalizeToolInputForCanonical } from '@/services/agent/toolNames'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import type { TranslationKey } from '@/i18n/translations'

/**
 * Consolidated row for a run of adjacent read-only exploration calls —
 * file reads, searches, globs, directory listings, output reads, web
 * fetches, guide loads. Compact header:
 *
 *   🔍 Explore · 1 file
 *   🔍 Explore · 3 files · 1 search
 *
 * Expanding reveals the individual rows (each keeps its own output
 * expander), with paginated-read streaks rendered by ReadOutputBatch —
 * two levels of detail on demand, zero information destroyed.
 *
 * Grouping decisions (what joins, what breaks, failure ejection) live in
 * utils/groupToolCalls.ts — this component only renders what it is given.
 */

interface ExplorationBatchProps {
  /** All calls in the run, chronological. Guaranteed by the grouper to be
   *  exploration-eligible (never failed, never sub-agent children). */
  calls: ToolCallDisplayType[]
}

const COUNT_KEYS: Record<ExplorationCategory, { one: TranslationKey; many: TranslationKey }> = {
  files: { one: 'explore.count.files.one', many: 'explore.count.files.many' },
  searches: { one: 'explore.count.searches.one', many: 'explore.count.searches.many' },
  dirs: { one: 'explore.count.dirs.one', many: 'explore.count.dirs.many' },
  outputs: { one: 'explore.count.outputs.one', many: 'explore.count.outputs.many' },
  web: { one: 'explore.count.web.one', many: 'explore.count.web.many' },
  guides: { one: 'explore.count.guides.one', many: 'explore.count.guides.many' },
  shells: { one: 'explore.count.shells.one', many: 'explore.count.shells.many' },
}

function ExplorationBatchComponent({ calls }: ExplorationBatchProps) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const projectPath = useProjectStore(s => s.currentProject?.path || '')

  const items = foldExplorationItems(calls)
  const counts = explorationCounts(calls)
  const isRunning = calls.some(c => c.status === 'running')

  // Live target — the newest running call, shown as a sub-line so the user
  // sees WHAT is being read right now without expanding. Uses the same
  // summary the individual row would show (relative path, quoted query…).
  let liveTarget = ''
  if (isRunning) {
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].status === 'running') {
        const call = calls[i]
        const name = canonicalToolName(call.toolName)
        liveTarget = getInputSummary(
          name,
          normalizeToolInputForCanonical(call.toolName, call.input),
          call.result,
          projectPath,
        )
        break
      }
    }
  }

  return (
    <Box my={1.5}>
      <TranscriptToggle
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        busy={isRunning}
      >
        {isRunning ? (
          <Box
            color={tokens.colors.toolCall.runningText}
            flexShrink={0}
            css={{
              animation: 'toolSpin 1s linear infinite',
              '@keyframes toolSpin': {
                from: { transform: 'rotate(0deg)' },
                to: { transform: 'rotate(360deg)' },
              },
            }}
          >
            <VscLoading size={13} />
          </Box>
        ) : (
          <Box color={tokens.colors.text.muted} flexShrink={0}>
            <VscSearch size={13} />
          </Box>
        )}

        <Text
          fontSize={tokens.fontSize.md}
          fontFamily={tokens.fontFamily.ui}
          color={tokens.colors.text.secondary}
          lineHeight="1.4"
          minW={0}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          <Text as="span" color={tokens.colors.text.secondary}>
            {t('explore.label')}
          </Text>
          {counts.map(entry => {
            const form = entry.count === 1 ? 'one' : 'many'
            return (
              <Text as="span" key={entry.category} color={tokens.colors.text.muted}>
                {' · '}
                {t(COUNT_KEYS[entry.category][form]).replace('{count}', String(entry.count))}
              </Text>
            )
          })}
        </Text>
      </TranscriptToggle>

      {isRunning && liveTarget && !expanded && (
        <Text
          fontSize={tokens.fontSize.xs}
          fontFamily={tokens.fontFamily.mono}
          color={tokens.colors.text.disabled}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          pl="30px"
          pb="2px"
        >
          {liveTarget}
        </Text>
      )}

      <ExpandReveal open={expanded}>
        <Box pl="30px" pt={1}>
          {items.map(item =>
            item.kind === 'large_read_streak' ? (
              <ReadOutputBatch key={item.calls[0].id} calls={item.calls} />
            ) : (
              <ToolCallDisplayComponent key={item.call.id} toolCall={item.call} />
            ),
          )}
        </Box>
      </ExpandReveal>
    </Box>
  )
}

// Comparador por IDENTIDADE dos elementos (task #14): o pai reconstrói o
// array `calls` a cada flush de streaming, mas os toolCalls preservam
// identidade — o memo shallow default nunca segurava e este lote
// re-renderizava a árvore Chakra inteira ~10×/s.
export default memo(ExplorationBatchComponent, (prev, next) =>
  shallowArrayEqual(prev.calls, next.calls))
