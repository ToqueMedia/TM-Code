import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiAlertOctagon, FiAlertTriangle, FiArchive } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useBillingStore } from '../../stores/billingStore'
import { useAgentStore } from '../../stores/agentStore'
import { getProfileForPlan } from '../../services/agent/modelProfiles'
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  getWarningThreshold,
} from '../../utils/contextWindow'
import { tokens } from '@/theme/tokens'

/**
 * Per-turn context-pressure pill. Mirrors claude-vaz's status-line
 * percentage logic (utils/context.ts:118-144 +
 * services/compact/autoCompact.ts:30-91).
 *
 * The pill measures the size of the CURRENT prompt vs. the EFFECTIVE
 * window (raw window minus the headroom reserved for a compaction
 * summary call, 20 K tokens). It is a per-turn metric — distinct from
 * the plan-consumption pill rendered next to it, which sums cost across
 * the rate-limit cycle.
 *
 * Pressure formula:
 *   prompt tokens (input + cache_read + cache_creation, all summed
 *     because cache reads/writes occupy slots even though they bill
 *     differently — see streamParser.ts:171-175 for the same sum on
 *     the wire-receive side)
 *   ──────────────────────────────────────────────────
 *   effective window  =  raw window  −  20K (summary headroom)
 *
 * Trigger logic — token-absolute, not percentage-of-raw:
 *   threshold = effective − buffer (adaptive: floor 13K, 5% on large windows)
 *   warn      = threshold − 20K (WARNING_THRESHOLD_BUFFER_TOKENS)
 *
 * Token-absolute (not 83.5 % of raw) keeps the headroom constant
 * regardless of window size. The older flat-percentage was triggering
 * too early on 1 M-context models — at 83.5 % of 1 M the threshold sat
 * 167 K below the actual ceiling, far more buffer than needed.
 *
 * Tooltip text is explicit about which percentage this is so users
 * don't confuse it with the plan-consumption pill next door.
 */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function ContextWindowIndicator() {
  // Read the per-turn input count, but fall back to the active session's
  // last-known prompt size when the per-turn counter is 0. `resetTokenUsage`
  // zeroes `currentPromptTokens` at the start of every new request
  // (agentRunner.ts:146) — without the fallback the pill collapses to 0%
  // during the gap between user-clicks-send and the new turn's first
  // `message_start` event, producing the visible "ended at 13% / restarted
  // at 7%" jump the user reported. The session field is written on every
  // `addTokenUsage` (chatStore.ts:2084), so it always reflects the most
  // recently completed turn.
  const inputTokens = useChatStore((s) => {
    if (s.currentPromptTokens > 0) return s.currentPromptTokens
    if (!s.activeSessionId) return 0
    return s.sessions.get(s.activeSessionId)?.lastPromptTokens ?? 0
  })
  const outputTokens = useChatStore((s) => s.currentResponseTokens)
  const plan = useBillingStore((s) => s.plan)
  const headerContextWindow = useAgentStore((s) => s.modelContextWindow)
  const [hovered, setHovered] = useState(false)

  // Profile lookup is a static map read — no useMemo needed.
  const profile = getProfileForPlan(plan)
  // Header is authoritative; profile is fallback ONLY for the brief
  // window before the first response lands. This intentionally mirrors
  // the compression heuristic so the pill and the IDE agree.
  const rawContextWindow = headerContextWindow ?? profile?.contextWindow ?? 0

  // Stay hidden only until the window is known. Show 0% as soon as it is —
  // gives the user continuity across resets (compact, new message) instead
  // of disappearing and reappearing. Hidden state only for the brief
  // pre-handshake before any model identity is established.
  if (rawContextWindow <= 0) return null

  const effectiveWindow = getEffectiveContextWindowSize(rawContextWindow)
  const compactThreshold = getAutoCompactThreshold(rawContextWindow)
  const warnThreshold = getWarningThreshold(rawContextWindow)

  // Pressure is input-only (response tokens don't occupy the window
  // mid-turn; once the response lands it rolls into the next turn's
  // input). Same shape as claude-vaz's calculateContextPercentages.
  const pressureTokens = inputTokens
  const rawPct = effectiveWindow > 0 ? (pressureTokens / effectiveWindow) * 100 : 0
  const pct = Math.min(100, rawPct)
  const overrun = rawPct > 100

  const compactImminent = pressureTokens >= compactThreshold && pressureTokens > 0
  const isWarning = pressureTokens >= warnThreshold && pressureTokens > 0

  const tone: 'idle' | 'ok' | 'warn' | 'danger' =
    pressureTokens === 0 ? 'idle'
    : compactImminent ? 'danger'
    : isWarning ? 'warn'
    : 'ok'

  const barColor =
    tone === 'idle'
      ? 'rgba(255,255,255,0.18)'
      : tone === 'ok'
        ? tokens.colors.accent.green
        : tone === 'warn'
          ? tokens.colors.accent.orange
          : tokens.colors.accent.red

  const showWarnIcon = tone === 'warn'

  return (
    <Flex
      align="center"
      gap="6px"
      px="8px"
      py="3px"
      borderRadius="5px"
      border="1px solid"
      borderColor={overrun ? tokens.colors.accent.red : tokens.colors.border.default}
      cursor="default"
      position="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Text
        fontSize="10px"
        fontWeight="500"
        color={tokens.colors.text.muted}
        userSelect="none"
        letterSpacing="0.02em"
      >
        ctx
      </Text>
      <Box
        w="48px"
        h="5px"
        bg="rgba(255,255,255,0.06)"
        borderRadius="full"
        overflow="hidden"
        flexShrink={0}
      >
        <Box
          w={`${pct}%`}
          h="100%"
          bg={barColor}
          transition="width 0.4s ease-out, background-color 0.2s"
        />
      </Box>
      <Text
        fontSize="10px"
        fontWeight="600"
        color={
          overrun
            ? tokens.colors.accent.red
            : tone === 'danger'
              ? tokens.colors.accent.red
              : tokens.colors.text.secondary
        }
        userSelect="none"
        minW="28px"
        textAlign="right"
      >
        {overrun ? `${Math.round(rawPct)}%` : `${Math.round(pct)}%`}
      </Text>

      {/* Accessibility / disambiguation glyph — distinct shapes per state
          so a glance tells you which red you're in:
            warn          → orange triangle (FiAlertTriangle), color-blind safe
            compact-imm.  → archive icon (FiArchive) — "IDE will summarise next turn"
            overrun       → alert octagon (FiAlertOctagon) — over effective ceiling,
                            stealing from summary headroom. Same red palette as
                            compact-imminent but a visibly different shape so the
                            user can tell at a glance whether they're past the
                            trigger (handled) or past the ceiling (degraded). */}
      {overrun ? (
        <Box color={tokens.colors.accent.red} flexShrink={0} display="flex" alignItems="center">
          <FiAlertOctagon size={11} />
        </Box>
      ) : compactImminent ? (
        <Box color={tokens.colors.accent.red} flexShrink={0} display="flex" alignItems="center">
          <FiArchive size={11} />
        </Box>
      ) : showWarnIcon ? (
        <Box color={tokens.colors.accent.orange} flexShrink={0} display="flex" alignItems="center">
          <FiAlertTriangle size={11} />
        </Box>
      ) : null}

      {/* Hover popover. Rendered BELOW the indicator (not above) because
          the parent ChatView Flex sets overflow:hidden — a popover positioned
          above the header bar would be clipped. Below the indicator drops
          into the message area which has its own scroll context. */}
      {hovered && (
        <Box
          position="absolute"
          top="calc(100% + 6px)"
          right={0}
          minW="240px"
          px="10px"
          py="8px"
          borderRadius="6px"
          bg="rgba(20, 20, 22, 0.96)"
          border={`1px solid ${tokens.colors.border.default}`}
          boxShadow="0 4px 14px rgba(0,0,0,0.45)"
          zIndex={50}
          pointerEvents="none"
        >
          <Flex direction="column" gap="4px">
            <Text fontSize="9px" color={tokens.colors.text.disabled} letterSpacing="0.05em" textTransform="uppercase">
              Per-turn context
            </Text>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Prompt (input)</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(inputTokens)}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Last response</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(outputTokens)}
              </Text>
            </Flex>
            <Box h="1px" bg="rgba(255,255,255,0.06)" my="2px" />
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Effective window</Text>
              <Text fontSize="10px" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(effectiveWindow)}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Raw window</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(rawContextWindow)}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Pressure</Text>
              <Text
                fontSize="10px"
                fontFamily={tokens.fontFamily.mono}
                color={overrun ? tokens.colors.accent.red : tokens.colors.text.primary}
                fontWeight="600"
              >
                {rawPct.toFixed(1)}%{overrun ? ' (overrun)' : ''}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Auto-compact at</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(compactThreshold)}
              </Text>
            </Flex>
            <Text fontSize="9px" color={tokens.colors.text.disabled} lineHeight="1.4" mt="2px">
              Different metric from the plan-consumption pill, which sums cost across the billing cycle.
            </Text>
            {overrun ? (
              <Box
                mt="4px"
                px="6px"
                py="4px"
                borderRadius="4px"
                bg="rgba(248, 81, 73, 0.10)"
                border="1px solid rgba(248, 81, 73, 0.25)"
              >
                <Flex align="center" gap="6px">
                  <Box color={tokens.colors.accent.red} display="flex" alignItems="center">
                    <FiAlertOctagon size={11} />
                  </Box>
                  <Text fontSize="10px" color={tokens.colors.accent.red} lineHeight="1.4">
                    Over effective ceiling — eating into the summary headroom. Compaction is overdue.
                  </Text>
                </Flex>
              </Box>
            ) : compactImminent ? (
              <Box
                mt="4px"
                px="6px"
                py="4px"
                borderRadius="4px"
                bg="rgba(248, 81, 73, 0.10)"
                border="1px solid rgba(248, 81, 73, 0.25)"
              >
                <Flex align="center" gap="6px">
                  <Box color={tokens.colors.accent.red} display="flex" alignItems="center">
                    <FiArchive size={11} />
                  </Box>
                  <Text fontSize="10px" color={tokens.colors.accent.red} lineHeight="1.4">
                    Auto-compact will trigger on the next turn.
                  </Text>
                </Flex>
              </Box>
            ) : null}
          </Flex>
        </Box>
      )}
    </Flex>
  )
}

// Wrapped in memo because this lives in the chat-view header, which
// re-renders on any streaming-token write. The component takes no props,
// so memo bails out on every parent re-render and only repaints when one
// of its own store selectors actually changes.
export default memo(ContextWindowIndicator)
