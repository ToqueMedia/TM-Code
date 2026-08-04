import { memo, useState, useCallback, useEffect } from 'react'
import {
  Box,
  Button,
  Field,
  Flex,
  HStack,
  Input,
  NativeSelect,
  Switch,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { FiArrowLeft, FiPlus, FiTrash2, FiSquare, FiRefreshCw, FiServer, FiExternalLink, FiLogOut } from 'react-icons/fi'
import { useLayoutStore } from '../../stores/layoutStore'
import { useSettingsStore, DEFAULT_SHORTCUTS, CHAT_TEXT_FONT_SIZE_OPTIONS, type ShortcutId, type KeyBinding } from '../../stores/settingsStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useUpdateStore } from '../../stores/updateStore'
import KeyBindingDisplay from '../ui/KeyBindingDisplay'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore, McpServerState } from '../../stores/mcpStore'
import { useProjectStore } from '../../stores/projectStore'
import { useAuthStore } from '../../stores/authStore'
import { useBillingStore, extraConsumptionPct, isTeamCollabActive } from '../../stores/billingStore'
import FirebaseAuthService from '../../services/auth/firebaseAuth'
import SkillService from '../../services/agent/skillService'
import MCPService from '../../services/mcp/mcpService'
import { invoke } from '@/utils/invokeMetrics'
import { installUpdate, checkForUpdate } from '../../services/updateService'
import { IS_WINDOWS } from '@/utils/platform'
import { tokens } from '@/theme/tokens'
import { useTranslation, t } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import ApiKeysSection from './settings/ApiKeysSection'

type SectionId = 'profile' | 'editor' | 'shortcuts' | 'skills' | 'mcp' | 'apiKeys' | 'sandbox' | 'admin'

const BASE_NAV_KEYS: { id: SectionId; key: TranslationKey }[] = [
  { id: 'profile', key: 'settings.profilePlan' },
  { id: 'editor', key: 'settings.editor' },
  { id: 'sandbox', key: 'settings.sandbox' as TranslationKey },
  { id: 'shortcuts', key: 'settings.shortcuts' },
  { id: 'skills', key: 'settings.skills' },
  { id: 'mcp', key: 'settings.mcpServers' },
]

const API_KEYS_NAV_ENTRY: { id: SectionId; key: TranslationKey } = {
  id: 'apiKeys',
  key: 'settings.apiKeys' as TranslationKey,
}

const ADMIN_NAV_ENTRY: { id: SectionId; key: TranslationKey } = {
  id: 'admin',
  key: 'settings.admin' as TranslationKey,
}

interface SettingsViewProps {
  onBack?: () => void
}

// All SectionId values that callers outside SettingsView can request via
// `layoutStore.settingsInitialSection`. Keep aligned with the SectionId union
// above — TS will flag any drift because we cast through `SectionId` below.
const ALLOWED_INITIAL_SECTIONS: ReadonlyArray<SectionId> = [
  'profile', 'editor', 'shortcuts', 'skills', 'mcp', 'apiKeys', 'sandbox', 'admin',
]

function SettingsView({ onBack }: SettingsViewProps = {}) {
  // Honour any pending `settingsInitialSection` set by the caller (e.g. the
  // ModelIndicator wants Chave API, not Profile). Consume-once: clear the
  // pending value as soon as we read it so the next Settings open from a
  // generic entry point defaults to Profile again. The validation step
  // narrows the unknown string from the store back to our local SectionId
  // union — anything outside the allow-list falls back to 'profile'.
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const requested = useLayoutStore.getState().settingsInitialSection
    if (requested && (ALLOWED_INITIAL_SECTIONS as readonly string[]).includes(requested)) {
      return requested as SectionId
    }
    return 'profile'
  })
  useEffect(function clearPendingInitialSection() {
    // Fire after mount so we don't race the initializer above. Idempotent —
    // clearing twice is fine because the store ignores no-op writes.
    useLayoutStore.getState().clearSettingsInitialSection()
  }, [])
  const t = useTranslation()
  const isAdmin = useAuthStore(function (s) { return s.user?.isAdmin === true })
  // `isAdmin` is populated by /v1/me. Before that fetch lands (first login,
  // no persisted value) we're in an indeterminate state. Render a placeholder
  // nav entry so a returning admin who opens Settings within the first 1–3s
  // doesn't briefly see a non-admin layout. If /v1/me resolves to
  // isAdmin=false we drop the placeholder automatically.
  const isAdminUnknown = useAuthStore(function (s) {
    return s.isAuthenticated && s.user?.isAdmin === undefined
  })
  const billingLoaded = useBillingStore(function (s) { return s.isLoaded })
  const showAdminNav = isAdmin || (isAdminUnknown && !billingLoaded)
  // BYOK is ALWAYS available — no global feature flag, no per-plan check.
  // Backend mirrors this: the chat path accepts BYOK headers for any
  // authenticated user regardless of plan. The previous gating via
  // `featuresStore.byokEnabled` (kill switch) and the per-plan
  // `subscription_plans/{plan}.byokAllowed` check were both removed when
  // the staged rollout ended.
  // Order: profile, editor, sandbox, shortcuts, skills, mcp, apiKeys, [admin]
  const NAV_KEYS = (() => {
    const base = [...BASE_NAV_KEYS, API_KEYS_NAV_ENTRY]
    return showAdminNav ? [...base, ADMIN_NAV_ENTRY] : base
  })()

  return (
    <Flex flex="1" overflow="hidden">
      {/* Left nav */}
      <Flex
        direction="column"
        w="200px"
        flexShrink={0}
        bg={tokens.colors.bg.sidebar}
        borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
      >
        <Box
          as="button"
          display="flex"
          alignItems="center"
          gap={2}
          px={4}
          h="44px"
          cursor="pointer"
          color={tokens.colors.text.secondary}
          bg="transparent"
          border="none"
          textAlign="left"
          w="100%"
          transition={tokens.transition.fast}
          _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
          onClick={function () { onBack ? onBack() : useLayoutStore.getState().goBack() }}
          flexShrink={0}
          data-no-drag
        >
          <FiArrowLeft size={14} />
          <Text fontSize="13px" fontWeight="500">{t('settings.title')}</Text>
        </Box>

        <Box h="1px" bg={tokens.colors.border.sidebarPanel} />

        <VStack align="stretch" gap={0} pt={2} px={2}>
          {NAV_KEYS.map(function (item) {
            const isActive = activeSection === item.id
            return (
              <Box
                key={item.id}
                as="button"
                display="block"
                textAlign="left"
                px={3}
                py="7px"
                borderRadius={tokens.radius.lg}
                fontSize="13px"
                fontWeight={isActive ? '500' : '400'}
                color={isActive ? tokens.colors.text.primary : tokens.colors.text.secondary}
                bg={isActive ? tokens.colors.bg.activeItem : 'transparent'}
                cursor="pointer"
                transition={tokens.transition.fast}
                _hover={{
                  bg: isActive ? tokens.colors.bg.activeItem : tokens.colors.bg.hoverSubtle,
                  color: tokens.colors.text.primary,
                }}
                onClick={function () { setActiveSection(item.id) }}
              >
                {t(item.key)}
              </Box>
            )
          })}
        </VStack>
      </Flex>

      {/* Content */}
      <Flex direction="column" flex="1" overflow="hidden">
        <Flex
          align="center"
          px={8}
          h="52px"
          flexShrink={0}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        >
          <Text fontSize="16px" fontWeight="600" color={tokens.colors.text.primary}>
            {t(NAV_KEYS.find(function (n) { return n.id === activeSection })?.key || 'settings.profilePlan')}
          </Text>
        </Flex>

        <Box flex="1" overflowY="auto" px={8} py={6}>
          <Box maxW="640px">
            {activeSection === 'profile' && <ProfileSection />}
            {activeSection === 'editor' && <EditorSection />}
            {activeSection === 'sandbox' && <SandboxSection />}
            {activeSection === 'shortcuts' && <ShortcutsSection />}
            {activeSection === 'skills' && <SkillsSection />}
            {activeSection === 'mcp' && <McpSection />}
            {activeSection === 'apiKeys' && <ApiKeysSection />}
            {activeSection === 'admin' && showAdminNav && <AdminSection />}
          </Box>
        </Box>
      </Flex>
    </Flex>
  )
}

// ━━━ Profile & Plan Section ━━━

const PLAN_CONFIG: Record<string, { labelKey: string; color: string; creditsLabelKey: string; isTop: boolean }> = {
  explorer: { labelKey: 'Free', color: tokens.colors.text.muted,     creditsLabelKey: 'settings.monthlyCredits', isTop: false },
  vibe:     { labelKey: 'Vibe', color: tokens.colors.accent.green,   creditsLabelKey: 'settings.monthlyCredits', isTop: false },
  pro:      { labelKey: 'Pro',  color: tokens.colors.accent.purple,  creditsLabelKey: 'settings.monthlyCredits', isTop: false },
  max:      { labelKey: 'Max',  color: tokens.colors.accent.primary, creditsLabelKey: 'settings.monthlyCredits', isTop: true  },
  welcome:  { labelKey: 'Vibe', color: tokens.colors.accent.green,   creditsLabelKey: 'settings.monthlyCredits', isTop: false },
  'byok-only': { labelKey: 'BYOK', color: tokens.colors.accent.orange, creditsLabelKey: 'settings.monthlyCredits', isTop: false },
}

function ProfileSection() {
  const t = useTranslation()
  const user = useAuthStore(s => s.user)
  const plan = useBillingStore(s => s.plan)
  const billingLoaded = useBillingStore(s => s.isLoaded)
  const consumedPct = useBillingStore(s => s.consumedPct)
  const tokenBudget = useBillingStore(s => s.tokenBudget)
  const cycleEnd = useBillingStore(s => s.cycleEnd)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  const noCredits = useBillingStore(s => s.noCredits)
  const team = useBillingStore(s => s.team)
  // Team section shows only while the team plan is active (membership + non-expired
  // term). Date-based so a lapsed plan hides it even if the boot cache still has
  // teamMemberOf. See isTeamCollabActive.
  const teamCollabActive = useBillingStore(isTeamCollabActive)
  const [modeBusy, setModeBusy] = useState(false)
  const [modeErr, setModeErr] = useState<string | null>(null)
  const teamActive = !!team // consumo a faturar a equipa agora
  async function setConsumeMode(active: boolean) {
    if (modeBusy || active === teamActive) return
    setModeBusy(true); setModeErr(null)
    try {
      await FirebaseAuthService.getInstance().setTeamBillingMode(active)
    } catch (e) {
      setModeErr(e instanceof Error ? e.message : 'Falhou.')
    } finally {
      setModeBusy(false)
    }
  }
  const appLanguage = useSettingsStore(s => s.appLanguage)
  const agentLanguage = useSettingsStore(s => s.agentLanguage)
  const setAppLanguage = useSettingsStore(s => s.setAppLanguage)
  const setAgentLanguage = useSettingsStore(s => s.setAgentLanguage)

  const planKey = plan || 'explorer'
  const planInfo = PLAN_CONFIG[planKey] || PLAN_CONFIG.explorer
  const isFree = planKey === 'explorer'
  const isTopPlan = planInfo.isTop

  // Display + bar honesty:
  //   - 0 consumption → "0%" label and bar width 0 (no bar)
  //   - 0 < consumedPct < 0.01 → "<1%" label and bar width 2% (visible sliver)
  //   - 0.01..1 → rounded %; bar width exactly tracks value (floor 2% so it's
  //     always >= the minimum visible thickness, but only when there is usage)
  //   - > 1 (overage) → "100%+" capped, bar full-red
  // Prevents the prior mismatch where Math.round() dropped sub-1% to "0%"
  // while Math.max(2, …) still rendered a visible 2% sliver.
  const pct = billingLoaded && tokenBudget > 0 ? consumedPct : null
  const consumedPctLabel = pct === null
    ? '—'
    : pct <= 0
      ? '0%'
      : pct >= 1
        ? `${Math.round(pct * 100)}%`  // 100 or overage — show actual
        : pct < 0.01
          ? '<1%'
          : `${Math.round(pct * 100)}%`
  const barWidthPct = pct === null || pct <= 0
    ? 0
    : Math.min(100, Math.max(2, pct * 100))

  // "Consumo extra" — single source of truth in billingStore.extraConsumptionPct.
  // tmsRemaining / tokenBudget × 100 (e.g. 500K extra on a 2M plan = 25%).
  const extraCapacityPct = billingLoaded ? extraConsumptionPct(tmsRemaining, tokenBudget) : null

  async function handleSignOut() {
    try {
      await FirebaseAuthService.getInstance().signOut()
      // Auth + billing reset handled by onAuthStateChanged(null) in firebaseAuth.ts
      useAuthStore.getState().clear()
    } catch {}
  }

  async function openStudio() {
    try {
      const opener = await import('@tauri-apps/plugin-opener')
      await opener.openUrl('https://code.toquemedia.net/upgrade')
    } catch {}
  }

  // Prefer the Firebase/Firestore display name; fall back to the email's local
  // part (e.g. "kwanzaonline@gmail.com" → "Kwanzaonline") so the profile shows a
  // meaningful name even when no displayName was set (emulator/test users,
  // email-password accounts). Generic "User" only as a last resort.
  const emailName = user?.email?.split('@')[0] ?? ''
  const prettyEmailName = emailName ? emailName.charAt(0).toUpperCase() + emailName.slice(1) : ''
  const resolvedName = user?.displayName || prettyEmailName || t('common.user')
  const initials = resolvedName
    ? resolvedName.split(/[\s._-]+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.[0]?.toUpperCase() || '?'

  return (
    <VStack align="stretch" gap={8}>

      {/* ── Account ─────────────────────────────────────── */}
      <VStack align="stretch" gap={4}>
        <Flex align="center" gap={4}>
          {user?.photoURL ? (
            <Box w="44px" h="44px" borderRadius="full" overflow="hidden" flexShrink={0}>
              <img src={user.photoURL} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </Box>
          ) : (
            <Flex
              w="44px" h="44px" borderRadius="full" flexShrink={0}
              align="center" justify="center"
              bg={`linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`}
            >
              <Text fontSize="15px" fontWeight="700" color="white">{initials}</Text>
            </Flex>
          )}
          <Box flex={1} minW={0}>
            <Text fontSize="14px" fontWeight="600" color={tokens.colors.text.primary} lineClamp={1}>
              {resolvedName}
            </Text>
            <Text fontSize="12px" color={tokens.colors.text.secondary} lineClamp={1}>
              {user?.email || '—'}
            </Text>
          </Box>
          <Box
            as="button" display="flex" alignItems="center" gap="5px"
            px={2.5} py="5px" borderRadius={tokens.radius.md}
            fontSize="12px" color={tokens.colors.text.muted} bg="transparent"
            cursor="pointer" transition={tokens.transition.fast}
            _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.accent.redSubtle }}
            onClick={handleSignOut}
          >
            <FiLogOut size={12} />{t("common.signOut")}
          </Box>
        </Flex>

        <Box h="1px" bg={tokens.colors.border.subtle} />
      </VStack>

      {/* ── Plan & Credits ──────────────────────────────── */}
      <VStack align="stretch" gap={3}>
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.06em">
          {t("settings.planCredits")}
        </Text>

        <Flex justify="space-between" align="center">
          <HStack gap={2.5}>
            <Box w="8px" h="8px" borderRadius="full" bg={planInfo.color} boxShadow={`0 0 6px ${planInfo.color}40`} />
            <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
              {billingLoaded ? planInfo.labelKey : '...'}
            </Text>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>{t(planInfo.creditsLabelKey as any)}</Text>
          </HStack>
          {!isTopPlan && (
            <Box
              as="button" display="flex" alignItems="center" gap="5px"
              px={2.5} py="4px" borderRadius={tokens.radius.md}
              fontSize="12px" fontWeight="500"
              color={tokens.colors.accent.primary} bg={tokens.colors.accent.primarySubtle}
              cursor="pointer" transition={tokens.transition.fast}
              _hover={{ bg: tokens.colors.accent.primaryHover }}
              onClick={openStudio}
            >
              {t("settings.upgrade")}<FiExternalLink size={11} />
            </Box>
          )}
        </Flex>

        {/* Cycle budget bar */}
        <Box>
          <Flex justify="space-between" align="center" mb={1.5}>
            <Text fontSize="12px" color={tokens.colors.text.secondary}>{t("settings.creditsRemaining")}</Text>
            <Text
              fontSize="13px" fontWeight="700" fontFamily={tokens.fontFamily.mono}
              color={noCredits ? tokens.colors.accent.red : tokens.colors.text.primary}
            >
              {consumedPctLabel}
            </Text>
          </Flex>
          {billingLoaded && tokenBudget > 0 && (
            <>
              <Box h="3px" borderRadius="full" bg={tokens.colors.border.subtle} overflow="hidden">
                <Box
                  h="100%" borderRadius="full"
                  bg={consumedPct >= 1
                    ? tokens.colors.accent.red
                    : consumedPct >= 0.95
                    ? tokens.colors.accent.orange
                    : consumedPct >= 0.80
                    ? '#f0b429'
                    : `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`
                  }
                  width={`${barWidthPct}%`}
                  transition="width 0.5s ease"
                />
              </Box>
              <Flex justify="space-between" align="center" mt={1}>
                {cycleEnd && (
                  <Text fontSize="10px" color={tokens.colors.text.disabled}>
                    {t('settings.resetsOn' as any)} {cycleEnd}
                  </Text>
                )}
              </Flex>
              {extraCapacityPct !== null && (
                <Text fontSize="11px" color={tokens.colors.accent.orange} mt={1.5}>
                  {extraCapacityPct}% {t('settings.extraConsumption' as any)}
                </Text>
              )}
            </>
          )}
          {noCredits && (
            <Text fontSize="11px" color={tokens.colors.accent.red} mt={1.5}>
              {isFree ? t('settings.upgradeForMore') : t('settings.buyMore')}
            </Text>
          )}
        </Box>

        {/* Action links */}
        <HStack gap={2} mt={1}>
          {!isFree && (
            <Box
              as="button" display="flex" alignItems="center" gap="5px"
              px={2.5} py="5px" borderRadius={tokens.radius.md}
              fontSize="12px" fontWeight="500"
              color={tokens.colors.text.secondary} bg={tokens.colors.bg.card}
              border="1px solid" borderColor={tokens.colors.bg.cardBorder}
              cursor="pointer" transition={tokens.transition.fast}
              _hover={{ borderColor: tokens.colors.border.default, color: tokens.colors.text.primary }}
              onClick={openStudio}
            >
              <FiPlus size={11} />{t("settings.buyCredits")}
            </Box>
          )}
          <Box
            as="button" display="flex" alignItems="center" gap="5px"
            px={2.5} py="5px" borderRadius={tokens.radius.md}
            fontSize="12px" fontWeight="500"
            color={tokens.colors.text.secondary} bg={tokens.colors.bg.card}
            border="1px solid" borderColor={tokens.colors.bg.cardBorder}
            cursor="pointer" transition={tokens.transition.fast}
            _hover={{ borderColor: tokens.colors.border.default, color: tokens.colors.text.primary }}
            onClick={openStudio}
          >
            <FiExternalLink size={11} />{t("settings.manageAccount")}
          </Box>
        </HStack>

        <Box h="1px" bg={tokens.colors.border.subtle} />
      </VStack>

      {/* ── Team (Plano de Equipas) ─────────────────────── */}
      {teamCollabActive && (
        <VStack align="stretch" gap={3}>
          <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.06em">
            {t('settings.teamTitle' as any)}
          </Text>

          {/* Detalhes (só quando o consumo está em modo equipa) */}
          {team ? (
            <VStack align="stretch" gap={1.5}>
              <Flex justify="space-between" align="center">
                <HStack gap={2.5}>
                  <Box w="8px" h="8px" borderRadius="full" bg={tokens.colors.accent.purple} />
                  <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
                    {team.tier === 'team-max' ? 'Team Max' : 'Team Pro'}
                  </Text>
                  <Text fontSize="11px" color={tokens.colors.text.disabled}>
                    {team.role === 'owner' ? t('settings.teamAdmin' as any) : t('settings.teamMember' as any)}
                  </Text>
                </HStack>
                <Text fontSize="12px" color={tokens.colors.text.secondary}>
                  {t('settings.teamYourSlice' as any)} {Math.round(team.mySlicePct * 100)}%
                </Text>
              </Flex>
            </VStack>
          ) : (
            <Text fontSize="12px" color={tokens.colors.text.secondary}>
              {t('settings.teamPersonalActive' as any)}
            </Text>
          )}

          {/* Toggle de consumo Pessoal/Equipa — como escolher BYOK vs plano */}
          <Box>
            <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1.5}>{t('settings.consumeMode' as any)}</Text>
            <HStack gap={0} p="3px" borderRadius={tokens.radius.full} bg={tokens.colors.bg.card} border="1px solid" borderColor={tokens.colors.bg.cardBorder} w="fit-content">
              {([['personal', false], ['team', true]] as const).map(([key, val]) => {
                const active = teamActive === val
                return (
                  <Box
                    key={key}
                    as="button"
                    px={3} py="4px" borderRadius={tokens.radius.full}
                    fontSize="12px" fontWeight={active ? '600' : '500'}
                    bg={active ? tokens.colors.accent.purple : 'transparent'}
                    color={active ? 'white' : tokens.colors.text.muted}
                    cursor={modeBusy || active ? 'default' : 'pointer'}
                    opacity={modeBusy ? 0.6 : 1}
                    transition={tokens.transition.fast}
                    onClick={() => setConsumeMode(val)}
                  >
                    {val ? t('settings.consumeTeam' as any) : t('settings.consumePersonal' as any)}
                  </Box>
                )
              })}
            </HStack>
            <Text fontSize="10px" color={tokens.colors.text.disabled} mt={1.5}>
              {t('settings.consumeHint' as any)}
            </Text>
            {modeErr && <Text fontSize="11px" color={tokens.colors.accent.red} mt={1}>{modeErr}</Text>}
          </Box>

          <Box h="1px" bg={tokens.colors.border.subtle} />
        </VStack>
      )}

      {/* ── App Update ──────────────────────────────────── */}
      <UpdateSection />

      {/* ── Language ─────────────────────────────────────── */}
      <VStack align="stretch" gap={3}>
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.06em">
          {t("settings.language")}
        </Text>

        <HStack justify="space-between" align="center">
          <Box>
            <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">{t("settings.interface")}</Text>
            <Text color={tokens.colors.text.disabled} fontSize="11px">{t("settings.interfaceDesc")}</Text>
          </Box>
          <NativeSelect.Root size="sm" width="160px">
            <NativeSelect.Field
              bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary} value={appLanguage}
              onChange={e => setAppLanguage(e.target.value as 'en' | 'pt')}
            >
              <option value="en">English</option>
              <option value="pt">Português</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>

        <HStack justify="space-between" align="center">
          <Box>
            <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">{t("settings.agent")}</Text>
            <Text color={tokens.colors.text.disabled} fontSize="11px">{t("settings.agentDesc")}</Text>
          </Box>
          <NativeSelect.Root size="sm" width="160px">
            <NativeSelect.Field
              bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary} value={agentLanguage}
              onChange={e => setAgentLanguage(e.target.value as 'en' | 'pt' | 'zh' | 'es' | 'fr' | 'de' | 'ja')}
            >
              <option value="en">English</option>
              <option value="pt">Português</option>
              <option value="zh">中文</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="ja">日本語</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>
      </VStack>

    </VStack>
  )
}

// ━━━ Update Section ━━━

function UpdateSection() {
  const t = useTranslation()
  const pendingUpdate = useUpdateStore(s => s.pendingUpdate)
  const setPendingUpdate = useUpdateStore(s => s.setPendingUpdate)
  const [status, setStatus] = useState<'idle' | 'checking' | 'downloading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleCheck = useCallback(async () => {
    setStatus('checking')
    setError(null)
    const minDelay = new Promise(r => setTimeout(r, 800))
    try {
      const [result] = await Promise.all([checkForUpdate(), minDelay])
      // Persist so the banner survives navigation away from Settings
      setPendingUpdate(result)
      setStatus('idle')
    } catch (err) {
      await minDelay
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [setPendingUpdate])

  const handleInstall = useCallback(async () => {
    setStatus('downloading')
    setError(null)
    try {
      await installUpdate()
      // relaunch happens inside installUpdate — this line is unreachable
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  return (
    <VStack align="stretch" gap={3}>
      <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.06em">
        {t('settings.appUpdate')}
      </Text>

      {pendingUpdate ? (
        <Flex
          align="center" justify="space-between"
          px={4} py={3} borderRadius={tokens.radius.lg}
          bg="rgba(254, 16, 99, 0.06)"
          border="1px solid rgba(254, 16, 99, 0.15)"
        >
          <Box>
            <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
              TM Code {pendingUpdate.version} {t('settings.updateAvailable')}
            </Text>
            <Text fontSize="11px" color={tokens.colors.text.secondary} mt={0.5}>
              {t('settings.updateRestart')}
            </Text>
          </Box>
          <Button
            size="sm"
            bg={tokens.colors.accent.primary}
            color="white"
            borderRadius={tokens.radius.md}
            fontSize="12px"
            fontWeight="600"
            px={4}
            _hover={{ bg: tokens.colors.accent.primaryDark }}
            disabled={status === 'downloading'}
            onClick={status === 'downloading' ? undefined : handleInstall}
          >
            {status === 'downloading' ? t('settings.updateDownloading') : t('settings.updateNow')}
          </Button>
        </Flex>
      ) : (
        <Flex align="center" justify="space-between">
          <Text fontSize="13px" color={tokens.colors.text.secondary}>
            {status === 'error' ? t('settings.updateCheckFailed') : t('settings.updateUpToDate')}
          </Text>
          <Box
            as="button" display="flex" alignItems="center" gap="5px"
            px={2.5} py="5px" borderRadius={tokens.radius.md}
            fontSize="12px" fontWeight="500"
            color={tokens.colors.text.secondary} bg={tokens.colors.bg.card}
            border="1px solid" borderColor={tokens.colors.bg.cardBorder}
            outline="none"
            cursor={status === 'checking' ? 'default' : 'pointer'}
            opacity={status === 'checking' ? 0.6 : 1}
            transition={tokens.transition.fast}
            _hover={{ borderColor: tokens.colors.border.default, color: tokens.colors.text.primary }}
            onClick={status === 'checking' ? undefined : handleCheck}
          >
            <Box
              display="inline-flex"
              css={status === 'checking' ? {
                animation: 'spin 1s linear infinite',
                '@keyframes spin': { to: { transform: 'rotate(360deg)' } },
              } : undefined}
            >
              <FiRefreshCw size={11} />
            </Box>
            {status === 'checking' ? t('settings.updateChecking') : t('settings.updateCheck')}
          </Box>
        </Flex>
      )}

      {error && (
        <Text fontSize="11px" color={tokens.colors.accent.red}>{error}</Text>
      )}

      <Box h="1px" bg={tokens.colors.border.subtle} />
    </VStack>
  )
}

// ━━━ Editor Section ━━━

function SandboxSection() {
  const t = useTranslation()
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
  const hardBlockSecondProjectWindow = useSettingsStore(s => s.hardBlockSecondProjectWindow)
  const setHardBlockSecondProjectWindow = useSettingsStore(s => s.setHardBlockSecondProjectWindow)
  const autoModePermissions = usePermissionStore(s => s.autoModePermissions)
  const setAutoModePermissions = usePermissionStore(s => s.setAutoModePermissions)
  const setSandboxEnabled = useSettingsStore(s => s.setSandboxEnabled)
  const [sandboxAvailable, setSandboxAvailable] = useState(false)
  const [platform, setPlatform] = useState('')
  const [depsOk, setDepsOk] = useState(true)
  const [depsMissing, setDepsMissing] = useState<string[]>([])
  const [depsHints, setDepsHints] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(function () {
    invoke<{ enabled: boolean; available: boolean; platform: string }>('sandbox_status').then(function (info) {
      setSandboxAvailable(info.available)
      setPlatform(info.platform)
      setLoading(false)
    })
    invoke<{ ok: boolean; missing: string[]; hints: string[] }>('sandbox_check_deps').then(function (deps) {
      setDepsOk(deps.ok)
      setDepsMissing(deps.missing)
      setDepsHints(deps.hints)
    })
  }, [])

  function handleToggle(checked: boolean) {
    setSandboxEnabled(checked) // persists to localStorage + syncs to Rust
  }

  const platformLabel = platform === 'macos' ? 'sandbox-exec (Seatbelt)'
    : platform === 'linux' ? 'bubblewrap (bwrap)'
    : platform === 'windows' ? 'WSL2 + bubblewrap'
    : 'Not available'

  return (
    <VStack align="stretch" gap={6}>
      {/* F3: task worktrees setting removed with intra-project multi-agent. */}

      <SettingsGroup title={t('project.windowsGroup')}>
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t('project.hardBlockSecondWindow')}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('project.hardBlockSecondWindowDesc')}
              </Text>
            </Box>
            <Switch.Root
              checked={hardBlockSecondProjectWindow}
              onCheckedChange={function (e) { setHardBlockSecondProjectWindow(e.checked) }}
              colorPalette="pink"
            >
              <Switch.HiddenInput />
              <Switch.Control />
            </Switch.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t('autoMode.title')}>
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t('autoMode.title')}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('autoMode.description')}
              </Text>
              <Text color={tokens.colors.text.disabled} fontSize="11px" mt="4px">
                {t('autoMode.note')}
              </Text>
            </Box>
            <Switch.Root
              checked={autoModePermissions}
              onCheckedChange={function (e) { setAutoModePermissions(e.checked) }}
              colorPalette="pink"
            >
              <Switch.HiddenInput />
              <Switch.Control />
            </Switch.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t('sandbox.title')}>
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t('sandbox.title')}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('sandbox.description')}
              </Text>
            </Box>
            {!loading && (
              <Switch.Root
                checked={sandboxEnabled}
                onCheckedChange={function (e) { handleToggle(e.checked) }}
                colorPalette="pink"
                disabled={!sandboxAvailable}
              >
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            )}
          </HStack>
        </Field.Root>

        <Box h="1px" bg={tokens.colors.border.subtle} />

        <VStack align="stretch" gap={2} px={1}>
          <HStack justify="space-between">
            <Text fontSize="12px" color={tokens.colors.text.secondary}>{t('settings.engine')}</Text>
            <Text fontSize="12px" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
              {platformLabel}
            </Text>
          </HStack>
          <HStack justify="space-between">
            <Text fontSize="12px" color={tokens.colors.text.secondary}>{t('settings.state')}</Text>
            <HStack gap={1.5}>
              <Box
                w="6px" h="6px" borderRadius="full"
                bg={sandboxEnabled ? tokens.colors.accent.green : tokens.colors.text.disabled}
              />
              <Text fontSize="12px" color={sandboxEnabled ? tokens.colors.accent.green : tokens.colors.text.disabled}>
                {sandboxEnabled ? t('settings.active') : t('settings.inactive')}
              </Text>
            </HStack>
          </HStack>
        </VStack>

        {sandboxEnabled && (
          <>
            <Box h="1px" bg={tokens.colors.border.subtle} />
            <VStack align="stretch" gap={1} px={1}>
              <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.05em">
                Protecções activas
              </Text>
              <Text fontSize="12px" color={tokens.colors.text.secondary}>
                {platform === 'macos'
                  ? 'Filesystem: apenas projecto + /tmp. Executáveis: /usr, /bin, /opt, tools. Network: sem restrição (npm/git). Bloqueado: ~/.ssh, ~/.aws, ~/.gnupg, keychains.'
                  : 'Filesystem: / read-only, projecto read-write. Bloqueado: ~/.ssh, ~/.aws, ~/.gnupg, ~/.docker, .bash_history, .netrc, .npmrc, .git-credentials.'
                }
              </Text>
            </VStack>
          </>
        )}

        {!depsOk && !loading && (
          <VStack align="stretch" gap={1} px={1}>
            <Text fontSize="12px" color={tokens.colors.accent.orange} fontWeight="500">
              Dependências em falta:
            </Text>
            {depsMissing.map(function (dep, i) {
              return <Text key={i} fontSize="12px" color={tokens.colors.accent.red}>• {dep}</Text>
            })}
            {depsHints.map(function (hint, i) {
              return <Text key={i} fontSize="11px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>{hint}</Text>
            })}
          </VStack>
        )}
      </SettingsGroup>

      <FlaggedCommandsSection />
    </VStack>
  )
}

// ── All commands that can be flagged for approval ──
// Import the canonical list from toolExecutor to keep UI and logic in sync
import ToolExecutor from '../../services/agent/toolExecutor'

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  'rm': 'Remove files or directories',
  'rmdir': 'Remove empty directories',
  'mv': 'Move or rename files',
  'cp': 'Copy files or directories',
  'chmod': 'Change file permissions',
  'chown': 'Change file ownership',
  'ln': 'Create symbolic links',
  'mkfs': 'Format a disk partition',
  'dd': 'Low-level disk copy',
  'shutdown': 'Shut down the system',
  'reboot': 'Reboot the system',
  'git push': 'Push commits to remote',
  'git reset': 'Reset commit history',
  'git checkout': 'Switch branches or restore files',
  'git merge': 'Merge branches',
  'git rebase': 'Rebase commit history',
  'git stash': 'Stash uncommitted changes',
  'git clean': 'Remove untracked files',
  'git commit': 'Create a commit',
  'npm uninstall': 'Remove packages (npm)',
  'yarn remove': 'Remove packages (yarn)',
  'pnpm remove': 'Remove packages (pnpm)',
  'kill': 'Kill a process by PID',
  'pkill': 'Kill processes by name',
  'killall': 'Kill all processes by name',
  'sudo': 'Run as superuser',
  'su': 'Switch user',
  'doas': 'Run as another user',
  'pkexec': 'Run as privileged user',
  'wget': 'Download files from the web',
  'launchctl': 'Manage macOS services',
  'systemctl': 'Manage Linux services',
  'docker': 'Docker container commands',
  'docker-compose': 'Docker Compose commands',
}

const FLAGGABLE_COMMANDS = ToolExecutor.DANGEROUS_COMMANDS.map(cmd => ({
  command: cmd,
  label: cmd,
  description: COMMAND_DESCRIPTIONS[cmd] || cmd,
}))

function FlaggedCommandsSection() {
  const t = useTranslation()
  const flaggedCommands = useSettingsStore(s => s.flaggedCommands)
  const toggleFlaggedCommand = useSettingsStore(s => s.toggleFlaggedCommand)

  return (
    <SettingsGroup title={t('settings.flaggedCommands')}>
      <Text fontSize="12px" color={tokens.colors.text.secondary} mb={3}>
        {t('settings.flaggedCommandsDesc')}
      </Text>
      <VStack
        align="stretch"
        gap={0}
        maxH="calc(100vh - 380px)"
        overflowY="auto"
        css={{
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '4px' },
        }}
      >
        {FLAGGABLE_COMMANDS.map(({ command, label, description }) => {
          const isActive = flaggedCommands.includes(command)
          return (
            <Flex
              key={command}
              align="center"
              gap={3}
              py="6px"
              px={2}
              borderRadius={tokens.radius.md}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              cursor="pointer"
              onClick={() => toggleFlaggedCommand(command)}
            >
              {/* Checkbox — checked = agent must ask before running */}
              <Box
                w="16px"
                h="16px"
                borderRadius="4px"
                border={`1.5px solid ${isActive ? tokens.colors.accent.red : tokens.colors.border.default}`}
                bg={isActive ? tokens.colors.accent.red : 'transparent'}
                display="flex"
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
                transition={tokens.transition.fast}
              >
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </Box>
              <Box flex={1} minW={0}>
                <Text fontSize="13px" fontWeight="500" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
                  {label}
                </Text>
                <Text fontSize="11px" color={tokens.colors.text.disabled}>{description}</Text>
              </Box>
              {isActive && (
                <Text fontSize="10px" color={tokens.colors.accent.red} fontWeight="600" flexShrink={0}>
                  {t('settings.blocked')}
                </Text>
              )}
            </Flex>
          )
        })}
      </VStack>
    </SettingsGroup>
  )
}

function EditorSection() {
  const t = useTranslation()
  const autocompleteEnabled = useSettingsStore(function (s) { return s.autocomplete.enabled })
  const tabSize = useSettingsStore(function (s) { return s.editor.tabSize })
  const insertSpaces = useSettingsStore(function (s) { return s.editor.insertSpaces })
  const detectIndentation = useSettingsStore(function (s) { return s.editor.detectIndentation })
  const formatOnSave = useSettingsStore(function (s) { return s.formatOnSave })
  const autoSave = useSettingsStore(function (s) { return s.autoSave })
  const setAutoSave = useSettingsStore(function (s) { return s.setAutoSave })
  const chatTextFontSize = useSettingsStore(function (s) { return s.chatTextFontSize })

  const setAutocompleteEnabled = useSettingsStore(function (s) { return s.setAutocompleteEnabled })
  const setTabSize = useSettingsStore(function (s) { return s.setTabSize })
  const setInsertSpaces = useSettingsStore(function (s) { return s.setInsertSpaces })
  const setDetectIndentation = useSettingsStore(function (s) { return s.setDetectIndentation })
  const setFormatOnSave = useSettingsStore(function (s) { return s.setFormatOnSave })
  const setChatTextFontSize = useSettingsStore(function (s) { return s.setChatTextFontSize })

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title={t('settings.accessibility')}>
        <Field.Root>
          <HStack justify="space-between" align="center" gap={4}>
            <Box minW={0}>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t('settings.chatTextSize')}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('settings.chatTextSizeDesc')}
              </Text>
            </Box>
            <NativeSelect.Root size="sm" width="150px" flexShrink={0}>
              <NativeSelect.Field
                bg={tokens.colors.bg.input}
                borderColor={tokens.colors.border.input}
                color={tokens.colors.text.primary}
                value={String(chatTextFontSize)}
                onChange={function (e) {
                  const v = parseInt(e.target.value, 10)
                  if (!Number.isNaN(v)) setChatTextFontSize(v)
                }}
              >
                {CHAT_TEXT_FONT_SIZE_OPTIONS.map(function (size) {
                  return (
                    <option key={size} value={String(size)}>
                      {size === 14 ? t('settings.textSizeDefault') : `${size}px`}
                    </option>
                  )
                })}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t("settings.aiAutocomplete")}>
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t("settings.enableAutocomplete")}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('settings.autocompleteDesc')}
              </Text>
            </Box>
            <Switch.Root checked={autocompleteEnabled} onCheckedChange={function (e) { setAutocompleteEnabled(e.checked) }} colorPalette="pink">
              <Switch.HiddenInput />
              <Switch.Control />
            </Switch.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t("settings.autoSaveGroup")}>
        <Field.Root>
          <HStack justify="space-between" align="center" gap={4}>
            <Box minW={0}>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t('settings.autoSave')}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('settings.autoSaveDesc')}
              </Text>
            </Box>
            <NativeSelect.Root size="sm" width="180px" flexShrink={0}>
              <NativeSelect.Field
                bg={tokens.colors.bg.input}
                borderColor={tokens.colors.border.input}
                color={tokens.colors.text.primary}
                value={autoSave}
                onChange={function (e) {
                  const v = e.target.value
                  if (v === 'off' || v === 'afterDelay' || v === 'onFocusChange') setAutoSave(v)
                }}
              >
                <option value="afterDelay">{t('settings.autoSaveAfterDelay')}</option>
                <option value="onFocusChange">{t('settings.autoSaveOnFocusChange')}</option>
                <option value="off">{t('settings.autoSaveOff')}</option>
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t("settings.formatting")}>
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t('settings.formatOnSave')}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('settings.formatOnSaveDesc')}
              </Text>
            </Box>
            <Switch.Root checked={formatOnSave} onCheckedChange={function (e) { setFormatOnSave(e.checked) }} colorPalette="pink">
              <Switch.HiddenInput />
              <Switch.Control />
            </Switch.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t("settings.indentation")}>
        <VStack align="stretch" gap={4}>
          <Field.Root>
            <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px" mb={1}>
              {t('settings.tabSize')}
            </Text>
            <NativeSelect.Root size="sm" width="120px">
              <NativeSelect.Field
                bg={tokens.colors.bg.input}
                borderColor={tokens.colors.border.input}
                color={tokens.colors.text.primary}
                value={String(tabSize)}
                onChange={function (e) { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setTabSize(v) }}
              >
                <option value="2">2</option>
                <option value="4">4</option>
                <option value="8">8</option>
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>

          <Field.Root>
            <HStack justify="space-between">
              <Box>
                <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                  {t('settings.insertSpaces')}
                </Text>
                <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                  {t('settings.insertSpacesDesc')}
                </Text>
              </Box>
              <Switch.Root checked={insertSpaces} onCheckedChange={function (e) { setInsertSpaces(e.checked) }} colorPalette="blue">
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </HStack>
          </Field.Root>

          <Field.Root>
            <HStack justify="space-between">
              <Box>
                <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                  {t('settings.detectIndentation')}
                </Text>
                <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                  {t('settings.detectIndentationDesc')}
                </Text>
              </Box>
              <Switch.Root checked={detectIndentation} onCheckedChange={function (e) { setDetectIndentation(e.checked) }} colorPalette="blue">
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </HStack>
          </Field.Root>
        </VStack>
      </SettingsGroup>
    </VStack>
  )
}

// ━━━ Shortcuts Section ━━━

const SHORTCUT_ORDER: ShortcutId[] = [
  'diffAccept', 'diffAcceptAll', 'diffReject', 'diffRejectAll',
  'quickOpen', 'commandPalette', 'toggleTerminal', 'toggleSidebar',
  'splitEditor', 'goToLine', 'searchInProject', 'settings',
  'openFile', 'newProject', 'closeFile',
]

function ShortcutsSection() {
  const t = useTranslation()
  const shortcuts = useSettingsStore(s => s.shortcuts)
  const setShortcut = useSettingsStore(s => s.setShortcut)
  const resetShortcuts = useSettingsStore(s => s.resetShortcuts)
  const [editingId, setEditingId] = useState<ShortcutId | null>(null)
  const [pendingBinding, setPendingBinding] = useState<KeyBinding | null>(null)

  // Capture key combo when editing + cancel on click outside
  useEffect(() => {
    if (!editingId) return

    function handleKey(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()

      // Enter confirms the pending binding
      if (e.key === 'Enter' && pendingBinding && editingId) {
        setShortcut(editingId, pendingBinding)
        setEditingId(null)
        setPendingBinding(null)
        return
      }

      // Escape cancels (with or without pending — always exit edit mode)
      if (e.key === 'Escape') {
        setEditingId(null)
        setPendingBinding(null)
        return
      }

      // Ignore lone modifier presses
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return

      const binding: KeyBinding = { key: e.key }
      if (e.metaKey || e.ctrlKey) binding.meta = true
      if (e.shiftKey) binding.shift = true
      if (e.altKey) binding.alt = true

      setPendingBinding(binding)
    }

    // Cancel editing if user clicks anywhere (focus moved away)
    function handleClick() {
      setEditingId(null)
      setPendingBinding(null)
    }

    window.addEventListener('keydown', handleKey, true)
    // Delay click listener to avoid the same click that started editing
    const timer = setTimeout(() => window.addEventListener('click', handleClick), 100)
    return () => {
      window.removeEventListener('keydown', handleKey, true)
      window.removeEventListener('click', handleClick)
      clearTimeout(timer)
    }
  }, [editingId, pendingBinding, setShortcut])

  return (
    <VStack align="stretch" gap={4}>
      <Box>
        <Text fontSize="12px" color={tokens.colors.text.muted} mb={3}>
          {t('settings.shortcutsDesc')}
        </Text>
      </Box>

      <Box
        borderRadius="10px"
        border={`1px solid ${tokens.colors.border.subtle}`}
        overflow="hidden"
      >
        {SHORTCUT_ORDER.map((id, idx) => {
          const isEditing = editingId === id
          const isModified = JSON.stringify(shortcuts[id]) !== JSON.stringify(DEFAULT_SHORTCUTS[id])

          return (
            <Flex
              key={id}
              align="center"
              justify="space-between"
              px={4}
              py="10px"
              bg={isEditing ? 'rgba(254, 16, 99, 0.06)' : 'transparent'}
              borderTop={idx > 0 ? `1px solid ${tokens.colors.border.subtle}` : undefined}
              _hover={{ bg: isEditing ? undefined : 'rgba(255, 255, 255, 0.02)' }}
              cursor="pointer"
              onClick={() => {
                if (!isEditing) {
                  setEditingId(id)
                  setPendingBinding(null)
                }
              }}
            >
              <Flex align="center" gap={2}>
                <Text fontSize="13px" color={tokens.colors.text.primary}>
                  {t(`settings.shortcut.${id}` as TranslationKey)}
                </Text>
                {isModified && !isEditing && (
                  <Box w="5px" h="5px" borderRadius="full" bg={tokens.colors.accent.primary} flexShrink={0} />
                )}
              </Flex>
              {isEditing ? (
                <Box
                  px="10px"
                  py="4px"
                  borderRadius="6px"
                  bg="rgba(254, 16, 99, 0.12)"
                  border={`1px solid ${tokens.colors.accent.primary}`}
                  minW="60px"
                  textAlign="center"
                >
                  {pendingBinding ? (
                    <KeyBindingDisplay binding={pendingBinding} />
                  ) : (
                    <Text fontSize="12px" color={tokens.colors.accent.primary} fontStyle="italic">
                      {t('settings.pressKeys')}
                    </Text>
                  )}
                </Box>
              ) : (
                <KeyBindingDisplay binding={shortcuts[id]} />
              )}
            </Flex>
          )
        })}
      </Box>

      <Button
        variant="ghost"
        size="sm"
        color={tokens.colors.text.secondary}
        _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
        onClick={resetShortcuts}
        alignSelf="flex-start"
      >
        {t('settings.resetShortcuts')}
      </Button>
    </VStack>
  )
}

// ━━━ Skills Section ━━━

function SkillsSection() {
  const t = useTranslation()
  const skills = useSkillStore(function (s) { return s.skills })
  const isLoading = useSkillStore(function (s) { return s.isLoading })
  const projectPath = useProjectStore(function (s) { return s.currentProject?.path })
  const [showNewSkill, setShowNewSkill] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillScope, setNewSkillScope] = useState<'project' | 'global'>('project')
  const [newSkillContent, setNewSkillContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const loadSkills = useCallback(async function () {
    if (!projectPath) return
    useSkillStore.getState().setLoading(true)
    try {
      const skillService = SkillService.getInstance()
      skillService.invalidateCache()
      const loaded = await skillService.loadSkills(projectPath)
      useSkillStore.getState().setSkills(loaded)
    } catch (error) {
      useSkillStore.getState().setError(error instanceof Error ? error.message : String(error))
    }
  }, [projectPath])

  useEffect(function () { loadSkills() }, [loadSkills])

  async function handleCreateSkill() {
    if (!newSkillName.trim() || !newSkillContent.trim()) return
    setIsSaving(true)
    try {
      const skillService = SkillService.getInstance()
      if (newSkillScope === 'project' && projectPath) {
        await skillService.createProjectSkill(projectPath, newSkillName, newSkillContent)
      } else {
        await skillService.createGlobalSkill(newSkillName, newSkillContent)
      }
      setShowNewSkill(false)
      setNewSkillName('')
      setNewSkillContent('')
      await loadSkills()
    } catch { /* */ } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteSkill(skill: { id: string; name: string; path: string; scope: string }) {
    if (skill.scope === 'bundled') return
    try {
      const skillService = SkillService.getInstance()
      await skillService.deleteSkill(skill as Parameters<typeof skillService.deleteSkill>[0])
      await loadSkills()
    } catch { /* */ }
  }

  const bundledSkills = skills.filter(function (s) { return s.scope === 'bundled' })
  const globalSkills = skills.filter(function (s) { return s.scope === 'global' })
  const projectSkills = skills.filter(function (s) { return s.scope === 'project' })

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title={t("settings.bundled")} badge={t("settings.autoDetected")}>
        {isLoading ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t('settings.loadingSkills')}</Text>
        ) : bundledSkills.length === 0 ? (
          <EmptyState text={t('settings.noBundledSkills')} />
        ) : (
          <VStack align="stretch" gap={1}>
            {bundledSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="bundled" />
            })}
          </VStack>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.global")} badge={IS_WINDOWS ? '%USERPROFILE%\\.toquemedia-studio\\skills\\' : '~/.toquemedia-studio/skills/'}>
        {globalSkills.length === 0 ? (
          <EmptyState text={t('settings.noGlobalSkills')} />
        ) : (
          <VStack align="stretch" gap={1}>
            {globalSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="global" onDelete={function () { handleDeleteSkill(skill) }} />
            })}
          </VStack>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.project")} badge={IS_WINDOWS ? '.toquemedia-studio\\skills\\' : '.toquemedia-studio/skills/'}>
        {projectSkills.length === 0 ? (
          <EmptyState text={t('settings.noProjectSkills')} />
        ) : (
          <VStack align="stretch" gap={1}>
            {projectSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="project" onDelete={function () { handleDeleteSkill(skill) }} />
            })}
          </VStack>
        )}
      </SettingsGroup>

      {showNewSkill ? (
        <Box p={4} borderRadius={tokens.radius.xl} border="1px solid" borderColor={tokens.colors.border.default} bg={tokens.colors.bg.overlay}>
          <VStack align="stretch" gap={3}>
            <HStack gap={3}>
              <Box flex={1}>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.name")}</Text>
                <Input size="sm" value={newSkillName} onChange={function (e) { setNewSkillName(e.target.value) }}
                  placeholder={t('preferences.myConventions')} bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                  color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }} />
              </Box>
              <Box>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.scope")}</Text>
                <NativeSelect.Root size="sm" width="120px">
                  <NativeSelect.Field bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                    color={tokens.colors.text.primary} value={newSkillScope}
                    onChange={function (e) { setNewSkillScope(e.target.value as 'project' | 'global') }}>
                    <option value="project">{t('settings.project')}</option>
                    <option value="global">{t('settings.global')}</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Box>
            </HStack>
            <Box>
              <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.content")}</Text>
              <Textarea size="sm" value={newSkillContent} onChange={function (e) { setNewSkillContent(e.target.value) }}
                placeholder={"# My Conventions\n\nWrite your coding conventions here..."}
                bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
                rows={10} fontFamily={tokens.fontFamily.mono} fontSize="12px" />
            </Box>
            <HStack justify="flex-end" gap={2}>
              <Button size="sm" variant="outline" onClick={function () { setShowNewSkill(false) }}
                color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}>{t('settings.cancel')}</Button>
              <Button size="sm" onClick={handleCreateSkill}
                disabled={!newSkillName.trim() || !newSkillContent.trim() || isSaving}
                bg={tokens.colors.accent.primary} color="white"
                _hover={{ bg: tokens.colors.accent.primaryDark }} _disabled={{ opacity: 0.5 }}>
                {isSaving ? t('settings.saving') : t('settings.createSkill')}</Button>
            </HStack>
          </VStack>
        </Box>
      ) : (
        <Button size="sm" variant="outline" onClick={function () { setShowNewSkill(true) }}
          color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }} w="fit-content">
          <FiPlus style={{ marginRight: 6 }} />{t('settings.newSkill')}
        </Button>
      )}

      <Text fontSize="11px" color={tokens.colors.text.disabled}>
        {t('settings.skillsNote')}
      </Text>
    </VStack>
  )
}

// ━━━ MCP Section ━━━

function McpSection() {
  const t = useTranslation()
  const servers = useMcpStore(function (s) { return s.servers })
  const isInitializing = useMcpStore(function (s) { return s.isInitializing })
  const projectPath = useProjectStore(function (s) { return s.currentProject?.path })
  const [showAddServer, setShowAddServer] = useState(false)

  async function handleStop(name: string) {
    try { await MCPService.getInstance().stopServer(name) } catch { /* */ }
  }

  async function handleRemove(name: string) {
    try {
      await MCPService.getInstance().removeServer(projectPath, name)
    } catch (err) {
      console.error('[MCP] Failed to remove server:', err)
    }
  }

  async function handleRestartServer(name: string) {
    try {
      await MCPService.getInstance().stopServer(name)
      await MCPService.getInstance().addSingleServer(projectPath, name)
    } catch { /* */ }
  }

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title={t("settings.activeServers")}>
        {isInitializing ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t('settings.initializingMcp')}</Text>
        ) : servers.length === 0 ? (
          <Box py={6} textAlign="center">
            <Box mb={3} color={tokens.colors.text.disabled}><FiServer size={28} style={{ margin: '0 auto' }} /></Box>
            <Text fontSize="13px" color={tokens.colors.text.muted} mb={1}>{t('settings.noMcpServers')}</Text>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>
              {t('settings.addServerOrEdit')}
            </Text>
          </Box>
        ) : (
          <VStack align="stretch" gap={2}>
            {servers.map(function (server) {
              return (
                <McpServerCard key={server.name} server={server}
                  onStop={function () { handleStop(server.name) }}
                  onRemove={function () { handleRemove(server.name) }}
                  onRestart={function () { handleRestartServer(server.name) }} />
              )
            })}
          </VStack>
        )}
      </SettingsGroup>

      {/* {t('settings.addServer')} Form */}
      {showAddServer ? (
        <AddServerForm
          projectPath={projectPath || ''}
          onDone={function () { setShowAddServer(false) }}
          onCancel={function () { setShowAddServer(false) }}
        />
      ) : (
        <Button size="sm" variant="outline" onClick={function () { setShowAddServer(true) }}
          color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }} w="fit-content">
          <FiPlus style={{ marginRight: 6 }} />{t('settings.addServer')}
        </Button>
      )}

      <Text fontSize="11px" color={tokens.colors.text.disabled}>
        {t('settings.mcpNote')}
      </Text>
    </VStack>
  )
}

// ━━━ Add Server Form ━━━

function McpJsonActionButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <Box
      as="button"
      onClick={() => { if (!disabled) onClick() }}
      px={2}
      py="3px"
      fontSize="10.5px"
      fontWeight="500"
      borderRadius="4px"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.4 : 1}
      bg={tokens.colors.bg.overlay}
      color={tokens.colors.text.muted}
      border={`1px solid ${tokens.colors.border.default}`}
      _hover={disabled ? {} : { color: tokens.colors.text.primary }}
      transition={`color ${tokens.transition.fast}`}
    >
      {label}
    </Box>
  )
}

// Canonical MCP entry shape — matches Claude Desktop / `mcp.json`.
interface McpEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
}

const MCP_JSON_EXAMPLE = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    },
    "linear": {
      "command": "npx",
      "args": ["-y", "@linear/mcp-server"]
    }
  }
}`

/**
 * Parse any of the three input shapes and produce a normalized
 * `{ name → entry }` map. Errors are thrown with user-facing messages.
 *
 *   A) Full config:  { "mcpServers": { name: { command, args?, env? } } }
 *   B) Named entry:  { name: { command, args?, env? } }
 *   C) Bare entry:   { command, args?, env? }  ← requires `fallbackName`
 */
function parseMcpJson(raw: string, fallbackName: string): Record<string, McpEntry> {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(t('settings.emptyJson'))
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : t('settings.invalidJson'))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(t('settings.topLevelObject'))
  }
  const obj = parsed as Record<string, unknown>

  // Shape A — has `mcpServers` wrapper.
  if ('mcpServers' in obj && obj.mcpServers && typeof obj.mcpServers === 'object') {
    const inner = obj.mcpServers as Record<string, unknown>
    const out: Record<string, McpEntry> = {}
    for (const [name, raw] of Object.entries(inner)) {
      out[name] = validateEntry(name, raw)
    }
    return out
  }

  // Shape C — looks like a bare entry (top-level has `command`).
  if ('command' in obj && typeof obj.command === 'string') {
    const name = fallbackName.trim()
    if (!name) throw new Error(t('settings.setNameField'))
    return { [name]: validateEntry(name, obj) }
  }

  // Shape B — every top-level key is a server name pointing at an entry.
  const out: Record<string, McpEntry> = {}
  for (const [name, raw] of Object.entries(obj)) {
    out[name] = validateEntry(name, raw)
  }
  return out
}

function validateEntry(name: string, raw: unknown): McpEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Entry "${name}" must be an object`)
  }
  const e = raw as Record<string, unknown>
  if (typeof e.command !== 'string' || !e.command.trim()) {
    throw new Error(`Entry "${name}" is missing required "command"`)
  }
  const out: McpEntry = { command: e.command.trim() }
  if (e.args !== undefined) {
    if (!Array.isArray(e.args) || !e.args.every((a) => typeof a === 'string')) {
      throw new Error(`Entry "${name}" — "args" must be an array of strings`)
    }
    out.args = e.args as string[]
  }
  if (e.env !== undefined) {
    if (!e.env || typeof e.env !== 'object' || Array.isArray(e.env)) {
      throw new Error(`Entry "${name}" — "env" must be an object`)
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Entry "${name}" — env "${k}" must be a string`)
      }
      env[k] = v
    }
    out.env = env
  }
  return out
}

async function writeMcpEntries(entries: Record<string, McpEntry>): Promise<void> {
  const homeDir = await invoke<string>('get_home_directory')
  const configDir = `${homeDir}/.toquemedia-studio`
  const configPath = `${configDir}/mcp.json`
  let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
  try {
    const existing = await invoke<string>('read_file', { path: configPath })
    config = JSON.parse(existing)
    if (!config.mcpServers) config.mcpServers = {}
  } catch {
    /* no existing config */
  }
  for (const [name, entry] of Object.entries(entries)) {
    config.mcpServers[name] = entry
  }
  await invoke('create_directories_all', { path: configDir })
  await invoke('write_file', {
    path: configPath,
    content: JSON.stringify(config, null, 2),
  })
  for (const name of Object.keys(entries)) {
    await MCPService.getInstance().addSingleServer(undefined, name)
  }
}

function AddServerForm(props: { projectPath: string; onDone: () => void; onCancel: () => void }) {
  const t = useTranslation()
  const [mode, setMode] = useState<'form' | 'json'>('form')

  // Form-mode fields. `name` is also reused by JSON mode for the bare-entry
  // (shape C) fallback — paste raw `{ command, args }` and the Name field
  // resolves which key to write it under.
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envPairs, setEnvPairs] = useState('')

  // JSON-mode state. `jsonPreview` is a derived count of valid entries +
  // first-error message; recomputed inline so we don't need useMemo.
  const [jsonText, setJsonText] = useState('')
  const [jsonValidation, setJsonValidation] = useState<
    | { kind: 'idle' }
    | { kind: 'ok'; count: number; names: string[] }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  // Live JSON validation — debounced via the input cadence (React batches
  // setState within the same event). A separate timer would only matter for
  // very large pastes; an MCP config is ≤ a few KB.
  function updateJson(value: string) {
    setJsonText(value)
    setError('')
    if (!value.trim()) {
      setJsonValidation({ kind: 'idle' })
      return
    }
    try {
      const parsed = parseMcpJson(value, name)
      const names = Object.keys(parsed)
      setJsonValidation({ kind: 'ok', count: names.length, names })
    } catch (err) {
      setJsonValidation({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Detect a JSON-shape paste (`{...}` after trim) and pretty-print it
  // automatically. Most users paste minified or differently-indented JSON
  // copied from Anthropic docs / GitHub READMEs; auto-formatting removes the
  // friction of clicking "Format" right after. Falls through silently for
  // invalid input — validation feedback below handles that case.
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = e.clipboardData.getData('text')
    const trimmed = pasted.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return
    try {
      const parsed = JSON.parse(trimmed)
      e.preventDefault()
      const formatted = JSON.stringify(parsed, null, 2)
      // Replace the entire textarea content. Mixing paste with existing
      // text rarely yields valid JSON anyway.
      updateJson(formatted)
    } catch {
      // Not valid JSON — let the default paste through and the live validator
      // surface the error to the user.
    }
  }

  function formatJson() {
    try {
      const parsed = JSON.parse(jsonText)
      const formatted = JSON.stringify(parsed, null, 2)
      setJsonText(formatted)
      updateJson(formatted)
    } catch {
      // Leave as-is; the validation message already tells the user it's invalid.
    }
  }

  function insertExample() {
    setJsonText(MCP_JSON_EXAMPLE)
    updateJson(MCP_JSON_EXAMPLE)
  }

  // Read clipboard via the navigator API (Tauri's WebView exposes it). On
  // platforms / OS-permission combinations where it's denied, fall back to
  // a clear inline error instead of silently doing nothing.
  async function pasteFromClipboard() {
    if (!navigator.clipboard?.readText) {
      setError(t('settings.mcpJsonClipboardDenied'))
      return
    }
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        setError(t('settings.mcpJsonClipboardEmpty'))
        return
      }
      // Pretty-print when valid JSON; otherwise inject raw and let live
      // validation flag the issue.
      try {
        const parsed = JSON.parse(text.trim())
        updateJson(JSON.stringify(parsed, null, 2))
      } catch {
        updateJson(text)
      }
      setError('')
    } catch {
      setError(t('settings.mcpJsonClipboardDenied'))
    }
  }

  async function handleSaveForm() {
    if (!name.trim()) { setError(t('settings.serverNameRequired')); return }
    if (!command.trim()) { setError(t('settings.commandRequired')); return }
    setIsSaving(true)
    setError('')
    try {
      // Shell-style split: respects "quoted strings" as single args.
      const argsList: string[] = []
      const argRegex = /(?:"([^"]*)")|(?:'([^']*)')|(\S+)/g
      let match: RegExpExecArray | null
      const trimmedArgs = args.trim()
      if (trimmedArgs) {
        while ((match = argRegex.exec(trimmedArgs)) !== null) {
          argsList.push(match[1] ?? match[2] ?? match[3])
        }
      }
      const entry: McpEntry = { command: command.trim() }
      if (argsList.length > 0) entry.args = argsList
      if (envPairs.trim()) {
        const env: Record<string, string> = {}
        for (const line of envPairs.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
        }
        if (Object.keys(env).length > 0) entry.env = env
      }
      await writeMcpEntries({ [name.trim()]: entry })
      props.onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveJson() {
    setError('')
    let entries: Record<string, McpEntry>
    try {
      entries = parseMcpJson(jsonText, name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    if (Object.keys(entries).length === 0) {
      setError(t('settings.mcpJsonEmptyConfig'))
      return
    }
    setIsSaving(true)
    try {
      await writeMcpEntries(entries)
      props.onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  const isJsonSubmittable = jsonValidation.kind === 'ok'

  return (
    <Box
      p={4}
      borderRadius={tokens.radius.xl}
      border="1px solid"
      borderColor={tokens.colors.accent.primaryBorder}
      bg={tokens.colors.bg.overlay}
    >
      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} mb={3}>
        {t('settings.addMcpServer')}
      </Text>

      {/* Tab strip — slim segmented control, no shadcn/Chakra tabs dep */}
      <HStack
        gap={0}
        mb={4}
        p="2px"
        bg={tokens.colors.bg.input}
        borderRadius="8px"
        border={`1px solid ${tokens.colors.border.input}`}
        w="fit-content"
      >
        {(['form', 'json'] as const).map((m) => {
          const active = mode === m
          return (
            <Box
              key={m}
              as="button"
              px={3}
              py="6px"
              borderRadius="6px"
              fontSize="12px"
              fontWeight="500"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              bg={active ? tokens.colors.bg.overlay : 'transparent'}
              color={active ? tokens.colors.text.primary : tokens.colors.text.muted}
              border={active ? `1px solid ${tokens.colors.border.default}` : '1px solid transparent'}
              _hover={active ? {} : { color: tokens.colors.text.secondary }}
              onClick={() => { setMode(m); setError('') }}
            >
              {m === 'form' ? t('settings.mcpTabForm') : t('settings.mcpTabJson')}
            </Box>
          )
        })}
      </HStack>

      {mode === 'form' ? (
        <VStack align="stretch" gap={3}>
          <Box>
            <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t('settings.name')}</Text>
            <Input
              size="sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="chakra-ui"
              bg={tokens.colors.bg.input}
              borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary}
              _placeholder={{ color: tokens.colors.text.placeholder }}
            />
          </Box>
          <Box>
            <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t('settings.command')}</Text>
            <Input
              size="sm"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              bg={tokens.colors.bg.input}
              borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary}
              _placeholder={{ color: tokens.colors.text.placeholder }}
              fontFamily={tokens.fontFamily.mono}
              fontSize="12px"
            />
          </Box>
          <Box>
            <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t('settings.arguments')}</Text>
            <Input
              size="sm"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @chakra-ui/react-mcp"
              bg={tokens.colors.bg.input}
              borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary}
              _placeholder={{ color: tokens.colors.text.placeholder }}
              fontFamily={tokens.fontFamily.mono}
              fontSize="12px"
            />
          </Box>
          <Box>
            <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>
              {t('settings.envVars')}
              <Text as="span" color={tokens.colors.text.disabled}> {t('settings.envOptional')}</Text>
            </Text>
            <Textarea
              size="sm"
              value={envPairs}
              onChange={(e) => setEnvPairs(e.target.value)}
              placeholder={'GITHUB_TOKEN=ghp_...\nAPI_KEY=sk-...'}
              bg={tokens.colors.bg.input}
              borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary}
              _placeholder={{ color: tokens.colors.text.placeholder }}
              rows={2}
              fontFamily={tokens.fontFamily.mono}
              fontSize="12px"
            />
          </Box>
        </VStack>
      ) : (
        <VStack align="stretch" gap={3}>
          <Text fontSize="11.5px" color={tokens.colors.text.muted} lineHeight="1.5">
            {t('settings.mcpJsonHelp')}
          </Text>
          {/* Action bar sits ABOVE the textarea, not floating on top, so the
              buttons never overlap the scrollbar when content wraps and stay
              tabbable in source order. */}
          <HStack gap={1} justify="flex-end">
            <McpJsonActionButton
              onClick={pasteFromClipboard}
              label={t('settings.mcpJsonPaste')}
            />
            <McpJsonActionButton
              onClick={insertExample}
              label={t('settings.mcpJsonExample')}
            />
            <McpJsonActionButton
              onClick={formatJson}
              label={t('settings.mcpJsonFormat')}
              disabled={!jsonText.trim() || jsonValidation.kind === 'error'}
            />
          </HStack>
          <Textarea
            value={jsonText}
            onChange={(e) => updateJson(e.target.value)}
            onPaste={handlePaste}
            placeholder={MCP_JSON_EXAMPLE}
            bg={tokens.colors.bg.input}
            borderColor={
              jsonValidation.kind === 'error'
                ? tokens.colors.accent.red
                : jsonValidation.kind === 'ok'
                  ? tokens.colors.accent.green
                  : tokens.colors.border.input
            }
            color={tokens.colors.text.primary}
            _placeholder={{ color: tokens.colors.text.disabled }}
            rows={12}
            fontFamily={tokens.fontFamily.mono}
            fontSize="12px"
            lineHeight="1.5"
            spellCheck={false}
            resize="vertical"
          />
          {jsonValidation.kind === 'ok' && (
            <HStack gap={2} align="center">
              <Box w="6px" h="6px" borderRadius="50%" bg={tokens.colors.accent.green} />
              <Text fontSize="11px" color={tokens.colors.text.secondary}>
                {jsonValidation.count === 1
                  ? `1 server: ${jsonValidation.names[0]}`
                  : `${jsonValidation.count} servers: ${jsonValidation.names.slice(0, 3).join(', ')}${jsonValidation.count > 3 ? `, +${jsonValidation.count - 3}` : ''}`}
              </Text>
            </HStack>
          )}
          {jsonValidation.kind === 'error' && (
            <HStack gap={2} align="flex-start">
              <Box w="6px" h="6px" borderRadius="50%" bg={tokens.colors.accent.red} mt="6px" flexShrink={0} />
              <Text fontSize="11px" color={tokens.colors.accent.red} lineHeight="1.5">
                {jsonValidation.message}
              </Text>
            </HStack>
          )}
        </VStack>
      )}

      {error && (
        <Text fontSize="11px" color={tokens.colors.accent.red} mt={3}>
          {error}
        </Text>
      )}

      <HStack justify="flex-end" gap={2} mt={4}>
        <Button
          size="sm"
          variant="outline"
          onClick={props.onCancel}
          color={tokens.colors.text.secondary}
          borderColor={tokens.colors.border.default}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }}
        >
          {t('settings.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={mode === 'form' ? handleSaveForm : handleSaveJson}
          disabled={isSaving || (mode === 'json' && !isJsonSubmittable)}
          bg={tokens.colors.accent.primary}
          color="white"
          _hover={{ bg: tokens.colors.accent.primaryDark }}
          _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
        >
          {isSaving ? t('settings.adding') : t('settings.addServer')}
        </Button>
      </HStack>
    </Box>
  )
}

// ━━━ Shared components ━━━

/**
 * Tamanhos de Janela de Contexto que o admin pode publicar. O valor (tokens) é
 * emitido pelo data-plane em X-Model-Context-Window e usado pela IDE como
 * denominador da pressão de contexto e do gatilho de auto-compactação.
 */
const CONTEXT_WINDOW_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '128k', value: 131_072 },
  { label: '200k', value: 200_000 },
  { label: '256k', value: 262_144 },
  { label: '512k', value: 524_288 },
  { label: '768k', value: 786_432 },
  { label: '1M', value: 1_000_000 },
  { label: '2M', value: 2_000_000 },
]
const DEFAULT_CONTEXT_WINDOW = 200_000

function formatContextWindow(n: number): string {
  return CONTEXT_WINDOW_OPTIONS.find(o => o.value === n)?.label ?? `${Math.round(n / 1000)}k`
}

function AdminSection() {
  const t = useTranslation()
  const [models, setModels] = useState<import('../../services/adminService').AdminModel[]>([])
  const [activeLive, setActiveLive] = useState<string>('')
  const [activeSelection, setActiveSelection] = useState<string>('')
  const [contextWindow, setContextWindow] = useState<number>(DEFAULT_CONTEXT_WINDOW)
  const [activeConfig, setActiveConfig] = useState<import('../../services/adminService').ActiveAIConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSavingActive, setIsSavingActive] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verify, setVerify] = useState<import('../../services/adminService').VerifyResponse | null>(null)
  const [isVerifying, setIsVerifying] = useState(false)

  const load = useCallback(async function () {
    setIsLoading(true)
    setError(null)
    try {
      const { fetchAdminModels, fetchAdminVerify } = await import('../../services/adminService')
      const [modelsData, verifyData] = await Promise.all([
        fetchAdminModels(),
        fetchAdminVerify(),
      ])
      const activeId = findActiveModelId(modelsData.models, verifyData.activeAIConfig)

      const initialId = activeId || modelsData.models[0]?.id || ''
      setModels(modelsData.models)
      setVerify(verifyData)
      setActiveConfig(verifyData.activeAIConfig ?? null)
      setActiveLive(activeId)
      setActiveSelection(initialId)
      // Pré-preenche o Select: janela publicada → default do modelo no catálogo → 1M.
      setContextWindow(
        verifyData.activeAIConfig?.contextWindow
        ?? modelsData.models.find(m => m.id === initialId)?.activeConfig.contextWindow
        ?? DEFAULT_CONTEXT_WINDOW,
      )
    } catch (err) {
      if (err instanceof Error && err.message === 'FORBIDDEN') {
        setForbidden(true)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  const refreshVerify = useCallback(async function () {
    setIsVerifying(true)
    try {
      const { fetchAdminVerify } = await import('../../services/adminService')
      const data = await fetchAdminVerify()
      const activeId = findActiveModelId(models, data.activeAIConfig)
      setVerify(data)
      setActiveConfig(data.activeAIConfig ?? null)
      setActiveLive(activeId)
      if (activeId) setActiveSelection(activeId)
      if (data.activeAIConfig?.contextWindow) setContextWindow(data.activeAIConfig.contextWindow)
    } catch (err) {
      if (err instanceof Error && err.message === 'FORBIDDEN') setForbidden(true)
    } finally {
      setIsVerifying(false)
    }
  }, [models])

  useEffect(function () { load() }, [load])

  const handleSelectModel = useCallback(function (id: string) {
    setActiveSelection(id)
    // Pré-preenche a janela com o default do modelo no catálogo (se for uma das
    // opções); senão mantém a escolha atual do admin.
    const m = models.find(x => x.id === id)
    const w = m?.activeConfig.contextWindow
    if (w && CONTEXT_WINDOW_OPTIONS.some(o => o.value === w)) setContextWindow(w)
  }, [models])

  async function handlePublishActive() {
    const model = models.find(m => m.id === activeSelection)
    if (!model) return
    setIsSavingActive(true)
    setError(null)
    try {
      const { publishActiveAIConfig } = await import('../../services/adminService')
      // Publica a config do modelo COM a janela de contexto escolhida no Select.
      const config = await publishActiveAIConfig({ ...model.activeConfig, contextWindow })
      setActiveConfig(config)
      setActiveLive(model.id)
      setActiveSelection(model.id)
      await refreshVerify()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.saveError'))
    } finally {
      setIsSavingActive(false)
    }
  }

  // Publish enabled quando o modelo mudou OU a janela difere da publicada.
  const liveContextWindow = activeConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const publishDisabled =
    isSavingActive ||
    !activeSelection ||
    (activeSelection === activeLive && contextWindow === liveContextWindow)

  if (forbidden) {
    return <Text fontSize="13px" color={tokens.colors.accent.red}>{t('admin.forbidden')}</Text>
  }
  if (isLoading) {
    return <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.loading')}</Text>
  }

  return (
    <VStack align="stretch" gap={6}>
      <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.subtitle')}</Text>

      {error && (
        <Box p={3} borderRadius={tokens.radius.lg} bg={tokens.colors.accent.redSubtle}
          border="1px solid" borderColor={tokens.colors.accent.red}>
          <Text fontSize="12px" color={tokens.colors.accent.red}>{error}</Text>
        </Box>
      )}

      <SettingsGroup title="Data Plane de IA activo" badge={t('admin.coderModels')}>
        <Text fontSize="11px" color={tokens.colors.text.muted} mb={3}>
          Publica a configuração activa que o ai-pass-through-worker lê em ACTIVE_AI_CONFIG. O agente usa apenas VITE_AI_WORKER_URL.
        </Text>
        <ModelRadioList
          models={models}
          selectedId={activeSelection}
          liveId={activeLive}
          onChange={handleSelectModel}
        />
        <Flex align="center" justify="space-between" mt={3} gap={3}>
          <Box>
            <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>Janela de Contexto</Text>
            <Text fontSize="10px" color={tokens.colors.text.muted}>
              Emitida em X-Model-Context-Window — define a pressão de contexto e o auto-compact na IDE.
            </Text>
          </Box>
          <NativeSelect.Root size="sm" width="110px" flexShrink={0}>
            <NativeSelect.Field
              bg={tokens.colors.bg.input}
              borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary}
              value={String(contextWindow)}
              onChange={function (e) { setContextWindow(Number(e.target.value)) }}
            >
              {CONTEXT_WINDOW_OPTIONS.map(function (opt) {
                return <option key={opt.value} value={opt.value}>{opt.label}</option>
              })}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Flex>
        {activeConfig && (
          <Box
            mt={3}
            p={3}
            borderRadius={tokens.radius.lg}
            bg={tokens.colors.bg.card}
            border="1px solid"
            borderColor={activeConfig.enabled ? tokens.colors.bg.cardBorder : tokens.colors.accent.orange}
          >
            <Flex justify="space-between" align="center" mb={1}>
              <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>Active AI Config</Text>
              <Text fontSize="10px" color={activeConfig.enabled ? tokens.colors.accent.green : tokens.colors.accent.orange}>
                {activeConfig.enabled ? 'enabled' : 'disabled'}
              </Text>
            </Flex>
            <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
              {activeConfig.provider} / {activeConfig.model}
            </Text>
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} mt={1}>
              {activeConfig.baseUrl}{activeConfig.chatCompletionsPath}
            </Text>
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} mt={1}>
              {activeConfig.authHeader} · {activeConfig.authScheme} · {activeConfig.apiKeyEnv}
            </Text>
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} mt={1}>
              ctx window · {activeConfig.contextWindow ? formatContextWindow(activeConfig.contextWindow) : '— (fallback de perfil)'}
            </Text>
          </Box>
        )}
        <Flex justify="flex-end" mt={3}>
          <Button
            size="sm"
            disabled={publishDisabled}
            onClick={handlePublishActive}
            bg={tokens.colors.accent.primary}
            color="white"
            _hover={{ bg: tokens.colors.accent.primaryDark }}
            _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
          >
            {isSavingActive ? t('admin.saving') : 'Publicar active config'}
          </Button>
        </Flex>
      </SettingsGroup>

      <SidecarsPanel />

      <PersonasPanel />

      <SettingsGroup title={t('admin.verifyTitle')}>
        <Text fontSize="11px" color={tokens.colors.text.muted} mb={3}>{t('admin.verifyDesc')}</Text>
        {verify ? (
          <VStack align="stretch" gap={2}>
            {verify.activeAIConfig && (
              <Box
                p={3}
                borderRadius={tokens.radius.lg}
                bg={tokens.colors.bg.card}
                border="1px solid"
                borderColor={verify.activeAIConfig.enabled ? tokens.colors.bg.cardBorder : tokens.colors.accent.orange}
              >
                <Flex justify="space-between" align="center" mb={1}>
                  <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>Active AI Config</Text>
                  <Text
                    fontSize="10px"
                    color={verify.activeAIConfig.enabled ? tokens.colors.accent.green : tokens.colors.accent.orange}
                  >
                    {verify.activeAIConfig.enabled ? 'enabled' : 'disabled'}
                  </Text>
                </Flex>
                <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
                  {verify.activeAIConfig.provider} / {verify.activeAIConfig.model}
                </Text>
                <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} mt={1}>
                  {verify.activeAIConfig.baseUrl}{verify.activeAIConfig.chatCompletionsPath}
                </Text>
                <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} mt={1}>
                  {verify.activeAIConfig.authHeader} · {verify.activeAIConfig.authScheme} · {verify.activeAIConfig.apiKeyEnv}
                </Text>
                <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} mt={1}>
                  ctx window · {verify.activeAIConfig.contextWindow ? formatContextWindow(verify.activeAIConfig.contextWindow) : '— (fallback de perfil)'}
                </Text>
              </Box>
            )}

            {!verify.activeAIConfig && (
              <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.verifyIdle')}</Text>
            )}
          </VStack>
        ) : isVerifying ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.verifyChecking')}</Text>
        ) : (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.verifyIdle')}</Text>
        )}
        <Flex justify="flex-end" mt={3}>
          <Button
            size="xs"
            variant="ghost"
            disabled={isVerifying}
            onClick={refreshVerify}
            color={tokens.colors.text.secondary}
            _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
            _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
          >
            {isVerifying ? t('admin.verifyChecking') : t('admin.verifyRefresh')}
          </Button>
        </Flex>
      </SettingsGroup>
    </VStack>
  )
}

function findActiveModelId(
  models: import('../../services/adminService').AdminModel[],
  config: import('../../services/adminService').ActiveAIConfig | null | undefined,
): string {
  if (!config) return ''
  return models.find(model => activeConfigMatches(model.activeConfig, config))?.id || ''
}

function activeConfigMatches(
  expected: import('../../services/adminService').ActiveAIConfigInput,
  actual: import('../../services/adminService').ActiveAIConfig,
): boolean {
  return expected.provider === actual.provider &&
    expected.model === actual.model &&
    trimTrailingSlashes(expected.baseUrl) === trimTrailingSlashes(actual.baseUrl) &&
    expected.chatCompletionsPath === actual.chatCompletionsPath &&
    expected.authHeader === actual.authHeader &&
    expected.authScheme === actual.authScheme &&
    expected.apiKeyEnv === actual.apiKeyEnv &&
    expected.enabled === actual.enabled
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

// ─── Sidecars panel (admin) ──────────────────────────────────────────────────

const SIDECAR_SLOTS: Array<{ type: import('../../services/adminService').SidecarType; label: string; desc: string }> = [
  { type: 'vision', label: 'Visão (imagens)', desc: 'Descreve imagens para modelos sem visão (MiMo V2.5 Pro, GLM)' },
  { type: 'web_search', label: 'Web Search', desc: 'Pesquisa web para modelos sem busca nativa' },
  // utility: corre a CADA turno (memory-extractor/selector/distiller, summarize).
  // Estava fora do UI — um sidecar:utility preso (ex.: glm-5.1) faturava 5.1 em
  // todos os turnos sem forma de o ver/desligar aqui. Desligar → cai no ativo.
  { type: 'utility', label: 'Utility (memória)', desc: 'Memória, sumarização e títulos (memory-*, summarize). Desligar → usa o modelo ativo.' },
  { type: 'fim', label: 'FIM (autocomplete)', desc: 'Code completion inline (X-Request-Type: fim)' },
]

function SidecarsPanel() {
  const [data, setData] = useState<import('../../services/adminService').SidecarsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<Record<string, string>>({})

  const load = useCallback(async function () {
    setLoading(true)
    setError(null)
    try {
      const { fetchSidecars } = await import('../../services/adminService')
      const d = await fetchSidecars()
      setData(d)
      // Seed each slot's Select from the currently-published config (match by model id).
      const next: Record<string, string> = {}
      for (const slot of SIDECAR_SLOTS) {
        const cur = d.current[`sidecar:${slot.type}`]
        const match = cur ? d.catalog.find(m => m.activeConfig.model === cur.model) : undefined
        next[slot.type] = match?.id ?? ''
      }
      setSel(next)
    } catch (err) {
      setError(err instanceof Error && err.message === 'FORBIDDEN' ? 'Sem permissão.' : (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(function () { load() }, [load])

  async function apply(type: import('../../services/adminService').SidecarType, action: 'publish' | 'disable') {
    setBusy(type)
    setError(null)
    try {
      const svc = await import('../../services/adminService')
      if (action === 'disable') await svc.disableSidecar(type)
      else if (sel[type]) await svc.setSidecar(type, sel[type])
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsGroup title="Sidecars" badge="vision · web · utility · fim">
      <Text fontSize="11px" color={tokens.colors.text.muted} mb={3}>
        Modelos auxiliares usados quando o modelo activo não tem a capacidade nativa.
        Publicados em <Box as="code" fontSize="10px">sidecar:*</Box> no KV; o data-plane roteia por X-Request-Type.
      </Text>

      {loading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted}>A carregar…</Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {SIDECAR_SLOTS.map(function (slot) {
            const cur = data?.current[`sidecar:${slot.type}`] ?? null
            const published = !!cur && cur.enabled
            const eligible = (data?.catalog ?? []).filter(m => m.roles.includes(slot.type))
            const selModel = (data?.catalog ?? []).find(m => m.id === sel[slot.type])
            const isCurrent = published && !!selModel && selModel.activeConfig.model === cur!.model
            const canPublish = !!sel[slot.type] && !isCurrent && busy !== slot.type
            return (
              <Box
                key={slot.type}
                p={3}
                borderRadius={tokens.radius.lg}
                bg={tokens.colors.bg.card}
                border="1px solid"
                borderColor={published ? tokens.colors.bg.cardBorder : tokens.colors.border.panel}
              >
                <Flex justify="space-between" align="center" mb={2} gap={2}>
                  <Flex align="center" gap={2} minW={0}>
                    <Box w="7px" h="7px" borderRadius="full" flexShrink={0}
                      bg={published ? tokens.colors.accent.green : tokens.colors.text.disabled} />
                    <Box minW={0}>
                      <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>{slot.label}</Text>
                      <Text fontSize="10px" color={tokens.colors.text.muted}>{slot.desc}</Text>
                    </Box>
                  </Flex>
                  <Text
                    fontSize="10px"
                    fontFamily={tokens.fontFamily.mono}
                    flexShrink={0}
                    color={published ? tokens.colors.accent.green : tokens.colors.text.disabled}
                  >
                    {published ? cur!.model : 'não publicado'}
                  </Text>
                </Flex>
                <Flex align="center" gap={2}>
                  <NativeSelect.Root size="sm" flex="1">
                    <NativeSelect.Field
                      bg={tokens.colors.bg.input}
                      borderColor={tokens.colors.border.input}
                      color={tokens.colors.text.primary}
                      value={sel[slot.type] ?? ''}
                      onChange={function (e) { const v = e.target.value; setSel(s => ({ ...s, [slot.type]: v })) }}
                    >
                      <option value="">— escolher modelo —</option>
                      {eligible.map(m => <option key={m.id} value={m.id}>{m.name} · {m.providerLabel}</option>)}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                  <Button
                    size="sm"
                    flexShrink={0}
                    disabled={!canPublish}
                    onClick={function () { apply(slot.type, 'publish') }}
                    bg={tokens.colors.accent.primary}
                    color="white"
                    _hover={{ bg: tokens.colors.accent.primaryDark }}
                    _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
                  >
                    {busy === slot.type ? '…' : 'Publicar'}
                  </Button>
                  {published && (
                    <Button
                      size="sm"
                      variant="ghost"
                      flexShrink={0}
                      disabled={busy === slot.type}
                      onClick={function () { apply(slot.type, 'disable') }}
                      color={tokens.colors.text.secondary}
                      _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.bg.hoverSubtle }}
                    >
                      Desligar
                    </Button>
                  )}
                </Flex>
              </Box>
            )
          })}
        </VStack>
      )}

      {error && <Text fontSize="11px" color={tokens.colors.accent.red} mt={2}>{error}</Text>}
    </SettingsGroup>
  )
}

// ─── Personas panel (admin) — Escolha do Modelo (2026-08-04) ─────────────────
//
// O selector do UTILIZADOR (PromptActions) expõe Standard/Expert/Master sem
// revelar modelos; aqui o admin atribui a cada persona um modelo do catálogo
// coder + o costMultiplier ("quantas vezes consome"). O control-plane publica
// `persona:*` no KV; o data-plane fatura billableTokenTotal (cache já a 50%)
// × multiplier — ou seja, tokens cacheados custam metade do valor definido.
// Persona não publicada → o worker degrada para a config ativa (o selector do
// user continua a funcionar, só sem diferenciação).

const PERSONA_SLOTS: Array<{ type: import('../../services/adminService').PersonaType; label: string; desc: string }> = [
  { type: 'standard', label: 'Standard', desc: 'Persona base — o dia-a-dia. Consumo típico: 1×.' },
  { type: 'expert', label: 'Expert', desc: 'Trabalho complexo — modelo mais forte, consumo maior.' },
  { type: 'master', label: 'Master', desc: 'Capacidade máxima — o topo do catálogo, consumo no topo.' },
]

function PersonasPanel() {
  const [data, setData] = useState<import('../../services/adminService').PersonasResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<Record<string, string>>({})
  const [mult, setMult] = useState<Record<string, string>>({})

  const load = useCallback(async function () {
    setLoading(true)
    setError(null)
    try {
      const { fetchPersonas } = await import('../../services/adminService')
      const d = await fetchPersonas()
      setData(d)
      // Seed selects + multipliers from the published configs.
      const nextSel: Record<string, string> = {}
      const nextMult: Record<string, string> = {}
      for (const slot of PERSONA_SLOTS) {
        const cur = d.current[`persona:${slot.type}`]
        const match = cur ? d.catalog.find(m => m.activeConfig.model === cur.model) : undefined
        nextSel[slot.type] = match?.id ?? ''
        nextMult[slot.type] = cur?.costMultiplier != null ? String(cur.costMultiplier) : '1'
      }
      setSel(nextSel)
      setMult(nextMult)
    } catch (err) {
      setError(err instanceof Error && err.message === 'FORBIDDEN' ? 'Sem permissão.' : (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(function () { load() }, [load])

  async function apply(type: import('../../services/adminService').PersonaType, action: 'publish' | 'disable') {
    setBusy(type)
    setError(null)
    try {
      const svc = await import('../../services/adminService')
      if (action === 'disable') {
        await svc.disablePersona(type)
      } else if (sel[type]) {
        const multiplier = Number(mult[type])
        if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
          throw new Error('Multiplicador inválido — número > 0 e ≤ 100.')
        }
        await svc.setPersona(type, sel[type], multiplier)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsGroup title="Personas" badge="standard · expert · master">
      <Text fontSize="11px" color={tokens.colors.text.muted} mb={3}>
        O selector do utilizador mostra as personas SEM revelar os modelos. Atribui aqui o modelo
        e o multiplicador de consumo de cada uma (tokens × multiplicador; cache fatura a 50% desse
        valor). Publicadas em <Box as="code" fontSize="10px">persona:*</Box> no KV; não publicada → usa a config ativa.
      </Text>

      {loading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted}>A carregar…</Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {PERSONA_SLOTS.map(function (slot) {
            const cur = data?.current[`persona:${slot.type}`] ?? null
            const published = !!cur && cur.enabled
            const selModel = (data?.catalog ?? []).find(m => m.id === sel[slot.type])
            const isCurrent = published && !!selModel && selModel.activeConfig.model === cur!.model
              && String(cur!.costMultiplier ?? 1) === (mult[slot.type] || '1')
            const canPublish = !!sel[slot.type] && !isCurrent && busy !== slot.type
            return (
              <Box
                key={slot.type}
                p={3}
                borderRadius={tokens.radius.lg}
                bg={tokens.colors.bg.card}
                border="1px solid"
                borderColor={published ? tokens.colors.bg.cardBorder : tokens.colors.border.panel}
              >
                <Flex justify="space-between" align="center" mb={2} gap={2}>
                  <Flex align="center" gap={2} minW={0}>
                    <Box w="7px" h="7px" borderRadius="full" flexShrink={0}
                      bg={published ? tokens.colors.accent.green : tokens.colors.text.disabled} />
                    <Box minW={0}>
                      <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>{slot.label}</Text>
                      <Text fontSize="10px" color={tokens.colors.text.muted}>{slot.desc}</Text>
                    </Box>
                  </Flex>
                  <Text
                    fontSize="10px"
                    fontFamily={tokens.fontFamily.mono}
                    flexShrink={0}
                    color={published ? tokens.colors.accent.green : tokens.colors.text.disabled}
                  >
                    {published ? `${cur!.model} · ${cur!.costMultiplier ?? 1}×` : 'não publicada'}
                  </Text>
                </Flex>
                <Flex align="center" gap={2}>
                  <NativeSelect.Root size="sm" flex="1">
                    <NativeSelect.Field
                      bg={tokens.colors.bg.input}
                      borderColor={tokens.colors.border.input}
                      color={tokens.colors.text.primary}
                      value={sel[slot.type] ?? ''}
                      onChange={function (e) { const v = e.target.value; setSel(s => ({ ...s, [slot.type]: v })) }}
                    >
                      <option value="">— escolher modelo —</option>
                      {(data?.catalog ?? []).map(m => <option key={m.id} value={m.id}>{m.name} · {m.providerLabel}</option>)}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                  <Input
                    size="sm"
                    w="72px"
                    flexShrink={0}
                    type="number"
                    min={0.1}
                    max={100}
                    step={0.5}
                    title="Multiplicador de consumo (tokens × N; cache a 50% de N)"
                    bg={tokens.colors.bg.input}
                    borderColor={tokens.colors.border.input}
                    color={tokens.colors.text.primary}
                    value={mult[slot.type] ?? '1'}
                    onChange={function (e) { const v = e.target.value; setMult(s => ({ ...s, [slot.type]: v })) }}
                  />
                  <Text fontSize="11px" color={tokens.colors.text.muted} flexShrink={0}>×</Text>
                  <Button
                    size="sm"
                    flexShrink={0}
                    disabled={!canPublish}
                    onClick={function () { apply(slot.type, 'publish') }}
                    bg={tokens.colors.accent.primary}
                    color="white"
                    _hover={{ bg: tokens.colors.accent.primaryDark }}
                    _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
                  >
                    {busy === slot.type ? '…' : 'Publicar'}
                  </Button>
                  {published && (
                    <Button
                      size="sm"
                      variant="ghost"
                      flexShrink={0}
                      disabled={busy === slot.type}
                      onClick={function () { apply(slot.type, 'disable') }}
                      color={tokens.colors.text.secondary}
                      _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.bg.hoverSubtle }}
                    >
                      Desligar
                    </Button>
                  )}
                </Flex>
              </Box>
            )
          })}
        </VStack>
      )}

      {error && <Text fontSize="11px" color={tokens.colors.accent.red} mt={2}>{error}</Text>}
    </SettingsGroup>
  )
}

function ModelRadioList(props: {
  models: import('../../services/adminService').AdminModel[]
  selectedId: string
  liveId: string
  onChange: (id: string) => void
}) {
  return (
    <VStack align="stretch" gap={1}>
      {props.models.map(function (m) {
        const isSelected = props.selectedId === m.id
        const isLive = props.liveId === m.id
        return (
          <Box
            key={m.id}
            as="button"
            onClick={function () { props.onChange(m.id) }}
            textAlign="left"
            px={3} py="10px"
            borderRadius={tokens.radius.lg}
            bg={isSelected ? tokens.colors.bg.activeItem : tokens.colors.bg.card}
            border="1px solid"
            borderColor={isSelected ? tokens.colors.accent.primary : tokens.colors.bg.cardBorder}
            cursor="pointer"
            transition={tokens.transition.fast}
            _hover={{ borderColor: isSelected ? tokens.colors.accent.primary : tokens.colors.border.default }}
          >
            <Flex align="center" justify="space-between">
              <HStack gap={3}>
                <Box
                  w="14px" h="14px" borderRadius="full"
                  border="2px solid"
                  borderColor={isSelected ? tokens.colors.accent.primary : tokens.colors.border.default}
                  display="flex" alignItems="center" justifyContent="center"
                >
                  {isSelected && (
                    <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.primary} />
                  )}
                </Box>
                <Text fontSize="13px" fontWeight="500" color={tokens.colors.text.primary}>{m.name}</Text>
                <Text fontSize="11px" color={tokens.colors.text.muted}>({m.providerLabel})</Text>
              </HStack>
              {isLive && (
                <Box
                  px={2} py="1px"
                  borderRadius={tokens.radius.full}
                  bg={tokens.colors.accent.greenSubtle}
                  color={tokens.colors.accent.green}
                  fontSize="10px"
                  fontWeight="500"
                >
                  live
                </Box>
              )}
            </Flex>
          </Box>
        )
      })}
    </VStack>
  )
}

function SettingsGroup(props: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <Box>
      <Flex align="center" gap={2} mb={3}>
        <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>{props.title}</Text>
        {props.badge && (
          <Text fontSize="10px" color={tokens.colors.text.disabled} bg={tokens.colors.bg.card}
            px={2} py="1px" borderRadius={tokens.radius.full} fontFamily={tokens.fontFamily.mono}>
            {props.badge}
          </Text>
        )}
      </Flex>
      {props.children}
    </Box>
  )
}

function SkillRow(props: { name: string; scope: string; onDelete?: () => void }) {
  const scopeColors: Record<string, string> = {
    bundled: tokens.colors.accent.purple,
    global: tokens.colors.accent.blue,
    project: tokens.colors.accent.green,
  }
  return (
    <Flex align="center" justify="space-between" px={3} py="8px" borderRadius={tokens.radius.lg}
      bg={tokens.colors.bg.card} border="1px solid" borderColor={tokens.colors.bg.cardBorder}
      transition={tokens.transition.fast} _hover={{ borderColor: tokens.colors.border.default }}>
      <HStack gap={2}>
        <Box w="6px" h="6px" borderRadius="full" bg={scopeColors[props.scope] || tokens.colors.text.disabled} />
        <Text fontSize="13px" color={tokens.colors.text.primary}>{props.name}</Text>
      </HStack>
      {props.onDelete && (
        <Box as="button" display="flex" alignItems="center" justifyContent="center"
          w="26px" h="26px" borderRadius={tokens.radius.md} bg="transparent"
          color={tokens.colors.text.disabled} cursor="pointer" transition={tokens.transition.fast}
          _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.accent.redSubtle }}
          onClick={props.onDelete}>
          <FiTrash2 size={13} />
        </Box>
      )}
    </Flex>
  )
}

function McpServerCard(props: { server: McpServerState; onStop: () => void; onRemove: () => void; onRestart: () => void }) {
  const t = useTranslation()
  const { server } = props
  const statusColors: Record<string, string> = {
    running: tokens.colors.accent.green,
    starting: tokens.colors.accent.orange,
    error: tokens.colors.accent.red,
    stopped: tokens.colors.text.disabled,
  }
  return (
    <Box p={3} borderRadius={tokens.radius.xl} border="1px solid" borderColor={tokens.colors.border.default}
      bg={tokens.colors.bg.card} transition={tokens.transition.fast} _hover={{ borderColor: tokens.colors.border.glass }}>
      <Flex justify="space-between" align="center" mb={server.tools.length > 0 || server.error ? 2 : 0}>
        <HStack gap={2}>
          <Box w="8px" h="8px" borderRadius="full" bg={statusColors[server.status] || tokens.colors.text.disabled} />
          <Text fontSize="13px" fontWeight="500" color={tokens.colors.text.primary}>{server.name}</Text>
          <Text fontSize="11px" color={tokens.colors.text.disabled}>({server.transport})</Text>
        </HStack>
        <HStack gap={1}>
          {server.status === 'running' && (
            <ActionButton icon={<FiSquare size={11} />} label={t('settings.stop')} color={tokens.colors.accent.red}
              hoverBg={tokens.colors.accent.redSubtle} onClick={props.onStop} />
          )}
          {server.status === 'error' && (
            <ActionButton icon={<FiRefreshCw size={11} />} label={t('settings.restart')} color={tokens.colors.accent.orange}
              hoverBg="rgba(247, 127, 0, 0.1)" onClick={props.onRestart} />
          )}
          {(server.status === 'stopped' || server.status === 'error') && (
            <ActionButton icon={<FiTrash2 size={11} />} label={t('settings.remove')} color={tokens.colors.text.disabled}
              hoverBg={tokens.colors.accent.redSubtle} onClick={props.onRemove} />
          )}
        </HStack>
      </Flex>
      {server.error && <Text fontSize="11px" color={tokens.colors.accent.red} mb={1}>{server.error}</Text>}
      {server.tools.length > 0 && (
        <Text fontSize="11px" color={tokens.colors.text.muted}>
          {t('settings.tools')}: {server.tools.map(function (tool) { return tool.name }).join(', ')}
        </Text>
      )}
    </Box>
  )
}

function ActionButton(props: { icon: React.ReactNode; label: string; color: string; hoverBg: string; onClick: () => void }) {
  return (
    <Box as="button" display="flex" alignItems="center" gap="4px" px={2} py={1}
      borderRadius={tokens.radius.md} bg="transparent" color={props.color} cursor="pointer"
      fontSize="11px" fontWeight="500" transition={tokens.transition.fast}
      _hover={{ bg: props.hoverBg }} onClick={props.onClick}>
      {props.icon}{props.label}
    </Box>
  )
}

function EmptyState(props: { text: string }) {
  return <Text fontSize="12px" color={tokens.colors.text.muted} py={2}>{props.text}</Text>
}

export default memo(SettingsView)
