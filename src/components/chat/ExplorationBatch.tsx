import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiChevronDown, FiChevronRight, FiLoader } from 'react-icons/fi'
import type { ToolCallDisplay as ToolCallDisplayType } from '../../types/chat'
import {
  explorationCounts,
  foldExplorationItems,
  type ExplorationCategory,
} from '../../utils/groupToolCalls'
import ToolCallDisplayComponent, { getInputSummary } from './ToolCallDisplay'
import ReadOutputBatch from './ReadOutputBatch'
import { useProjectStore } from '../../stores/projectStore'
import { canonicalToolName, normalizeToolInputForCanonical } from '@/services/agent/toolNames'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import type { TranslationKey } from '@/i18n/translations'

/**
 * Consolidated row for a run of adjacent read-only exploration calls —
 * file reads, searches, globs, directory listings, output reads, web
 * fetches, guide loads. One sentence tells the story:
 *
 *   while running:  ⟳ A ler 3 ficheiros, a pesquisar 1 padrão…
 *                     ⎿ src/stores/chatStore.ts
 *   when complete:  ✓ Leu 3 ficheiros, pesquisou 1 padrão
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

/** Literal-key lookup (t() takes a typed TranslationKey — no template
 *  string keys). live = gerund while any call runs; done = past tense. */
const PHRASE_KEYS: Record<ExplorationCategory, {
  live: { one: TranslationKey; many: TranslationKey }
  done: { one: TranslationKey; many: TranslationKey }
}> = {
  files: {
    live: { one: 'explore.live.files.one', many: 'explore.live.files.many' },
    done: { one: 'explore.done.files.one', many: 'explore.done.files.many' },
  },
  searches: {
    live: { one: 'explore.live.searches.one', many: 'explore.live.searches.many' },
    done: { one: 'explore.done.searches.one', many: 'explore.done.searches.many' },
  },
  dirs: {
    live: { one: 'explore.live.dirs.one', many: 'explore.live.dirs.many' },
    done: { one: 'explore.done.dirs.one', many: 'explore.done.dirs.many' },
  },
  outputs: {
    live: { one: 'explore.live.outputs.one', many: 'explore.live.outputs.many' },
    done: { one: 'explore.done.outputs.one', many: 'explore.done.outputs.many' },
  },
  web: {
    live: { one: 'explore.live.web.one', many: 'explore.live.web.many' },
    done: { one: 'explore.done.web.one', many: 'explore.done.web.many' },
  },
  guides: {
    live: { one: 'explore.live.guides.one', many: 'explore.live.guides.many' },
    done: { one: 'explore.done.guides.one', many: 'explore.done.guides.many' },
  },
}

/** Render one "{verb} {count} {noun}" segment with the count emphasised
 *  (bold, primary colour) — mirrors the terminal-mode styling the user
 *  pointed at. Splits the template around {count} so translations stay
 *  free to place the number anywhere. */
function CountPhrase({ template, count, capitalize }: {
  template: string
  count: number
  capitalize?: boolean
}) {
  const [pre = '', post = ''] = template.split('{count}')
  const preText = capitalize && pre.length > 0
    ? pre.charAt(0).toUpperCase() + pre.slice(1)
    : pre
  return (
    <>
      {preText}
      <Text as="span" fontWeight="700" color={tokens.colors.text.primary}>
        {count}
      </Text>
      {post}
    </>
  )
}

function ExplorationBatchComponent({ calls }: ExplorationBatchProps) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const projectPath = useProjectStore(s => s.currentProject?.path || '')

  const items = foldExplorationItems(calls)
  const counts = explorationCounts(calls)
  const isRunning = calls.some(c => c.status === 'running')
  const tense = isRunning ? 'live' : 'done'

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
    <Box
      my={1.5}
      borderRadius="8px"
      border={`1px solid ${isRunning ? 'rgba(240, 192, 0, 0.12)' : 'rgba(255, 255, 255, 0.04)'}`}
      bg={isRunning ? 'rgba(240, 192, 0, 0.03)' : 'rgba(255, 255, 255, 0.015)'}
      transition="all 0.15s"
    >
      {/* Header — status icon + sentence + chevron. Whole row toggles. */}
      <Flex
        align="flex-start"
        gap={2}
        px={3}
        py="8px"
        cursor="pointer"
        _hover={{ bg: 'rgba(255, 255, 255, 0.02)' }}
        transition="background 0.1s"
        onClick={() => setExpanded(!expanded)}
      >
        {isRunning ? (
          <Box
            color={tokens.colors.toolCall.runningText}
            flexShrink={0}
            mt="2px"
            css={{
              animation: 'toolSpin 1s linear infinite',
              '@keyframes toolSpin': {
                from: { transform: 'rotate(0deg)' },
                to: { transform: 'rotate(360deg)' },
              },
            }}
          >
            <FiLoader size={12} />
          </Box>
        ) : (
          <Box color={tokens.colors.accent.green} flexShrink={0} mt="2px">
            <FiCheck size={12} />
          </Box>
        )}

        <Box flex="1" minW={0}>
          <Text
            fontSize="12px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.text.secondary}
            lineHeight="1.5"
          >
            {counts.map((entry, idx) => {
              const form = entry.count === 1 ? 'one' : 'many'
              const template = t(PHRASE_KEYS[entry.category][tense][form])
              return (
                <Text as="span" key={entry.category}>
                  {idx > 0 && ', '}
                  <CountPhrase template={template} count={entry.count} capitalize={idx === 0} />
                </Text>
              )
            })}
            {isRunning && '…'}
          </Text>

          {/* Current target while running — "⎿ path/to/file.ts" */}
          {isRunning && liveTarget && (
            <Text
              fontSize="11px"
              fontFamily={tokens.fontFamily.mono}
              color={tokens.colors.text.disabled}
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              mt="2px"
            >
              {'⎿ '}{liveTarget}
            </Text>
          )}
        </Box>

        <Box color={tokens.colors.text.disabled} flexShrink={0} mt="2px">
          {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
        </Box>
      </Flex>

      {/* Expanded — the individual rows, chronological. Each keeps its own
          output expander; read streaks reuse the dedicated batch row. */}
      {expanded && (
        <Box px={2} pb={1.5} pt={0.5} borderTop="1px solid rgba(255,255,255,0.04)">
          {items.map(item =>
            item.kind === 'large_read_streak' ? (
              <ReadOutputBatch key={item.calls[0].id} calls={item.calls} />
            ) : (
              <ToolCallDisplayComponent key={item.call.id} toolCall={item.call} />
            ),
          )}
        </Box>
      )}
    </Box>
  )
}

export default memo(ExplorationBatchComponent)
