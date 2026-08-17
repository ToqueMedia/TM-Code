import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { usePersonaStore } from '../../stores/personaStore'
import { useActiveModelStore } from '../../stores/activeModelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { MODEL_PROFILES } from '../../services/agent/modelProfiles'
import {
  resolveContextWindow,
  buildContextOccupancyDetails,
  type ContextOccupancyDetails,
} from '../../utils/contextWindow'
import { resolveSessionOccupancy } from '../../utils/sessionOccupancy'
import { recallServedWindow } from '../../services/agent/servedWindowMemory'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import type { TranslationKey } from '@/i18n/translations'

const SIZE = 18
const STROKE = 2.2
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function formatTokenCount(n: number, lang: 'en' | 'pt'): string {
  return n.toLocaleString(lang === 'pt' ? 'pt-PT' : 'en-US')
}

function compactThousands(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Flex justify="space-between" gap={4} mt="3px">
      <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.muted}>
        {label}
      </Text>
      <Text
        fontSize={tokens.fontSize.xs}
        color={color ?? tokens.colors.text.primary}
        fontFamily={tokens.fontFamily.mono}
        fontVariantNumeric="tabular-nums"
      >
        {value}
      </Text>
    </Flex>
  )
}

export function ContextOccupancyHoverCard({
  details,
  lang,
  t,
}: {
  details: ContextOccupancyDetails
  lang: 'en' | 'pt'
  t: (key: TranslationKey) => string
}) {
  const fmt = (n: number) => formatTokenCount(n, lang)
  const headline = t('contextInfo.usedOfUseful')
    .replace('{used}', fmt(details.used))
    .replace('{useful}', fmt(details.effective))
    .replace('{pct}', String(details.usedPct))

  return (
    <Box>
      <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.secondary} mb={1}>
        {t('contextInfo.title')}
      </Text>
      {details.hasUsage ? (
        <>
          <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
            {headline}
          </Text>
          <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.muted} mt="2px" fontFamily={tokens.fontFamily.mono}>
            {fmt(details.free)} {t('contextInfo.remaining')}
          </Text>
          <Box mt={2} borderTop={`1px solid ${tokens.colors.border.panel}`} pt={1.5}>
            <Row label={t('contextInfo.prompt')} value={fmt(details.prompt)} />
            <Row label={t('contextInfo.response')} value={fmt(details.response)} />
            {details.peak > 0 && (
              <Row label={t('contextInfo.peak')} value={fmt(details.peak)} />
            )}
          </Box>
        </>
      ) : (
        <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.secondary}>
          {t('contextInfo.empty')}
        </Text>
      )}
      <Box mt={2} borderTop={`1px solid ${tokens.colors.border.panel}`} pt={1.5}>
        <Row label={t('contextInfo.modelWindow')} value={fmt(details.rawWindow)} />
        <Row label={t('contextInfo.reserved')} value={fmt(details.reserved)} />
        <Row label={t('contextInfo.compactAt')} value={fmt(details.threshold)} />
        {details.hasUsage && !details.atThreshold && (
          <Row label={t('contextInfo.untilCompact')} value={fmt(details.untilCompact)} />
        )}
      </Box>
      {details.hasUsage && details.atThreshold && (
        <Text fontSize={tokens.fontSize.xs} color={tokens.colors.accent.red} mt={2} fontWeight="600">
          {t('contextInfo.atThreshold')}
        </Text>
      )}
      {details.hasUsage && !details.atThreshold && (
        <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.muted} mt={2}>
          {t('contextInfo.belowThreshold')}
        </Text>
      )}
      <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} mt={2}>
        {t('contextInfo.more')}
      </Text>
    </Box>
  )
}

function ContextWindowIndicator() {
  const t = useTranslation()
  const lang = useSettingsStore((s) => s.appLanguage)
  const [hover, setHover] = useState(false)

  // Cada selector TEM de devolver um primitivo. Um objeto novo por
  // getSnapshot faz o useSyncExternalStore do React 18 entrar em
  // "Maximum update depth exceeded" ao montar o composer (abrir projecto).
  const inputTokens = useChatStore((s) => {
    const id = s.streamingSessionId ?? s.activeSessionId
    if (!id) return 0
    const session = s.sessions.get(id)
    return session ? resolveSessionOccupancy(session).promptTokens : 0
  })
  const responseTokens = useChatStore((s) => {
    const id = s.streamingSessionId ?? s.activeSessionId
    if (!id) return 0
    const session = s.sessions.get(id)
    return session ? resolveSessionOccupancy(session).responseTokens : 0
  })
  const peakTokens = useChatStore((s) => {
    const id = s.streamingSessionId ?? s.activeSessionId
    if (!id) return 0
    const session = s.sessions.get(id)
    return session ? resolveSessionOccupancy(session).peakTokens : 0
  })
  const headerContextWindow = useAgentStore((s) => s.modelContextWindow)
  const modelMaxOutputTokens = useAgentStore((s) => s.modelMaxOutputTokens)
  const selectedPersona = usePersonaStore((s) => s.selected)
  const personaWindow = useActiveModelStore((s) => s.personaModels[selectedPersona]?.contextWindow)
  const modelName = useAgentStore((s) => s.modelName)
  const modelProvider = useAgentStore((s) => s.modelProvider)
  const sessionByokContextWindow = useChatStore((s) => {
    if (!s.activeSessionId) return undefined
    const w = s.sessions.get(s.activeSessionId)?.byokSnapshot?.contextWindow
    return w && w > 0 ? w : undefined
  })
  const sessionByokModelId = useChatStore((s) => {
    if (!s.activeSessionId) return undefined
    return s.sessions.get(s.activeSessionId)?.byokSnapshot?.modelId
  })

  const profileModelName = sessionByokModelId ?? modelName
  const learned = recallServedWindow(modelProvider, profileModelName)
  const resolved = resolveContextWindow({
    byokContextWindow: sessionByokContextWindow,
    headerContextWindow,
    personaContextWindow: personaWindow,
    learnedContextWindow: learned?.contextWindow,
    profileContextWindow: profileModelName
      ? MODEL_PROFILES[profileModelName]?.contextWindow
      : undefined,
    headerMaxOutputTokens: modelMaxOutputTokens,
    learnedMaxOutputTokens: learned?.maxOutputTokens,
    profileMaxOutputTokens: profileModelName
      ? MODEL_PROFILES[profileModelName]?.maxOutputTokens
      : undefined,
  })
  const rawWindow = resolved.contextWindow
  if (rawWindow <= 0) return null

  const details = buildContextOccupancyDetails({
    promptTokens: inputTokens,
    responseTokens: responseTokens,
    peakTokens,
    rawWindow,
    maxOutputTokens: resolved.maxOutputTokens,
  })
  const fill = details.effective > 0 ? Math.min(1, details.used / details.effective) : 0
  const dash = CIRCUMFERENCE * fill
  const color = details.atThreshold
    ? tokens.colors.accent.red
    : fill >= 0.7
      ? tokens.colors.accent.orange
      : tokens.colors.text.muted
  const aria = details.hasUsage
    ? t('contextInfo.aria')
      .replace('{pct}', String(details.usedPct))
      .replace('{free}', compactThousands(details.free))
    : t('contextInfo.ariaEmpty')

  return (
    <Box
      position="relative"
      flexShrink={0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <Box
        as="button"
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="28px"
        h="28px"
        borderRadius="full"
        bg="transparent"
        border="none"
        cursor="default"
        aria-label={aria}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={tokens.colors.border.panel}
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
      </Box>
      {hover && (
        <Box
          position="absolute"
          bottom="calc(100% + 8px)"
          right={0}
          zIndex={tokens.zIndex.dropdown}
          minW="248px"
          px={3}
          py={2}
          bg={tokens.colors.bg.overlay}
          border={`1px solid ${tokens.colors.border.panel}`}
          borderRadius="8px"
          boxShadow={tokens.shadow.panel}
          pointerEvents="none"
        >
          <ContextOccupancyHoverCard details={details} lang={lang} t={t} />
        </Box>
      )}
    </Box>
  )
}

export default memo(ContextWindowIndicator)
