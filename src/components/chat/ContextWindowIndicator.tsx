import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiAlertOctagon, FiAlertTriangle, FiArchive } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { usePersonaStore } from '../../stores/personaStore'
import { useActiveModelStore } from '../../stores/activeModelStore'
import { MODEL_PROFILES } from '../../services/agent/modelProfiles'
import {
  FALLBACK_CONTEXT_WINDOW,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  getWarningThreshold,
} from '../../utils/contextWindow'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'

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

interface ContextWindowIndicatorProps {
  /** Where the hover popover opens. 'bottom' (default) suits a header bar;
   *  'top' suits the prompt-actions row at the bottom of the screen, where a
   *  downward popover would be clipped by the window edge. */
  popoverPlacement?: 'top' | 'bottom'
}

function ContextWindowIndicator({ popoverPlacement = 'bottom' }: ContextWindowIndicatorProps) {
  const t = useTranslation()
  // Ocupação CORRENTE do contexto — a mesma grandeza em que o autoCompact se
  // ancora (ocupação real do turno anterior), não um pico de sessão.
  //
  // O `Math.max(live, persisted)` que aqui estava, combinado com um
  // `lastPromptTokens` que era ele próprio um máximo, tornava o número
  // IRREVERSÍVEL: um turno grande fixava a barra e nenhum turno posterior a
  // baixava (reportado 2026-08-05 — "travou nos 49% e daí nunca andou"), o que
  // também escondia por completo o efeito da micro-compactação.
  //
  // `persisted` é escrito a cada turno de PRIMEIRO PLANO (guardas em
  // chatStore.addTokenUsage), por isso nunca é mais velho que `live`; `live`
  // fica como recurso para o intervalo antes do primeiro evento de usage de
  // uma sessão ainda sem valor persistido.
  const inputTokens = useChatStore((s) => {
    const live = s.currentPromptTokens
    if (!s.activeSessionId) return 0
    const persisted = s.sessions.get(s.activeSessionId)?.lastPromptTokens ?? 0
    return persisted > 0 ? persisted : live
  })
  const outputTokens = useChatStore((s) => {
    const live = s.currentResponseTokens
    if (!s.activeSessionId) return 0
    const persisted = s.sessions.get(s.activeSessionId)?.lastResponseTokens ?? 0
    return persisted > 0 ? persisted : live
  })
  // Pico da sessão: informação secundária no tooltip (mostrado só quando está
  // materialmente acima da ocupação corrente — senão é ruído duplicado).
  const peakPromptTokens = useChatStore((s) => {
    if (!s.activeSessionId) return 0
    return s.sessions.get(s.activeSessionId)?.peakPromptTokens ?? 0
  })
  const headerContextWindow = useAgentStore((s) => s.modelContextWindow)
  const modelMaxOutputTokens = useAgentStore((s) => s.modelMaxOutputTokens)
  const selectedPersona = usePersonaStore((s) => s.selected)
  const personaWindow = useActiveModelStore((s) => s.personaModels[selectedPersona]?.contextWindow)
  const modelName = useAgentStore((s) => s.modelName)
  const sessionByokContextWindow = useChatStore((s) => {
    if (!s.activeSessionId) return undefined
    const window = s.sessions.get(s.activeSessionId)?.byokSnapshot?.contextWindow
    return window && window > 0 ? window : undefined
  })
  const sessionByokModelId = useChatStore((s) => {
    if (!s.activeSessionId) return undefined
    return s.sessions.get(s.activeSessionId)?.byokSnapshot?.modelId
  })
  const [hovered, setHovered] = useState(false)

  // Window resolution mirrors the auto-compact decision:
  // BYOK session snapshot (direct provider path has no worker header)
  // → server header (X-Model-Context-Window, managed path)
  // → known MODEL_PROFILES entry → conservative 200K fallback.
  //
  // BYOK must come first. The header is sticky in agentStore until another
  // response updates it, and BYOK direct calls bypass the worker that would
  // normally emit X-Model-Context-Window. The session snapshot is the frozen
  // source of truth captured from Settings for the current BYOK conversation.
  const profileModelName = sessionByokModelId ?? modelName
  const rawContextWindow =
    sessionByokContextWindow ??
    headerContextWindow ??
    // Janela POR PERSONA (05-08): a escolha do admin no painel vale antes da
    // 1ª resposta — sem isto o pill mostrava a janela do perfil do modelo.
    personaWindow ??
    (profileModelName ? MODEL_PROFILES[profileModelName]?.contextWindow : undefined) ??
    FALLBACK_CONTEXT_WINDOW

  // Stay hidden only until the window is known. Show 0% as soon as it is —
  // gives the user continuity across resets (compact, new message) instead
  // of disappearing and reappearing. Hidden state only for the brief
  // pre-handshake before any model identity is established.
  if (rawContextWindow <= 0) return null

  // O tecto de output do modelo servido entra na conta: é o que o runtime
  // reserva. Sem o passar (era o caso), a UI assumia sempre o default de 20K e
  // anunciava um "auto-compact at" que não era aquele por que o agente
  // compactava — e divergia do `/context`, que já passava este argumento.
  const effectiveWindow = getEffectiveContextWindowSize(rawContextWindow, modelMaxOutputTokens)
  const compactThreshold = getAutoCompactThreshold(rawContextWindow, modelMaxOutputTokens)
  const warnThreshold = getWarningThreshold(rawContextWindow, modelMaxOutputTokens)

  // Context occupancy = the prompt actually on the wire (input side), which
  // already includes ALL prior history (past user messages, prior assistant
  // outputs, tool results). claude-vaz parity (utils/context.ts:130-136): the
  // pressure numerator is INPUT-ONLY — the current turn's output is NOT added.
  //
  // Adding output (the previous behaviour) produced a per-turn sawtooth:
  // `lastResponseTokens` is OVERWRITTEN every internal agent-loop turn
  // (chatStore.addTokenUsage), so a new message's small first turn dragged the
  // bar 5%→4%→5% "sem razão aparente". Output continua visível à parte no
  // tooltip ("última resposta").
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

      {/* Hover popover. Placement is caller-driven: in the ChatView header it
          opens BELOW (header has overflow:hidden, so above would clip); in the
          prompt-actions row it opens ABOVE (a downward popover would fall off
          the bottom of the window). */}
      {hovered && (
        <Box
          position="absolute"
          top={popoverPlacement === 'bottom' ? 'calc(100% + 6px)' : undefined}
          bottom={popoverPlacement === 'top' ? 'calc(100% + 6px)' : undefined}
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
              {t('contextInfo.perTurnHeader')}
            </Text>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>{t('contextInfo.promptInput')}</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(inputTokens)}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>{t('contextInfo.lastResponse')}</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(outputTokens)}
              </Text>
            </Flex>
            <Box h="1px" bg="rgba(255,255,255,0.06)" my="2px" />
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>{t('contextInfo.effectiveWindow')}</Text>
              <Text fontSize="10px" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(effectiveWindow)}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>{t('contextInfo.rawWindow')}</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(rawContextWindow)}
              </Text>
            </Flex>
            <Flex justify="space-between" gap="12px">
              <Text fontSize="10px" color={tokens.colors.text.muted}>{t('contextInfo.pressure')}</Text>
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
              <Text fontSize="10px" color={tokens.colors.text.muted}>{t('contextInfo.autoCompactAt')}</Text>
              <Text fontSize="10px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                {formatTokens(compactThreshold)}
              </Text>
            </Flex>
            {/* Pico só quando conta uma história diferente da ocupação actual
                (>5% acima) — a barra segue o valor corrente, o pico fica como
                referência de quão longe a conversa já esteve. */}
            {peakPromptTokens > pressureTokens * 1.05 && (
              <Flex justify="space-between" gap="12px">
                <Text fontSize="10px" color={tokens.colors.text.muted}>{t('contextInfo.sessionPeak')}</Text>
                <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
                  {formatTokens(peakPromptTokens)}
                </Text>
              </Flex>
            )}
            <Text fontSize="9px" color={tokens.colors.text.disabled} lineHeight="1.4" mt="2px">
              {t('contextInfo.differentMetric')}
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
