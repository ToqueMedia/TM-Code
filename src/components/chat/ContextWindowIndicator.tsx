import { useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiAlertTriangle, FiArchive } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useBillingStore } from '../../stores/billingStore'
import { useAgentStore } from '../../stores/agentStore'
import { getProfileForPlan } from '../../services/agent/modelProfiles'
import { tokens } from '@/theme/tokens'

/**
 * Visual indicator: how much of the active model's context window the
 * current conversation is consuming. Renders a mini-bar with the
 * percentage and a multi-line popover on hover showing exact tokens.
 *
 * Pressure formula: `currentPromptTokens / window` — input-only, NOT
 * input+output. The model's response IS counted, just not directly here:
 * once a turn ends, its output becomes part of the next turn's history
 * and is reflected in that turn's input_tokens. Summing input + output
 * here would double-count from the second turn onwards AND produce the
 * "pill bounces up then down" symptom — claude-vaz's status line uses
 * input-only for exactly this reason (utils/context.ts:130-133).
 * `currentResponseTokens` is kept around purely for the tooltip
 * breakdown so the user can still see how big the last response was.
 *
 * Colour bands match standard pressure-gauge convention:
 *   < 70%  green   — plenty of room
 *   70-90% orange  — getting tight, prompt user awareness
 *   ≥ 90%  red + auto-compact icon (this is the trigger for compression,
 *                  NOT an error state — the icon disambiguates)
 *
 * Source of truth:
 *  - `chatStore.currentPromptTokens` + `currentResponseTokens`: per-call
 *    REPLACED token counts for the most recent on-wire turn. Both reset
 *    on new user message / compaction boundary.
 *  - `agentStore.modelContextWindow`: from the X-Model-Context-Window
 *    response header — the same value the compression heuristic uses.
 *    Falls back to the plan profile ONLY for the pre-handshake window
 *    before the first response.
 */

// Compression heuristic threshold (mirrors agentService.ts:67). Showing
// the auto-compact glyph at this percentage tells the user "the IDE will
// summarise on the next turn" instead of letting the red colour read as
// a generic error.
const COMPACT_TRIGGER_PCT = 83.5

// Plan-profile model IDs → human labels. The server may already send a
// friendlier value via `X-Model-Name` (preferred); this table is a
// fallback for legacy / unknown ids that come back as raw provider slugs.
const FRIENDLY_MODEL_NAMES: Record<string, string> = {
  'deepseek-v4-flash': 'DeepSeek V4-Flash',
  'glm-5.1': 'GLM-5.1',
  'glm-5.1-thinking': 'GLM-5.1 (thinking)',
  'mimo-v2-flash': 'MiMo V2-Flash',
  'mimo-v2.5': 'MiMo V2.5',
  'mimo-v2.5-pro': 'MiMo V2.5 Pro',
  'mimo-v2.5-1m': 'MiMo V2.5 (1M)',
  'qwen3-coder-flash': 'Qwen3-Coder Flash',
  'step-3.5-flash-2603': 'Step 3.5-Flash',
}

function friendlyModelLabel(modelId: string | null | undefined): string {
  if (!modelId) return 'unknown model'
  return FRIENDLY_MODEL_NAMES[modelId] ?? modelId
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function ContextWindowIndicator() {
  const inputTokens = useChatStore((s) => s.currentPromptTokens)
  const outputTokens = useChatStore((s) => s.currentResponseTokens)
  const plan = useBillingStore((s) => s.plan)
  const headerContextWindow = useAgentStore((s) => s.modelContextWindow)
  const modelName = useAgentStore((s) => s.modelName)
  const [hovered, setHovered] = useState(false)

  // Profile lookup is a static map read — no useMemo needed.
  const profile = getProfileForPlan(plan)
  // Header is authoritative; profile is fallback ONLY for the brief
  // window before the first response lands. This intentionally mirrors
  // the compression heuristic so the pill and the IDE agree.
  const contextWindow = headerContextWindow ?? profile?.contextWindow ?? 0
  const displayedModelName = friendlyModelLabel(modelName ?? profile?.name)

  // Stay hidden only until the window is known. Show 0% as soon as it is —
  // gives the user continuity across resets (compact, new message) instead
  // of disappearing and reappearing. Hidden state only for the brief
  // pre-handshake before any model identity is established.
  if (contextWindow <= 0) return null

  // Pressure is input-only (see header comment). `usedTokens` is kept
  // as the tooltip's "Total" line for the user's mental model, but does
  // NOT feed the bar — that would double-count output once it rolls into
  // history on the next turn.
  const pressureTokens = inputTokens
  const usedTokens = inputTokens + outputTokens
  const rawPct = (pressureTokens / contextWindow) * 100
  const pct = Math.min(100, rawPct)
  const overrun = rawPct > 100

  const tone: 'idle' | 'ok' | 'warn' | 'danger' =
    pressureTokens === 0 ? 'idle' : pct < 70 ? 'ok' : pct < 90 ? 'warn' : 'danger'

  const barColor =
    tone === 'idle'
      ? 'rgba(255,255,255,0.18)'
      : tone === 'ok'
        ? tokens.colors.accent.green
        : tone === 'warn'
          ? tokens.colors.accent.orange
          : tokens.colors.accent.red

  const compactImminent = rawPct >= COMPACT_TRIGGER_PCT
  const showWarnIcon = tone === 'warn' || tone === 'danger'

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

      {/* Accessibility / disambiguation glyph. At warn → orange triangle
          (color-blind safe signal). At compact-trigger → archive icon
          telling the user "this isn't an error, the IDE will summarise
          next turn". */}
      {compactImminent ? (
        <Box color={tokens.colors.accent.red} flexShrink={0} display="flex" alignItems="center">
          <FiArchive size={11} />
        </Box>
      ) : showWarnIcon ? (
        <Box color={tokens.colors.accent.orange} flexShrink={0} display="flex" alignItems="center">
          <FiAlertTriangle size={11} />
        </Box>
      ) : null}

      {/* Hover popover. Replaces the native `title` attribute — that
          collapses `\n` to a single line in every browser, so a
          two-line tooltip ("tokens / window — model name") would have
          been visually mashed together. */}
      {hovered && (
        <Box
          position="absolute"
          bottom="calc(100% + 6px)"
          right={0}
          minW="220px"
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
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Prompt</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(inputTokens)}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Response</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(outputTokens)}
              </Text>
            </Flex>
            <Box h="1px" bg="rgba(255,255,255,0.06)" my="2px" />
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Total / window</Text>
              <Text fontSize="10px" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(usedTokens)} / {formatTokens(contextWindow)}
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
            <Box h="1px" bg="rgba(255,255,255,0.06)" my="2px" />
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>Model</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {displayedModelName}
              </Text>
            </Flex>
            {compactImminent && (
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
            )}
          </Flex>
        </Box>
      )}
    </Flex>
  )
}

export default ContextWindowIndicator
