import { memo, useEffect, useState, useRef } from 'react'
import { Box, Flex, Text, HStack, VStack } from '@chakra-ui/react'
import { FiChevronDown } from 'react-icons/fi'
import { tokens } from '../../theme/tokens'
import { useSettingsStore } from '../../stores/settingsStore'
import { isInOverageState, extraConsumptionPct, useBillingStore, isTeamCollabActive, type UserPlanName, type CostBudgetStatus } from '../../stores/billingStore'
import { t } from '../../i18n'

export const PLAN_DISPLAY: Record<UserPlanName, { label: string; color: string }> = {
  explorer:  { label: 'Free',  color: tokens.colors.text.muted },
  vibe:      { label: 'Vibe',  color: tokens.colors.accent.green },
  pro:       { label: 'Pro',   color: tokens.colors.accent.purple },
  max:       { label: 'Max',   color: tokens.colors.accent.primary },
  welcome:   { label: 'Vibe',  color: tokens.colors.accent.green },
  'byok-only': { label: 'BYOK', color: tokens.colors.accent.orange },
}

interface CreditIndicatorProps {
  plan: UserPlanName
  noCredits: boolean
  isStreaming: boolean
  consumedPct: number       // 0–1 normal, > 1 overage
  tokensConsumed: number
  tokenBudget: number
  cycleEnd: string          // "YYYY-MM-DD"
  status: CostBudgetStatus
  tmsRemaining: number
}

function CreditIndicatorInner(props: CreditIndicatorProps) {
  const [showDetail, setShowDetail] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const prevPctRef = useRef(0)
  const [flash, setFlash] = useState(false)
  // Debounce the refresh button so spam-clicks don't hammer Firestore
  const lastRefreshAt = useRef(0)
  const REFRESH_DEBOUNCE_MS = 1000

  // Plano de Equipas: quando o user é membro, o billing principal já reflete a
  // FATIA do membro (control-plane projeta mySliceTokens/myConsumedPct). Aqui só
  // mudamos o ENQUADRAMENTO (badge "Equipa", "a tua fatia") e o CTA de bloqueio.
  // Quando o plano de equipa expira e não é renovado, o enquadramento de equipa
  // some (o badge "Equipa" volta a plano pessoal) — mesmo que a cache de arranque
  // ainda traga `team`, o gate por DATA em isTeamCollabActive anula-o.
  const rawTeam = useBillingStore(s => s.team)
  const teamCollabActive = useBillingStore(isTeamCollabActive)
  const team = teamCollabActive ? rawTeam : null
  const planInfo = PLAN_DISPLAY[props.plan] || PLAN_DISPLAY.explorer
  const badgeLabel = team ? t('chat.teamBadge') : planInfo.label
  const badgeColor = team ? tokens.colors.accent.purple : planInfo.color
  const isTeamOwner = team?.role === 'owner'
  const pct = Math.round(props.consumedPct * 100)
  // Cycle bar width is capped at 100 — overflow goes to the overage segment
  const cycleBarPct = Math.min(100, pct)
  // Overage segment shows excess beyond 100 (e.g. consumedPct=1.05 → 5%)
  const overagePct = Math.max(0, props.consumedPct - 1)
  // Show overage UI when EITHER the request was charged to TMS overage OR
  // the cycle is exhausted (consumed_pct > 1, includes spillover requests).
  const isInOverage = isInOverageState(props.status, props.consumedPct)
  const isBlocked = props.status === 'rejected'
  // Single source of truth — same metric used in SettingsView and elsewhere.
  const extraPct = extraConsumptionPct(props.tmsRemaining, props.tokenBudget)

  // Flash animation when consumedPct increases
  useEffect(() => {
    if (props.consumedPct > prevPctRef.current && prevPctRef.current > 0) {
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 600)
      return () => clearTimeout(timer)
    }
    prevPctRef.current = props.consumedPct
  }, [props.consumedPct])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDetail) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowDetail(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDetail])

  // Color based on cost-budget status
  function getBarColor(p: number): string {
    if (p >= 1) return tokens.colors.accent.red
    if (p >= 0.95) return tokens.colors.accent.orange
    if (p >= 0.80) return '#f0b429' // yellow
    return `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`
  }

  const pillBg = isBlocked
    ? 'rgba(248, 81, 73, 0.08)'
    : isInOverage
    ? 'rgba(247, 127, 0, 0.08)'
    : 'rgba(255, 255, 255, 0.04)'

  const pillBorder = showDetail
    ? 'rgba(255, 255, 255, 0.15)'
    : isBlocked ? 'rgba(248, 81, 73, 0.2)'
    : isInOverage ? 'rgba(247, 127, 0, 0.2)'
    : 'rgba(255, 255, 255, 0.06)'

  // Format the cycle reset date — "DD MMM" or relative "in N days"
  const appLang = useSettingsStore(s => s.appLanguage)
  function formatCycleEnd(yyyymmdd: string): string {
    if (!yyyymmdd) return ''
    try {
      const date = new Date(`${yyyymmdd}T23:59:59Z`)
      const locale = appLang === 'pt' ? 'pt' : 'en'
      return date.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
    } catch { return yyyymmdd }
  }
  function daysUntil(yyyymmdd: string): number {
    if (!yyyymmdd) return 0
    try {
      const date = new Date(`${yyyymmdd}T23:59:59Z`)
      return Math.max(0, Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    } catch { return 0 }
  }
  const maxUtil = props.consumedPct

  return (
    <Box position="relative" ref={ref}>
      <HStack
        gap={1.5}
        px={2}
        py="3px"
        borderRadius={tokens.radius.full}
        bg={pillBg}
        border="1px solid"
        borderColor={pillBorder}
        cursor="pointer"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
        onClick={() => setShowDetail(!showDetail)}
      >
        {/* Plan badge (ou "Equipa" quando em equipa) */}
        <Text fontSize="9px" fontWeight="700" color={badgeColor} textTransform="uppercase" letterSpacing="0.04em">
          {badgeLabel}
        </Text>

        {/* Single % indicator */}
        <Text
          fontSize="10px"
          fontWeight="600"
          fontFamily={tokens.fontFamily.mono}
          color={maxUtil >= 1 ? tokens.colors.accent.red : maxUtil >= 0.95 ? tokens.colors.accent.orange : maxUtil >= 0.80 ? '#f0b429' : tokens.colors.text.secondary}
          css={flash ? {
            animation: 'creditFlash 0.6s ease',
            '@keyframes creditFlash': {
              '0%': { transform: 'scale(1)' },
              '30%': { transform: 'scale(1.2)' },
              '100%': { transform: 'scale(1)' },
            }
          } : undefined}
        >
          {props.tokenBudget > 0 ? `${pct}%` : ''}
        </Text>

        {/* Mini cycle progress bar (with overage segment if > 100) */}
        <VStack gap="1px" flexShrink={0}>
          <Box w="28px" h="3px" borderRadius="full" bg="rgba(255, 255, 255, 0.08)" overflow="hidden" position="relative">
            {props.tokenBudget > 0 && (
              <Box h="100%" borderRadius="full" bg={getBarColor(props.consumedPct)} width={`${Math.max(2, cycleBarPct)}%`} transition="width 0.5s ease" />
            )}
          </Box>
          {/* Overage segment — only when consumedPct > 1 */}
          {overagePct > 0 && (
            <Box w="28px" h="2px" borderRadius="full" bg="rgba(247, 127, 0, 0.15)" overflow="hidden">
              <Box h="100%" borderRadius="full" bg={tokens.colors.accent.orange} width={`${Math.min(100, Math.max(2, overagePct * 100))}%`} transition="width 0.5s ease" />
            </Box>
          )}
        </VStack>

        {/* Streaming pulse */}
        {props.isStreaming && (
          <Box w="5px" h="5px" borderRadius="full" bg={tokens.colors.accent.primary} flexShrink={0}
            css={{ animation: 'consumePulse 1s ease-in-out infinite', '@keyframes consumePulse': { '0%, 100%': { opacity: 0.4 }, '50%': { opacity: 1 } } }}
          />
        )}

        <FiChevronDown size={8} color={tokens.colors.text.disabled}
          style={{ transition: 'transform 0.15s', transform: showDetail ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </HStack>

      {/* Detail dropdown */}
      {showDetail && (
        <VStack
          position="absolute" top="calc(100% + 4px)" right={0} minW="260px"
          bg={tokens.colors.bg.overlay} border="1px solid" borderColor={tokens.colors.border.panel}
          borderRadius="8px" boxShadow="0 8px 24px rgba(0,0,0,0.4)" py={2} px={3} gap={2}
          zIndex={tokens.zIndex.dropdown}
        >
          {/* Plan header */}
          <Flex justify="space-between" align="center" w="100%">
            <HStack gap={1.5}>
              <Box w="6px" h="6px" borderRadius="full" bg={badgeColor} />
              <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary}>{badgeLabel}</Text>
            </HStack>
            {isInOverage && (
              <Text fontSize="9px" fontWeight="700" color={tokens.colors.accent.orange} textTransform="uppercase">
                {t('chat.tmsOverage')}
              </Text>
            )}
          </Flex>

          {/* Cycle progress */}
          {props.tokenBudget > 0 && (
            <VStack gap={0.5} align="stretch" w="100%">
              <Flex justify="space-between" w="100%">
                <Text fontSize="10px" color={tokens.colors.text.muted}>{team ? t('chat.teamSlice') : t('chat.sessionMonthly')}</Text>
                <Text fontSize="10px" fontFamily={tokens.fontFamily.mono}
                  color={props.consumedPct >= 1 ? tokens.colors.accent.red : props.consumedPct >= 0.95 ? tokens.colors.accent.orange : props.consumedPct >= 0.80 ? '#f0b429' : tokens.colors.text.secondary}>
                  {pct}%
                </Text>
              </Flex>
              {/* Cycle bar (capped at 100%) */}
              <Box w="100%" h="4px" borderRadius="full" bg="rgba(255, 255, 255, 0.06)" overflow="hidden">
                <Box h="100%" borderRadius="full"
                  bg={getBarColor(props.consumedPct)}
                  width={`${Math.max(2, cycleBarPct)}%`}
                  transition="width 0.5s ease" />
              </Box>
              {/* Overage bar (only if consumedPct > 1) */}
              {overagePct > 0 && (
                <Box w="100%" h="3px" borderRadius="full" bg="rgba(247, 127, 0, 0.12)" overflow="hidden" mt={0.5}>
                  <Box h="100%" borderRadius="full"
                    bg={tokens.colors.accent.orange}
                    width={`${Math.min(100, Math.max(2, overagePct * 100))}%`}
                    transition="width 0.5s ease" />
                </Box>
              )}
              {/* Cycle reset date — token counts removed */}
              {props.cycleEnd && (
                <Flex justify="flex-end" w="100%">
                  <Text fontSize="9px" color={tokens.colors.text.disabled}>
                    {t('chat.resetsIn')} {formatCycleEnd(props.cycleEnd)} ({daysUntil(props.cycleEnd)}d)
                  </Text>
                </Flex>
              )}
            </VStack>
          )}

          {/* Extra consumption — single source of truth: extraConsumptionPct
              in billingStore. Hidden when null (no plan budget or no extra). */}
          {extraPct !== null && (
            <>
              <Box w="100%" h="1px" bg={isInOverage ? 'rgba(247, 127, 0, 0.15)' : 'rgba(255, 255, 255, 0.06)'} />
              <Flex justify="space-between" w="100%">
                <Text fontSize="10px" color={isInOverage ? tokens.colors.accent.orange : tokens.colors.text.muted}>
                  {t('chat.tmsRemaining')}
                </Text>
                <Text fontSize="10px" fontWeight="700" fontFamily={tokens.fontFamily.mono}
                  color={isInOverage ? tokens.colors.accent.orange : tokens.colors.text.primary}>
                  {extraPct}%
                </Text>
              </Flex>
            </>
          )}

          {/* Blocked warning. Em equipa o MEMBRO não compra (CTA estático "fala
              com o teu admin"); o OWNER pode gerir a equipa (abre a web). Fora
              de equipa, abre o studio para upgrade/compra. */}
          {isBlocked && team && !isTeamOwner && (
            <>
              <Box w="100%" h="1px" bg="rgba(248, 81, 73, 0.15)" />
              <Text w="100%" py="4px" fontSize="10px" color={tokens.colors.accent.red} textAlign="left">
                {t('chat.teamAskAdmin')}
              </Text>
            </>
          )}
          {isBlocked && (!team || isTeamOwner) && (
            <>
              <Box w="100%" h="1px" bg="rgba(248, 81, 73, 0.15)" />
              <Box
                as="button" w="100%" py="4px" fontSize="10px"
                color={tokens.colors.accent.red}
                cursor="pointer"
                textAlign="left"
                transition={`opacity ${tokens.transition.fast}`}
                _hover={{ opacity: 0.8 }}
                onClick={() => {
                  const url = team ? 'https://code.toquemedia.net/account/team' : 'https://code.toquemedia.net'
                  import('@tauri-apps/plugin-opener').then(opener => {
                    opener.openUrl(url).catch(() => {})
                  })
                }}
              >
                {team ? t('chat.teamManage') : props.plan === 'explorer' ? t('settings.upgradeForMore') : t('chat.buyTms')} →
              </Box>
            </>
          )}

          {/* Refresh button — debounced to prevent spam */}
          <Box w="100%" h="1px" bg="rgba(255, 255, 255, 0.06)" />
          <Box
            as="button" w="100%" py="4px" fontSize="10px" color={tokens.colors.text.disabled}
            cursor="pointer" transition={`color ${tokens.transition.fast}`}
            _hover={{ color: tokens.colors.text.secondary }}
            onClick={() => {
              const now = Date.now()
              if (now - lastRefreshAt.current < REFRESH_DEBOUNCE_MS) return
              lastRefreshAt.current = now
              import('../../services/auth/firebaseAuth').then(m => {
                m.default.getInstance().fetchBillingInfo()
              })
            }}
          >
            {t('chat.refreshCredits')}
          </Box>
        </VStack>
      )}
    </Box>
  )
}

// Header pill — eight billingStore-derived props arrive from a parent that
// re-renders frequently (status bar). Memo means the component skips work
// when the parent re-renders without prop changes; when billingStore really
// did update, shallow prop comparison still passes and the component runs.
export const CreditIndicator = memo(CreditIndicatorInner)
