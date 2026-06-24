import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Box, Button, Flex, HStack, Input, Switch, Text, VStack } from '@chakra-ui/react'
import { FiCheck, FiAlertCircle, FiTrash2, FiEye, FiTool, FiCpu, FiChevronDown, FiPlus, FiKey, FiPower, FiZap, FiRefreshCw, FiWifi, FiWifiOff, FiLock } from 'react-icons/fi'
import { useByokStore, type ByokProvider, type ByokProviderConfig, type ByokModel, type ByokModelCapabilities } from '../../../stores/byokStore'
import { useBillingStore } from '../../../stores/billingStore'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { IS_MAC, IS_WINDOWS } from '@/utils/platform'

// User-declarable context windows for BYOK models (tokens). Under BYOK the
// request bypasses the worker, so the IDE can't learn the real window from a
// response header — the user picks the value their model supports and the
// agent's auto-compact uses it. "Default" leaves it to the catalog/fallback.
const CONTEXT_WINDOW_OPTIONS: Array<{ label: string; value: number | undefined }> = [
  { label: 'Default', value: undefined },
  { label: '128K', value: 131_072 },
  { label: '192K', value: 196_608 },
  { label: '200K', value: 200_000 },
  { label: '256K', value: 262_144 },
  { label: '1M', value: 1_048_576 },
  { label: '2M', value: 2_097_152 },
]

// Per-OS keychain label for the trust line under API key inputs. Tauri uses
// OS-native secret storage (Apple Keychain / Windows Credential Manager /
// libsecret on Linux). Surfacing this builds trust without bloat.
const KEYCHAIN_LABEL = IS_MAC
  ? 'macOS Keychain'
  : IS_WINDOWS
    ? 'Windows Credential Manager'
    : 'system keyring (libsecret)'

// ── ApiKeysSection ──
//
// BYOK configuration UI. Lists curated providers (catalog from /v1/byok/providers),
// lets the user paste a key per provider, optionally override the baseURL, pick
// a model, validate the key, and mark a (provider, model) pair as the active
// selection. The key itself never lives in JS state — Tauri stores it in the
// OS keychain and the agent fetches it just-in-time per request.

export default function ApiKeysSection() {
  const t = useTranslation()
  const enabled = useByokStore(s => s.enabled)
  const toggle = useByokStore(s => s.toggle)
  const providers = useByokStore(s => s.providers)
  const catalogLoaded = useByokStore(s => s.catalogLoaded)
  const loadProviders = useByokStore(s => s.loadProviders)
  const activeProvider = useByokStore(s => s.activeProvider)
  const activeModel = useByokStore(s => s.activeModel)
  const perProviderConfig = useByokStore(s => s.perProviderConfig)
  const plan = useBillingStore(s => s.plan)

  const isExplorer = plan === 'explorer'

  // Refresh catalog on mount — user might open Settings without an auth event
  // having fired loadProviders yet.
  useEffect(() => {
    if (!catalogLoaded) {
      loadProviders().catch(() => {})
    }
  }, [catalogLoaded, loadProviders])

  return (
    <VStack align="stretch" gap={6}>
      <VStack align="stretch" gap={3}>
        <Text fontSize="13px" color={tokens.colors.text.muted} lineHeight="1.55">
          {t('settings.apiKeysIntro')}
        </Text>

        <Flex
          align="center"
          justify="space-between"
          px={4}
          py={3}
          borderRadius={tokens.radius.lg}
          bg={tokens.colors.bg.card}
          border="1px solid"
          borderColor={enabled ? 'rgba(254, 16, 99, 0.35)' : tokens.colors.bg.cardBorder}
          transition={tokens.transition.fast}
        >
          <Box>
            <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
              {enabled ? t('settings.byokToggleOn') : t('settings.byokToggleOff')}
            </Text>
            {isExplorer && enabled && (
              <Text fontSize="11px" color={tokens.colors.text.muted} mt={1} maxW="420px">
                {t('settings.byokExplorerLimits')}
              </Text>
            )}
          </Box>
          <Switch.Root
            checked={enabled}
            onCheckedChange={(e) => toggle(e.checked)}
            size="md"
          >
            <Switch.HiddenInput />
            <Switch.Control />
          </Switch.Root>
        </Flex>
      </VStack>

      {providers.length === 0 ? (
        <Box
          py={8}
          textAlign="center"
          borderRadius={tokens.radius.lg}
          bg={tokens.colors.bg.card}
          border="1px dashed"
          borderColor={tokens.colors.bg.cardBorder}
        >
          <Text fontSize="13px" color={tokens.colors.text.muted}>
            {t('settings.byokNoProviders')}
          </Text>
        </Box>
      ) : (
        <ApiKeysBody
          providers={providers}
          enabled={enabled}
          activeProvider={activeProvider}
          activeModel={activeModel}
          perProviderConfig={perProviderConfig}
        />
      )}
    </VStack>
  )
}

// ── ApiKeysBody ──
//
// Hero-card-when-active layout:
//   1. ActiveHeroCard at top (when there's an active provider+model) with
//      pricing, capability badges, last-request cost, inline model switcher,
//      and Stop / Test primary actions.
//   2. "Or switch to..." section header (collapsed by default) listing the
//      remaining providers in compact form. Custom is always inside this
//      catalog list.
//   3. When nothing is active, the catalog list shows in full straight away.

function ApiKeysBody(props: {
  providers: ByokProvider[]
  enabled: boolean
  activeProvider: string | null
  activeModel: string | null
  perProviderConfig: Record<string, ByokProviderConfig>
}) {
  const t = useTranslation()
  const { providers, enabled, activeProvider, activeModel, perProviderConfig } = props
  const [catalogOpen, setCatalogOpen] = useState(false)

  // Resolve the "active" tuple — provider + model + baseURL. Mirrors
  // byokStore.resolveActive (4 resolution paths) so the hero appears for ALL
  // provider kinds: cloud-curated, local (dynamic catalog), user-defined
  // "other model", and custom OpenAI-compat.
  //
  // Deliberately NOT gated on `enabled` — the user expressed intent by
  // clicking "Definir ativo", and we want immediate visual feedback (hero
  // appears, catalog row disappears). The `enabled` flag controls actual
  // routing in agentService; here we just signal "this is what you picked".
  // When BYOK is OFF, the hero renders with a clear "BYOK OFF" indicator.
  const active = useMemo(() => {
    if (!activeProvider || !activeModel) return null
    const provider = providers.find(p => p.id === activeProvider)
    if (!provider) return null
    const config = perProviderConfig[activeProvider]

    // Local providers must be explicitly marked configured (the user pressed
    // "Definir ativo" at least once). Mirrors the same gate in byokStore.
    if (provider.local && !config?.configured) return null

    const baseURL = (config?.baseURL || provider.defaultBaseURL).replace(/\/$/, '')
    const userDefined = config?.userDefinedModel
    const registryModel = provider.models.find(m => m.id === activeModel)
    const dynamicModel = config?.dynamicCatalog?.models.find(m => m.id === activeModel)
    let model: ByokModel
    if (registryModel) {
      model = registryModel
    } else if (dynamicModel) {
      model = dynamicModel
    } else if (userDefined && userDefined.id === activeModel) {
      model = {
        id: userDefined.id,
        label: userDefined.id,
        capabilities: userDefined.capabilities,
        contextWindow: 0,
        supportsThinking: userDefined.supportsThinking,
      }
    } else if (provider.custom || provider.local) {
      // Fallback synthesis: covers (a) custom providers with free-text
      // model id and (b) local providers re-hydrated after restart where
      // dynamicCatalog hasn't been refreshed yet (it's not persisted).
      model = {
        id: activeModel,
        label: activeModel,
        capabilities: { images: false, audio: false, video: false, tools: false },
        contextWindow: 0,
        supportsThinking: false,
      }
    } else {
      return null
    }
    return { provider, model, baseURL }
  }, [activeProvider, activeModel, providers, perProviderConfig])

  // Sorted catalog (without the active provider when active is set).
  // Three-tier sort:
  //   1. Pinned featured providers (Xiaomi, Moonshot) — fixed priority
  //      regardless of usage so they always surface first.
  //   2. Everything else by lastUsed descending (frequent providers float up).
  //   3. Stable insertion order as final tiebreak.
  // Frequently-used providers float up within their group; equal lastUsed keeps
  // the hardcoded catalog order (Array.sort is stable). No more pinned set —
  // the catalog is a small curated list now.
  const otherProviders = useMemo(() => {
    return [...providers]
      .filter(p => !active || p.id !== active.provider.id)
      .sort((a, b) => {
        const aUsed = perProviderConfig[a.id]?.lastUsed ?? 0
        const bUsed = perProviderConfig[b.id]?.lastUsed ?? 0
        return bUsed - aUsed
      })
  }, [providers, active, perProviderConfig])

  // First-time gate: BYOK is on but the user hasn't configured ANY provider
  // yet (no key + no local "configured" flag). Surface a 3-step guide so
  // they don't land on 7 cards and have to infer "paste key → pick model →
  // set active" from scratch.
  const noProviderConfigured = useMemo(() => {
    return !active && providers.every(p => {
      const c = perProviderConfig[p.id]
      return !c?.hasKey && !c?.configured
    })
  }, [active, providers, perProviderConfig])
  const showOnboarding = enabled && noProviderConfigured

  return (
    <VStack align="stretch" gap={4}>
      {active && (
        <ActiveHeroCard
          provider={active.provider}
          model={active.model}
          baseURL={active.baseURL}
        />
      )}

      {showOnboarding && <OnboardingGuide />}

      {active ? (
        <VStack align="stretch" gap={2}>
          <Flex
            as="button"
            align="center"
            justify="space-between"
            w="100%"
            px={3}
            py="8px"
            borderRadius={tokens.radius.md}
            bg="transparent"
            border="1px solid"
            borderColor={tokens.colors.border.default}
            cursor="pointer"
            transition={tokens.transition.fast}
            textAlign="left"
            _hover={{ bg: tokens.colors.bg.hoverSubtle, borderColor: tokens.colors.border.subtle }}
            onClick={() => setCatalogOpen(v => !v)}
            aria-expanded={catalogOpen}
          >
            <Text fontSize="12px" fontWeight="500" color={tokens.colors.text.secondary}>
              {t('settings.byokOrSwitchTo')} ({otherProviders.length})
            </Text>
            <Box color={tokens.colors.text.disabled} transform={catalogOpen ? 'rotate(180deg)' : 'rotate(0deg)'} transition="transform 0.15s">
              <FiChevronDown size={14} />
            </Box>
          </Flex>
          {catalogOpen && (
            <CatalogList providers={otherProviders} enabled={enabled} />
          )}
        </VStack>
      ) : (
        <CatalogList providers={otherProviders} enabled={enabled} />
      )}
    </VStack>
  )
}

// ── OnboardingGuide ──
//
// Renders ONLY when BYOK toggle is on and no provider has been configured
// yet. Three numbered steps so a first-time user lands with a clear path
// instead of staring at 7 indistinguishable cards. Disappears the moment
// any provider becomes configured.

function OnboardingGuide() {
  const t = useTranslation()
  return (
    <Box
      px={4}
      py={4}
      borderRadius={tokens.radius.lg}
      bg="rgba(254, 16, 99, 0.04)"
      border="1px dashed"
      borderColor="rgba(254, 16, 99, 0.25)"
    >
      <VStack align="stretch" gap={2.5}>
        <Text fontSize="12px" fontWeight="700" color={tokens.colors.accent.primary} textTransform="uppercase" letterSpacing="0.04em">
          {t('settings.byokOnboardingTitle')}
        </Text>
        <VStack align="stretch" gap={1.5}>
          <OnboardingStep n={1} text={t('settings.byokOnboardingStep1')} />
          <OnboardingStep n={2} text={t('settings.byokOnboardingStep2')} />
          <OnboardingStep n={3} text={t('settings.byokOnboardingStep3')} />
        </VStack>
        <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.5">
          {t('settings.byokOnboardingHint')}
        </Text>
      </VStack>
    </Box>
  )
}

function OnboardingStep(props: { n: number; text: string }) {
  return (
    <HStack gap={2} align="flex-start">
      <Box
        flexShrink={0}
        w="18px"
        h="18px"
        borderRadius="full"
        bg="rgba(254, 16, 99, 0.15)"
        border="1px solid rgba(254, 16, 99, 0.3)"
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        <Text fontSize="10px" fontWeight="700" color={tokens.colors.accent.primary}>
          {props.n}
        </Text>
      </Box>
      <Text fontSize="12px" color={tokens.colors.text.primary} lineHeight="1.5">
        {props.text}
      </Text>
    </HStack>
  )
}

// ── CatalogList ──
//
// Search + grouped (Cloud / Local / Custom) provider list.
// Search appears when there are 5+ providers in scope (under the search-
// threshold the visual scan is faster than typing). Grouping always on —
// section headers help even with 3-4 cards because they answer "which of
// these can I use without an internet connection?".

function CatalogList(props: { providers: ByokProvider[]; enabled: boolean }) {
  const t = useTranslation()
  const { providers, enabled } = props
  const [filter, setFilter] = useState('')
  // Single-expand accordion: at most ONE provider card is open at a time.
  // Solves the long-scroll problem — even with 7 providers the catalog
  // never grows past header + 7 compact rows + 1 expanded body. Clicking
  // a different row collapses the previous one. Click the open row again
  // to collapse it.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const toggle = (id: string) => setExpandedId(prev => (prev === id ? null : id))

  const showSearch = providers.length >= 5

  const filtered = useMemo(() => {
    if (!filter.trim()) return providers
    const q = filter.toLowerCase()
    return providers.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
  }, [providers, filter])

  // Group by category. Cloud first (most common), Local second (offline
  // alternative), Custom last (advanced/escape hatch).
  const groups = useMemo(() => {
    const cloud: ByokProvider[] = []
    const local: ByokProvider[] = []
    const custom: ByokProvider[] = []
    for (const p of filtered) {
      // Explicit `group` wins (Anthropic is a cloud provider shown under Custom);
      // fall back to the legacy custom/local flags.
      const g = p.group ?? (p.custom ? 'custom' : p.local ? 'local' : 'cloud')
      if (g === 'custom') custom.push(p)
      else if (g === 'local') local.push(p)
      else cloud.push(p)
    }
    return { cloud, local, custom }
  }, [filtered])

  const renderRow = (p: ByokProvider) => (
    <ProviderCard
      key={p.id}
      provider={p}
      isExpanded={expandedId === p.id}
      onToggle={() => toggle(p.id)}
    />
  )

  return (
    <VStack align="stretch" gap={3} opacity={enabled ? 1 : 0.65}>
      {showSearch && (
        <Input
          size="sm"
          placeholder={t('settings.byokCatalogSearchPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          fontSize="12px"
          bg={tokens.colors.bg.sidebar}
          borderColor={tokens.colors.border.default}
          _focus={{ borderColor: 'rgba(254, 16, 99, 0.5)', boxShadow: 'none' }}
          _hover={{ borderColor: tokens.colors.border.subtle }}
          // Native-app feel: no browser autocomplete dropdown / spellcheck red
          // squiggles / password-manager prompts. These attributes also tell
          // 1Password / LastPass / Bitwarden to leave the field alone.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
        />
      )}

      {filtered.length === 0 && filter.trim() && (
        <Text fontSize="11px" color={tokens.colors.text.disabled} textAlign="center" py={2}>
          {t('settings.byokCatalogNoMatch')}
        </Text>
      )}

      {groups.cloud.length > 0 && (
        <CatalogGroup label={t('settings.byokGroupCloud')} count={groups.cloud.length}>
          {groups.cloud.map(renderRow)}
        </CatalogGroup>
      )}
      {groups.local.length > 0 && (
        <CatalogGroup label={t('settings.byokGroupLocal')} count={groups.local.length}>
          {groups.local.map(renderRow)}
        </CatalogGroup>
      )}
      {groups.custom.length > 0 && (
        <CatalogGroup label={t('settings.byokGroupCustom')} count={groups.custom.length}>
          {groups.custom.map(renderRow)}
        </CatalogGroup>
      )}
    </VStack>
  )
}

function CatalogGroup(props: { label: string; count: number; children: React.ReactNode }) {
  return (
    <VStack align="stretch" gap={2}>
      <HStack gap={2}>
        <Text
          fontSize="10px"
          fontWeight="700"
          color={tokens.colors.text.muted}
          textTransform="uppercase"
          letterSpacing="0.06em"
        >
          {props.label}
        </Text>
        <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
          {props.count}
        </Text>
        <Box flex={1} h="1px" bg={tokens.colors.border.default} />
      </HStack>
      {/* Tighter gap (6px) since rows are now compact summaries by default —
          a 12px gap between collapsed rows feels disjoint. Expanded rows
          self-pad internally so this still reads cleanly when one is open. */}
      <VStack align="stretch" gap="6px">
        {props.children}
      </VStack>
    </VStack>
  )
}

// ── ActiveHeroCard ──
//
// Top-of-section hero for the active provider/model. Carries the cost stripe,
// inline model switcher, and primary actions (Stop BYOK, Test). Reads cost
// data from billingStore.lastTokensUsed and the model's pricing — null when
// either is missing (e.g., OpenRouter has no per-model pricing).
//
// Listens for layoutStore.byokSettingsScrollToActive to know when the user
// arrived here from the chat ModelIndicator click — scrolls into view + a
// 1.5s pink border flash so they don't lose track in a long Settings page.

function ActiveHeroCard(props: {
  provider: ByokProvider
  model: ByokModel
  baseURL: string
}) {
  const { provider, model } = props
  const t = useTranslation()
  const enabled = useByokStore(s => s.enabled)
  const toggle = useByokStore(s => s.toggle)
  const setActive = useByokStore(s => s.setActive)
  const testKey = useByokStore(s => s.testKey)
  const lastTokensUsed = useBillingStore(s => s.lastTokensUsed)
  // Local providers ship with `provider.models = []` — the live list lives in
  // perProviderConfig.dynamicCatalog (refreshed on demand). Pull both so the
  // hero's "Switch model" works for Ollama/LM Studio too, not only cloud.
  //
  // CRITICAL: select the catalog OBJECT (stable ref from store), then derive
  // `?? []` in the render body. A previous version put `?? []` INSIDE the
  // selector — that returned a fresh empty array on every getSnapshot() call,
  // and useSyncExternalStore (zustand's underlying) re-runs the selector at
  // commit time to verify the snapshot. New `[]` !== previous `[]` (Object.is)
  // schedules another render, which schedules another, until React aborts
  // with "Maximum update depth exceeded".
  const dynamicCatalog = useByokStore(s => s.perProviderConfig[provider.id]?.dynamicCatalog)
  const dynamicModels = dynamicCatalog?.models ?? []
  const effectiveModels = provider.local ? dynamicModels : provider.models

  const [showSwitcher, setShowSwitcher] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState<string | null>(null)

  const lastCost = useMemo(() => {
    if (!model.pricing || lastTokensUsed <= 0) return null
    // We don't know input/output split from the lastTokensUsed scalar — use
    // the blended midpoint as an honest approximation. A more exact display
    // would require splitting the SSE billing event into prompt/completion
    // (server already has both; we'd just need to forward them separately).
    const blended = (model.pricing.inputPer1M + model.pricing.outputPer1M) / 2
    const usd = (lastTokensUsed / 1_000_000) * blended
    return usd
  }, [model.pricing, lastTokensUsed])

  const handleTest = useCallback(async () => {
    setTestStatus('testing')
    setTestMessage(null)
    const result = await testKey(provider.id, model.id)
    if (result.valid) {
      setTestStatus('ok')
      setTestMessage(result.latencyMs ? `${result.latencyMs} ms` : null)
    } else {
      setTestStatus('fail')
      setTestMessage(result.error?.slice(0, 120) || null)
    }
  }, [provider.id, model.id, testKey])

  const handleStop = useCallback(() => {
    toggle(false)
    setActive(null, null)
  }, [toggle, setActive])

  return (
    <Box
      px={5}
      py={4}
      borderRadius={tokens.radius.lg}
      bg="rgba(254, 16, 99, 0.04)"
      border="1px solid"
      borderColor="rgba(254, 16, 99, 0.3)"
      position="relative"
    >
      <VStack align="stretch" gap={3}>
        {/* Header: provider/model + ACTIVE pill */}
        <Flex align="center" justify="space-between" wrap="wrap" gap={2}>
          <HStack gap={2.5} flex="1" minW={0}>
            <Box color={tokens.colors.accent.primary} flexShrink={0}>
              <FiKey size={18} />
            </Box>
            <VStack align="flex-start" gap={0} minW={0}>
              <Text fontSize="15px" fontWeight="700" color={tokens.colors.text.primary} truncate>
                {provider.name} / {model.label}
              </Text>
              <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} truncate>
                {model.id}
              </Text>
            </VStack>
          </HStack>
          <HStack gap={1.5} flexShrink={0}>
            {enabled ? (
              <>
                <Box
                  w="8px"
                  h="8px"
                  borderRadius="full"
                  bg={tokens.colors.accent.primary}
                  css={{
                    animation: 'byokActivePulse 1.5s ease-in-out infinite',
                    '@keyframes byokActivePulse': {
                      '0%, 100%': { opacity: 1, transform: 'scale(1)' },
                      '50%': { opacity: 0.6, transform: 'scale(1.3)' },
                    },
                  }}
                />
                <Text
                  fontSize="9px"
                  fontWeight="700"
                  color={tokens.colors.accent.primary}
                  textTransform="uppercase"
                  letterSpacing="0.06em"
                >
                  {t('settings.byokActive')}
                </Text>
              </>
            ) : (
              // BYOK is OFF but a provider/model are selected. Hero card
              // appears so the user knows their pick is saved; the pill turns
              // muted + clickable to flip the master toggle on.
              <Box
                as="button"
                onClick={() => toggle(true)}
                px={2}
                py="2px"
                borderRadius={tokens.radius.full}
                bg="rgba(255,255,255,0.04)"
                border="1px solid"
                borderColor={tokens.colors.border.default}
                cursor="pointer"
                _hover={{ bg: 'rgba(255,255,255,0.08)', borderColor: tokens.colors.border.subtle }}
                title={t('settings.byokOffHint')}
              >
                <Text
                  fontSize="9px"
                  fontWeight="700"
                  color={tokens.colors.text.muted}
                  textTransform="uppercase"
                  letterSpacing="0.06em"
                >
                  {t('settings.byokOffPill')}
                </Text>
              </Box>
            )}
          </HStack>
        </Flex>

        {/* OFF state explainer — surfaces the routing-disabled fact in
            words because the small "BYOK off" pill alone is easy to miss
            and produces "is it active or not?" confusion. */}
        {!enabled && (
          <Box
            px={3}
            py="6px"
            borderRadius={tokens.radius.md}
            bg="rgba(255, 255, 255, 0.03)"
            border="1px solid"
            borderColor={tokens.colors.border.default}
          >
            <Text fontSize="11px" color={tokens.colors.text.secondary} lineHeight="1.5">
              {t('settings.byokOffExplain')}
            </Text>
          </Box>
        )}

        {/* Capability badges */}
        <HStack gap="3px" wrap="wrap">
          {model.capabilities.images && <HeroCapBadge icon={<FiEye size={10} />} label={t('settings.byokCapBadgeVision')} />}
          {model.capabilities.tools && <HeroCapBadge icon={<FiTool size={10} />} label={t('settings.byokCapBadgeTools')} />}
          {model.supportsThinking && <HeroCapBadge icon={<FiCpu size={10} />} label={t('settings.byokCapBadgeReasoning')} />}
        </HStack>

        {/* Cost stripe */}
        <Flex
          align="center"
          gap={3}
          px={3}
          py="6px"
          borderRadius={tokens.radius.md}
          bg="rgba(0, 0, 0, 0.2)"
          border="1px solid rgba(255, 255, 255, 0.04)"
          fontFamily={tokens.fontFamily.mono}
          fontSize="11px"
          color={tokens.colors.text.muted}
          flexWrap="wrap"
        >
          {model.pricing ? (
            <>
              <Text>${model.pricing.inputPer1M}/${model.pricing.outputPer1M} per 1M</Text>
              {lastCost !== null && (
                <>
                  <Box w="1px" h="10px" bg="rgba(255, 255, 255, 0.1)" />
                  <Text>
                    last:{' '}
                    <Text as="span" color={tokens.colors.accent.green}>
                      ~${lastCost < 0.01 ? lastCost.toFixed(4) : lastCost.toFixed(3)}
                    </Text>
                  </Text>
                </>
              )}
              {lastTokensUsed > 0 && (
                <>
                  <Box w="1px" h="10px" bg="rgba(255, 255, 255, 0.1)" />
                  <Text>{lastTokensUsed.toLocaleString()} tokens</Text>
                </>
              )}
              {lastTokensUsed === 0 && (
                <Text color={tokens.colors.text.disabled}>· {t('settings.byokNoRequestsYet')}</Text>
              )}
            </>
          ) : (
            <Text>— {t('settings.byokPricingNotAvailable')}</Text>
          )}
        </Flex>

        {/* Inline model switcher (collapsible) */}
        {showSwitcher && effectiveModels.length > 0 && (
          <Box pt={1}>
            <ModelPicker
              models={effectiveModels}
              selectedId={model.id}
              onSelect={(id) => {
                setActive(provider.id, id)
                setShowSwitcher(false)
              }}
            />
          </Box>
        )}

        {/* Primary actions */}
        <HStack gap={2} pt={1}>
          {effectiveModels.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              color={tokens.colors.text.primary}
              borderColor="rgba(254, 16, 99, 0.4)"
              bg="rgba(254, 16, 99, 0.08)"
              _hover={{ bg: 'rgba(254, 16, 99, 0.16)', borderColor: 'rgba(254, 16, 99, 0.6)' }}
              onClick={() => setShowSwitcher(v => !v)}
            >
              <FiZap style={{ marginRight: 4 }} />
              {showSwitcher ? t('settings.byokSwitchModelClose') : t('settings.byokSwitchModel')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            color={tokens.colors.text.secondary}
            borderColor={tokens.colors.border.default}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, borderColor: tokens.colors.border.subtle }}
            onClick={handleTest}
            disabled={testStatus === 'testing'}
          >
            {testStatus === 'testing'
              ? t('settings.byokTesting')
              : testStatus === 'ok'
                ? <><FiCheck style={{ marginRight: 4 }} /> {t('settings.byokTestOk')}</>
                : testStatus === 'fail'
                  ? <><FiAlertCircle style={{ marginRight: 4 }} /> {t('settings.byokTestFailed')}</>
                  : t('settings.byokTest')}
          </Button>
          <Box flex={1} />
          <Button
            size="sm"
            variant="ghost"
            color={tokens.colors.accent.red}
            _hover={{ bg: 'rgba(248, 81, 73, 0.1)' }}
            onClick={handleStop}
            title={t('settings.byokStopTooltip')}
          >
            <FiPower style={{ marginRight: 4 }} />
            {t('settings.byokStop')}
          </Button>
        </HStack>

        {testMessage && (
          <Text
            fontSize="10px"
            color={testStatus === 'ok' ? tokens.colors.accent.green : tokens.colors.accent.red}
            fontFamily={tokens.fontFamily.mono}
          >
            {testMessage}
          </Text>
        )}
      </VStack>
    </Box>
  )
}

// Capability badges are INFORMATIONAL ("the model has this capability"),
// not status (success/ok). Using semantic green confused scanning — users
// read it as "approved/active". Neutral palette here so semantic colors
// (green=ok, red=error, pink=active) keep their meaning elsewhere.
function HeroCapBadge(props: { icon: React.ReactNode; label: string }) {
  return (
    <HStack
      gap={1}
      px="6px"
      py="2px"
      borderRadius={tokens.radius.full}
      bg="rgba(255, 255, 255, 0.04)"
      border="1px solid"
      borderColor={tokens.colors.border.default}
    >
      <Box color={tokens.colors.text.muted}>{props.icon}</Box>
      <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
        {props.label}
      </Text>
    </HStack>
  )
}

// ── ProviderCard ──

function ProviderCard(props: {
  provider: ByokProvider
  isExpanded: boolean
  onToggle: () => void
}) {
  const { provider, isExpanded, onToggle } = props
  const t = useTranslation()
  const config = useByokStore(s => s.perProviderConfig[provider.id])
  const setKey = useByokStore(s => s.setKey)
  const deleteKey = useByokStore(s => s.deleteKey)
  const setBaseURL = useByokStore(s => s.setBaseURL)
  const setContextWindow = useByokStore(s => s.setContextWindow)
  const setActive = useByokStore(s => s.setActive)
  const testKey = useByokStore(s => s.testKey)
  const setUserDefinedModel = useByokStore(s => s.setUserDefinedModel)
  const clearUserDefinedModel = useByokStore(s => s.clearUserDefinedModel)
  const markConfigured = useByokStore(s => s.markConfigured)
  const refreshLocalModels = useByokStore(s => s.refreshLocalModels)

  const isCustom = provider.custom === true
  const isLocal = provider.local === true
  const hasKey = config?.hasKey === true
  const isConfigured = config?.configured === true
  const baseURL = config?.baseURL ?? ''
  const contextWindow = config?.contextWindow
  const userDefined = config?.userDefinedModel
  const dynamicModels = config?.dynamicCatalog?.models ?? []

  // For local providers the catalog is the dynamic list (Ollama /api/tags,
  // LM Studio /v1/models). For curated providers it's provider.models.
  const effectiveModels = isLocal ? dynamicModels : provider.models

  // Pick the first model when none picked — gives the dropdown a sensible
  // default. Custom and freshly-loaded local providers start with empty modelId.
  // Note: the active provider is filtered out of the catalog by the caller
  // (ApiKeysBody.otherProviders), so a card never renders for the currently
  // active provider — no need to seed selectedModel from activeModel.
  const initialModel = effectiveModels[0]?.id ?? ''
  const [selectedModel, setSelectedModel] = useState(initialModel)
  const [draftKey, setDraftKey] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  // "Other model" mode for curated providers — user typed a model id not in
  // the catalog. Capabilities are user-declared via three checkboxes.
  const [isOtherMode, setIsOtherMode] = useState(
    !!userDefined && userDefined.id === selectedModel
  )
  const [otherModelId, setOtherModelId] = useState(userDefined?.id ?? '')
  const [otherCaps, setOtherCaps] = useState<ByokModelCapabilities>(
    userDefined?.capabilities ?? { images: false, audio: false, video: false, tools: true },
  )
  const [otherThinking, setOtherThinking] = useState(userDefined?.supportsThinking ?? false)

  // No useEffect to sync from activeModel — ProviderCard only renders for
  // NON-active providers (caller filters via otherProviders). The "other mode"
  // is initialised from the persisted userDefinedModel in useState above.

  const handleSave = useCallback(async () => {
    if (!draftKey.trim()) return
    setSaveError(null)
    try {
      await setKey(provider.id, draftKey.trim())
      setDraftKey('')
    } catch (err) {
      // Keychain save failed (likely dev-build quirk — see byokStore.setKey).
      // Surface the message to the user instead of silently leaving them with
      // a "saved" UI state that doesn't reflect reality.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[byok] setKey failed:', err)
      setSaveError(message)
    }
  }, [draftKey, provider.id, setKey])

  const handleDelete = useCallback(async () => {
    try {
      await deleteKey(provider.id)
      setDraftKey('')
      setTestStatus('idle')
      setTestMessage(null)
    } catch (err) {
      console.error('[byok] deleteKey failed:', err)
    }
  }, [deleteKey, provider.id])

  const handleTest = useCallback(async () => {
    if (!selectedModel) return
    setTestStatus('testing')
    setTestMessage(null)
    const keyOverride = draftKey.trim() || undefined
    const result = await testKey(provider.id, selectedModel, keyOverride, baseURL || undefined)
    if (result.valid) {
      setTestStatus('ok')
      setTestMessage(result.latencyMs ? `${result.latencyMs} ms` : null)
    } else {
      setTestStatus('fail')
      setTestMessage(result.error?.slice(0, 120) || null)
    }
  }, [draftKey, baseURL, provider.id, selectedModel, testKey])

  const handleSetActive = useCallback(() => {
    if (!selectedModel) return
    // Persist the user-defined "other model" entry so the snapshot/resolveActive
    // path can synthesize a ByokModel from it on subsequent launches.
    if (isOtherMode && otherModelId.trim()) {
      setUserDefinedModel(provider.id, {
        id: otherModelId.trim(),
        capabilities: otherCaps,
        supportsThinking: otherThinking,
      })
    }
    // Local providers don't have a key — confirming the active selection
    // implicitly marks the provider as configured (Set Active is the moment
    // the user commits to "I've tested this and it works").
    if (isLocal && !isConfigured) {
      markConfigured(provider.id, true)
    }
    setActive(provider.id, selectedModel)
    // Note: deliberately NOT auto-toggling `enabled` here. A previous version
    // chained markConfigured + setActive + toggle in the same handler, which
    // — combined with each action's syncActiveSessionSnapshot dispatching a
    // microtask before React's batch render — produced "Maximum update depth
    // exceeded". The hero now resolves regardless of `enabled` (see active
    // memo) so the user gets immediate visual feedback after Set Active and
    // can flip the master toggle separately.
  }, [provider.id, selectedModel, setActive, isOtherMode, otherModelId, otherCaps, otherThinking, setUserDefinedModel, isLocal, isConfigured, markConfigured])

  const handleRefreshLocalModels = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const models = await refreshLocalModels(provider.id)
      if (!models) {
        setRefreshError(t('settings.byokLocalRefreshFailed'))
      } else if (models.length === 0) {
        setRefreshError(t('settings.byokLocalNoModels'))
      } else if (!selectedModel || !models.find(m => m.id === selectedModel)) {
        // Auto-pick the first model so the user has a valid selection
        setSelectedModel(models[0].id)
      }
    } finally {
      setRefreshing(false)
    }
  }, [provider.id, refreshLocalModels, selectedModel, t])

  // Compact-row summary used in the collapsed accordion state. Configured
  // providers show a green dot + last-4-chars hint; unconfigured show only
  // the catalog count so the user can scan "what's available" without
  // expanding every card. Click anywhere on the row toggles open/close.
  const summary = (
    <Flex
      as="button"
      align="center"
      justify="space-between"
      w="100%"
      px={4}
      py="10px"
      bg="transparent"
      cursor="pointer"
      textAlign="left"
      onClick={onToggle}
      aria-expanded={isExpanded}
      transition={tokens.transition.fast}
      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
    >
      <HStack gap={2} flex={1} minW={0}>
        <Text fontSize="14px" fontWeight="600" color={tokens.colors.text.primary} truncate>
          {provider.name}
        </Text>
        {isLocal && (
          <Text fontSize="10px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            LOCAL
          </Text>
        )}
        {isCustom && (
          <Text fontSize="10px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            CUSTOM
          </Text>
        )}
        {/* Catalog count — quick "how much does this provider give me?" cue */}
        {!isCustom && effectiveModels.length > 0 && (
          <Text fontSize="11px" color={tokens.colors.text.muted} flexShrink={0}>
            · {effectiveModels.length} {t('settings.byokRowModelsLabel')}
          </Text>
        )}
      </HStack>
      <HStack gap={2} flexShrink={0}>
        {/* Configured indicator: green dot + (cloud only) ····last4 */}
        {(hasKey || (isLocal && isConfigured)) && (
          <HStack gap={1.5}>
            <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.green} />
            <Text fontSize="10px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono}>
              {t('settings.byokRowConfigured')}
            </Text>
            {config?.keyHint && (
              <Text
                fontSize="10px"
                color={tokens.colors.text.disabled}
                fontFamily={tokens.fontFamily.mono}
              >
                ····{config.keyHint}
              </Text>
            )}
          </HStack>
        )}
        <Box
          color={tokens.colors.text.disabled}
          transition="transform 0.15s"
          transform={isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'}
        >
          <FiChevronDown size={14} />
        </Box>
      </HStack>
    </Flex>
  )

  return (
    <Box
      borderRadius={tokens.radius.lg}
      bg={tokens.colors.bg.card}
      border="1px solid"
      borderColor={isExpanded ? 'rgba(254, 16, 99, 0.2)' : tokens.colors.bg.cardBorder}
      transition={tokens.transition.fast}
      // overflow:visible — the model picker is an absolute-positioned dropdown
      // inside this card; overflow:hidden was clipping it so only the first
      // row was visible and the user couldn't change selection. The card's
      // rounded corners don't need overflow:hidden because no descendant
      // actually overflows the rounded edge in non-dropdown states.
      overflow="visible"
      position="relative"
    >
      {summary}
      {!isExpanded ? null : (
      <VStack align="stretch" gap={3} px={4} pb={4} pt={1} borderTop="1px solid" borderColor={tokens.colors.border.default}>

        {isCustom && (
          <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.5">
            {t('settings.byokCustomNote')}
          </Text>
        )}

        {isLocal && (
          <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.5">
            {t('settings.byokLocalNote')}
          </Text>
        )}

        {/* Key input — hidden for local providers (they typically have no
            auth; gateways with auth are the rare exception and aren't
            supported in v1). */}
        {!isLocal && (
          <VStack align="stretch" gap={1.5}>
            <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
              API Key
            </Text>
            <HStack gap={2}>
              <Input
                type="password"
                size="sm"
                placeholder={hasKey ? '••••••••' : t('settings.byokKeyPlaceholder')}
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                fontFamily={tokens.fontFamily.mono}
                fontSize="12px"
                bg={tokens.colors.bg.sidebar}
                borderColor={tokens.colors.border.default}
                _focus={{ borderColor: 'rgba(254, 16, 99, 0.5)', boxShadow: 'none' }}
                _hover={{ borderColor: tokens.colors.border.subtle }}
                // API keys are NOT website passwords — never auto-fill from
                // saved credentials, never offer to save here.
                autoComplete="new-password"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
              />
              {draftKey.trim() && (
                <Button
                  size="sm"
                  variant="solid"
                  bg={tokens.colors.accent.primary}
                  color="white"
                  _hover={{ bg: '#C10A69' }}
                  onClick={handleSave}
                >
                  {t('settings.byokSaveKey')}
                </Button>
              )}
              {hasKey && !draftKey.trim() && (
                <Button
                  size="sm"
                  variant="ghost"
                  color={tokens.colors.text.muted}
                  _hover={{ color: tokens.colors.accent.red, bg: 'rgba(248, 81, 73, 0.08)' }}
                  onClick={handleDelete}
                >
                  <FiTrash2 />
                </Button>
              )}
            </HStack>
            {hasKey && !draftKey.trim() && !saveError && (
              <HStack gap={2}>
                <Text fontSize="10px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono}>
                  ✓ {t('settings.byokKeySaved')}
                </Text>
                {config?.keyHint && (
                  <Text
                    fontSize="10px"
                    color={tokens.colors.text.disabled}
                    fontFamily={tokens.fontFamily.mono}
                    title={t('settings.byokKeyHintTooltip')}
                  >
                    ····{config.keyHint}
                  </Text>
                )}
              </HStack>
            )}
            {saveError && (
              <Text fontSize="10px" color={tokens.colors.accent.red} lineHeight="1.5">
                {saveError}
              </Text>
            )}
            {/* Trust line — explains storage location. Renders for both empty
                and saved states because the user needs to know BEFORE pasting
                that the key won't sit in plaintext anywhere. */}
            <HStack gap={1.5} mt="2px">
              <Box color={tokens.colors.text.disabled}>
                <FiLock size={9} />
              </Box>
              <Text fontSize="10px" color={tokens.colors.text.disabled}>
                {t('settings.byokKeychainHint').replace('{location}', KEYCHAIN_LABEL)}
              </Text>
            </HStack>
          </VStack>
        )}

        {/* Base URL */}
        <VStack align="stretch" gap={1.5}>
          <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
            {t('settings.byokBaseURL')}
          </Text>
          <Input
            size="sm"
            placeholder={provider.defaultBaseURL || t('settings.byokBaseURLPlaceholder')}
            value={baseURL}
            onChange={(e) => setBaseURL(provider.id, e.target.value)}
            fontFamily={tokens.fontFamily.mono}
            fontSize="11px"
            bg={tokens.colors.bg.sidebar}
            borderColor={tokens.colors.border.default}
            _focus={{ borderColor: 'rgba(254, 16, 99, 0.5)', boxShadow: 'none' }}
            _hover={{ borderColor: tokens.colors.border.subtle }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
          />
        </VStack>

        {/* Context window — the USER declares the model's window (BYOK bypasses
            the worker, so there's no X-Model-Context-Window header). Drives the
            agent's auto-compact pressure for this model. */}
        <VStack align="stretch" gap={1.5}>
          <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
            {t('settings.byokContextWindow')}
          </Text>
          <ContextWindowPicker
            value={contextWindow}
            onChange={(v) => setContextWindow(provider.id, v)}
          />
          <Text fontSize="10px" color={tokens.colors.text.disabled} lineHeight="1.5">
            {t('settings.byokContextWindowHint')}
          </Text>
        </VStack>

        {/* Local server panel: reachability + refresh models. Replaces the
            cloud Test button for local providers — pinging the discovery
            endpoint is both validation and catalog refresh. */}
        {isLocal && (
          <VStack align="stretch" gap={1.5}>
            <Flex align="center" justify="space-between">
              <HStack gap={1.5}>
                <Box color={dynamicModels.length > 0 ? tokens.colors.accent.green : tokens.colors.text.disabled}>
                  {dynamicModels.length > 0 ? <FiWifi size={11} /> : <FiWifiOff size={11} />}
                </Box>
                <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
                  {dynamicModels.length > 0
                    ? `${dynamicModels.length} ${t('settings.byokLocalReachable')}`
                    : t('settings.byokLocalUnknown')}
                </Text>
              </HStack>
              <Button
                size="sm"
                variant="outline"
                color={tokens.colors.text.secondary}
                borderColor={tokens.colors.border.default}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, borderColor: tokens.colors.border.subtle }}
                onClick={handleRefreshLocalModels}
                disabled={refreshing}
              >
                <FiRefreshCw style={{ marginRight: 4 }} />
                {refreshing ? t('settings.byokLocalRefreshing') : t('settings.byokLocalRefresh')}
              </Button>
            </Flex>
            {refreshError && (
              <Text fontSize="10px" color={tokens.colors.accent.red} lineHeight="1.5">
                {refreshError}
              </Text>
            )}
          </VStack>
        )}

        {/* Model picker (registered + dynamic) */}
        {!isCustom && effectiveModels.length > 0 && !isOtherMode && (
          <VStack align="stretch" gap={1.5}>
            <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
              {t('settings.byokModel')}
            </Text>
            <ModelPicker
              models={effectiveModels}
              selectedId={selectedModel}
              onSelect={setSelectedModel}
              onPickOther={isLocal ? undefined : () => {
                setIsOtherMode(true)
                if (otherModelId) setSelectedModel(otherModelId)
              }}
            />
          </VStack>
        )}

        {/* "Other model" — free text + capability checkboxes for curated providers */}
        {!isCustom && isOtherMode && (
          <VStack align="stretch" gap={1.5}>
            <Flex justify="space-between" align="center">
              <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
                {t('settings.byokOtherModel')}
              </Text>
              <Box
                as="button"
                fontSize="10px"
                color={tokens.colors.text.muted}
                cursor="pointer"
                _hover={{ color: tokens.colors.text.primary }}
                onClick={() => {
                  setIsOtherMode(false)
                  setSelectedModel(provider.models[0]?.id ?? '')
                  clearUserDefinedModel(provider.id)
                }}
              >
                ← {t('settings.byokOtherCancel')}
              </Box>
            </Flex>
            <Input
              size="sm"
              placeholder={t('settings.byokOtherPlaceholder')}
              value={otherModelId}
              onChange={(e) => {
                setOtherModelId(e.target.value)
                setSelectedModel(e.target.value)
              }}
              fontFamily={tokens.fontFamily.mono}
              fontSize="12px"
              bg={tokens.colors.bg.sidebar}
              borderColor={tokens.colors.border.default}
              _focus={{ borderColor: 'rgba(254, 16, 99, 0.5)', boxShadow: 'none' }}
              _hover={{ borderColor: tokens.colors.border.subtle }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
            />
            <Text fontSize="10px" color={tokens.colors.text.muted}>
              {t('settings.byokOtherCapsHint')}
            </Text>
            <CapabilityCheckboxes
              capabilities={otherCaps}
              supportsThinking={otherThinking}
              onChange={(caps, thinking) => {
                setOtherCaps(caps)
                setOtherThinking(thinking)
                if (otherModelId.trim()) {
                  setUserDefinedModel(provider.id, {
                    id: otherModelId.trim(),
                    capabilities: caps,
                    supportsThinking: thinking,
                  })
                }
              }}
            />
          </VStack>
        )}

        {isCustom && (
          <VStack align="stretch" gap={1.5}>
            <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
              {t('settings.byokModel')}
            </Text>
            <Input
              size="sm"
              placeholder="model-id"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              fontFamily={tokens.fontFamily.mono}
              fontSize="12px"
              bg={tokens.colors.bg.sidebar}
              borderColor={tokens.colors.border.default}
              _focus={{ borderColor: 'rgba(254, 16, 99, 0.5)', boxShadow: 'none' }}
              _hover={{ borderColor: tokens.colors.border.subtle }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
            />
          </VStack>
        )}

        {/* Test + Set active row */}
        <HStack gap={2} pt={1}>
          <Button
            size="sm"
            variant="outline"
            color={tokens.colors.text.secondary}
            borderColor={tokens.colors.border.default}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, borderColor: tokens.colors.border.subtle }}
            onClick={handleTest}
            disabled={
              isLocal
                ? !selectedModel || testStatus === 'testing'
                : (!hasKey && !draftKey.trim()) || !selectedModel || testStatus === 'testing'
            }
          >
            {testStatus === 'testing'
              ? t('settings.byokTesting')
              : testStatus === 'ok'
                ? <><FiCheck style={{ marginRight: 4 }} /> {t('settings.byokTestOk')}</>
                : testStatus === 'fail'
                  ? <><FiAlertCircle style={{ marginRight: 4 }} /> {t('settings.byokTestFailed')}</>
                  : t('settings.byokTest')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            color={tokens.colors.text.secondary}
            borderColor={tokens.colors.border.default}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, borderColor: tokens.colors.border.subtle }}
            onClick={handleSetActive}
            disabled={(isLocal ? !selectedModel : !hasKey || !selectedModel)}
          >
            {t('settings.byokSetActive')}
          </Button>
        </HStack>

        {testMessage && (
          <Text
            fontSize="10px"
            color={testStatus === 'ok' ? tokens.colors.accent.green : tokens.colors.accent.red}
            fontFamily={tokens.fontFamily.mono}
          >
            {testMessage}
          </Text>
        )}
      </VStack>
      )}
    </Box>
  )
}

// ── CapabilityRow ──

// CapabilityRow + CapabilityBadge removed — replaced by inline capability
// icons in ModelPicker (more compact, easier to scan a list of 5+ models).

// ── CapabilityCheckboxes ──
//
// Three-checkbox row used by the "Other model" mode (and the Custom provider)
// where the user has to declare what the model can do. The values flow into
// the X-BYOK-Capabilities request header so the IDE's paperclip gate, the
// thinking toggle, and the backend's image-shape conversion all behave
// consistently with what the model actually supports.

function CapabilityCheckboxes(props: {
  capabilities: ByokModelCapabilities
  supportsThinking: boolean
  onChange: (caps: ByokModelCapabilities, supportsThinking: boolean) => void
}) {
  const t = useTranslation()
  const update = (next: Partial<ByokModelCapabilities>, nextThinking?: boolean) => {
    props.onChange(
      { ...props.capabilities, ...next },
      nextThinking !== undefined ? nextThinking : props.supportsThinking,
    )
  }
  return (
    <HStack gap={3} flexWrap="wrap">
      <CapCheckbox
        checked={props.capabilities.images}
        icon={<FiEye size={11} />}
        label={t('settings.byokCapImages')}
        onChange={(v) => update({ images: v })}
      />
      <CapCheckbox
        checked={props.capabilities.tools}
        icon={<FiTool size={11} />}
        label={t('settings.byokCapTools')}
        onChange={(v) => update({ tools: v })}
      />
      <CapCheckbox
        checked={props.supportsThinking}
        icon={<FiCpu size={11} />}
        label={t('settings.byokCapThinking')}
        onChange={(v) => update({}, v)}
      />
    </HStack>
  )
}

function CapCheckbox(props: {
  checked: boolean
  icon: React.ReactNode
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <HStack
      as="label"
      gap={1.5}
      px="8px"
      py="4px"
      borderRadius={tokens.radius.full}
      bg={props.checked ? 'rgba(46, 160, 67, 0.1)' : 'rgba(255, 255, 255, 0.04)'}
      border="1px solid"
      borderColor={props.checked ? 'rgba(46, 160, 67, 0.3)' : tokens.colors.border.default}
      cursor="pointer"
      transition={tokens.transition.fast}
      _hover={{ borderColor: props.checked ? 'rgba(46, 160, 67, 0.5)' : tokens.colors.border.subtle }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        style={{ accentColor: 'rgba(46, 160, 67, 0.8)', width: 12, height: 12, cursor: 'pointer' }}
      />
      <Box color={props.checked ? tokens.colors.accent.green : tokens.colors.text.disabled}>
        {props.icon}
      </Box>
      <Text
        fontSize="10px"
        color={props.checked ? tokens.colors.accent.green : tokens.colors.text.muted}
        fontFamily={tokens.fontFamily.mono}
      >
        {props.label}
      </Text>
    </HStack>
  )
}

// ── ContextWindowPicker ──
//
// Custom dropdown for the user-declared BYOK context window. Matches the
// ModelPicker chrome (dark glass trigger + panel, brand-pink selection) so the
// BYOK card reads as one designed surface rather than a stray native <select>.

function ContextWindowPicker(props: {
  value: number | undefined
  onChange: (v: number | undefined) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected =
    CONTEXT_WINDOW_OPTIONS.find(o => o.value === props.value) ?? CONTEXT_WINDOW_OPTIONS[0]

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  return (
    <Box ref={ref} position="relative">
      <Flex
        as="button"
        align="center"
        justify="space-between"
        w="100%"
        px={3}
        py="8px"
        borderRadius={tokens.radius.md}
        bg={tokens.colors.bg.sidebar}
        border="1px solid"
        textAlign="left"
        borderColor={isOpen ? 'rgba(254, 16, 99, 0.5)' : tokens.colors.border.default}
        cursor="pointer"
        transition={tokens.transition.fast}
        _hover={{ borderColor: tokens.colors.border.subtle }}
        _focusVisible={{ borderColor: 'rgba(254, 16, 99, 0.7)', outline: 'none' }}
        onClick={() => setIsOpen(v => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setIsOpen(false)
          else if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !isOpen) {
            e.preventDefault()
            setIsOpen(true)
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <HStack gap={2} flex={1} minW={0}>
          <Text fontSize="12px" color={tokens.colors.text.primary} fontWeight="500" fontFamily={tokens.fontFamily.mono}>
            {selected.label}
          </Text>
          {selected.value !== undefined && (
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              {selected.value.toLocaleString()} tokens
            </Text>
          )}
        </HStack>
        <Box
          color={tokens.colors.text.disabled}
          transition="transform 0.15s"
          transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}
        >
          <FiChevronDown size={14} />
        </Box>
      </Flex>

      {isOpen && (
        <Box
          role="listbox"
          position="absolute"
          top="calc(100% + 4px)"
          left={0}
          right={0}
          maxH="280px"
          overflowY="auto"
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.panel}
          borderRadius={tokens.radius.md}
          boxShadow="0 8px 24px rgba(0,0,0,0.4)"
          zIndex={tokens.zIndex.dropdown}
          py={1}
        >
          {CONTEXT_WINDOW_OPTIONS.map(opt => {
            const isSelected = opt.value === props.value
            return (
              <Flex
                key={opt.label}
                as="button"
                role="option"
                aria-selected={isSelected}
                align="center"
                justify="space-between"
                w="100%"
                px={3}
                py="8px"
                textAlign="left"
                bg={isSelected ? 'rgba(254, 16, 99, 0.08)' : 'transparent'}
                cursor="pointer"
                transition={tokens.transition.fast}
                _hover={{ bg: isSelected ? 'rgba(254, 16, 99, 0.12)' : tokens.colors.bg.hoverSubtle }}
                onClick={() => {
                  props.onChange(opt.value)
                  setIsOpen(false)
                }}
              >
                <HStack gap={1.5} minW={0}>
                  <Text
                    fontSize="12px"
                    fontFamily={tokens.fontFamily.mono}
                    color={isSelected ? tokens.colors.accent.primary : tokens.colors.text.primary}
                    fontWeight={isSelected ? '600' : '500'}
                  >
                    {opt.label}
                  </Text>
                  {opt.value !== undefined && (
                    <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
                      {opt.value.toLocaleString()}
                    </Text>
                  )}
                </HStack>
                {isSelected && (
                  <Box color={tokens.colors.accent.primary} flexShrink={0}>
                    <FiCheck size={12} />
                  </Box>
                )}
              </Flex>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

// ── ModelPicker ──
//
// Custom dropdown that beats the native <select>: shows the model label,
// capability icons (vision / tools / reasoning) and inline pricing in the
// trigger AND in each option row. Searchable when the list is long enough
// to make scrolling feel slow (5+ models). Themed to match the rest of
// Settings — dark glass with the brand pink accent on hover/selection.

function ModelPicker(props: {
  models: ByokModel[]
  selectedId: string
  onSelect: (id: string) => void
  /** When provided, an extra "Other model" row appears at the bottom of the
   *  dropdown that, on click, transitions the parent to free-text mode. Only
   *  passed for curated providers — Custom already has free-text by default. */
  onPickOther?: () => void
}) {
  const t = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [filter, setFilter] = useState('')
  // Active descendant index over the visible list (filtered models +
  // optionally the "other" sentinel at the end). -1 = none focused.
  const [activeIndex, setActiveIndex] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const idBase = useRef(`bym-${Math.random().toString(36).slice(2, 9)}`)
  const listboxId = `${idBase.current}-list`

  const selected = props.models.find(m => m.id === props.selectedId)
  const showSearch = props.models.length >= 5

  const filteredModels = filter.trim()
    ? props.models.filter(m =>
        m.label.toLowerCase().includes(filter.toLowerCase())
        || m.id.toLowerCase().includes(filter.toLowerCase())
      )
    : props.models

  // Total navigable rows = filtered models + 1 if "Other" is present.
  const otherIndex = props.onPickOther ? filteredModels.length : -1
  const totalRows = filteredModels.length + (props.onPickOther ? 1 : 0)

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
        setFilter('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // Reset filter + active index when closing
  useEffect(() => {
    if (!isOpen) {
      setFilter('')
      setActiveIndex(-1)
    } else {
      // On open: focus the currently selected row, or first row if none.
      const selectedIdx = filteredModels.findIndex(m => m.id === props.selectedId)
      setActiveIndex(selectedIdx >= 0 ? selectedIdx : (totalRows > 0 ? 0 : -1))
    }
    // We deliberately read filteredModels/totalRows at open-time only; deps
    // tracking those would re-fire as the user types in the filter and reset
    // their navigation position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Clamp active index when filter shrinks the list under the current cursor.
  useEffect(() => {
    if (!isOpen) return
    if (totalRows === 0) {
      setActiveIndex(-1)
    } else if (activeIndex >= totalRows) {
      setActiveIndex(totalRows - 1)
    } else if (activeIndex < 0 && totalRows > 0) {
      setActiveIndex(0)
    }
  }, [filter, isOpen, totalRows, activeIndex])

  // Scroll the active row into view as the user navigates with arrows.
  useEffect(() => {
    if (!isOpen || activeIndex < 0) return
    const el = listRef.current?.querySelector(`[data-row-index="${activeIndex}"]`)
    if (el && 'scrollIntoView' in el) {
      ;(el as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, isOpen])

  const commitSelection = (idx: number) => {
    if (idx === otherIndex && props.onPickOther) {
      setIsOpen(false)
      props.onPickOther()
      requestAnimationFrame(() => triggerRef.current?.focus())
      return
    }
    const m = filteredModels[idx]
    if (!m) return
    props.onSelect(m.id)
    setIsOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const handleTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setIsOpen(true)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIsOpen(true)
    }
  }

  const handleListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => (totalRows === 0 ? -1 : (i + 1) % totalRows))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => (totalRows === 0 ? -1 : (i - 1 + totalRows) % totalRows))
    } else if (e.key === 'Home') {
      e.preventDefault()
      if (totalRows > 0) setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      if (totalRows > 0) setActiveIndex(totalRows - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0) commitSelection(activeIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setIsOpen(false)
      requestAnimationFrame(() => triggerRef.current?.focus())
    } else if (e.key === 'Tab') {
      // Allow Tab to close the menu and pass focus along naturally.
      setIsOpen(false)
    }
  }

  const activeOptionId = activeIndex >= 0
    ? (activeIndex === otherIndex
        ? `${idBase.current}-other`
        : `${idBase.current}-opt-${filteredModels[activeIndex]?.id}`)
    : undefined

  return (
    <Box ref={ref} position="relative">
      {/* Trigger */}
      <Flex
        as="button"
        ref={triggerRef as unknown as React.Ref<HTMLDivElement>}
        align="center"
        justify="space-between"
        w="100%"
        px={3}
        py="8px"
        borderRadius={tokens.radius.md}
        bg={tokens.colors.bg.sidebar}
        border="1px solid"
        textAlign="left"
        borderColor={isOpen ? 'rgba(254, 16, 99, 0.5)' : tokens.colors.border.default}
        cursor="pointer"
        transition={tokens.transition.fast}
        _hover={{ borderColor: tokens.colors.border.subtle }}
        _focusVisible={{ borderColor: 'rgba(254, 16, 99, 0.7)', outline: 'none' }}
        onClick={() => setIsOpen(v => !v)}
        onKeyDown={handleTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={isOpen ? activeOptionId : undefined}
      >
        <HStack gap={2} flex={1} minW={0}>
          <Text fontSize="12px" color={tokens.colors.text.primary} fontWeight="500" truncate>
            {selected?.label || t('byok.modelPickerSelect')}
          </Text>
          {selected && <CapabilityIcons model={selected} />}
        </HStack>
        <HStack gap={2} flexShrink={0}>
          {selected && <PricingTag model={selected} compact />}
          <Box color={tokens.colors.text.disabled} transition="transform 0.15s" transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}>
            <FiChevronDown size={14} />
          </Box>
        </HStack>
      </Flex>

      {/* Dropdown */}
      {isOpen && (
        <Box
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          onKeyDown={handleListKey}
          position="absolute"
          top="calc(100% + 4px)"
          left={0}
          right={0}
          maxH="320px"
          overflowY="auto"
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.panel}
          borderRadius={tokens.radius.md}
          boxShadow="0 8px 24px rgba(0,0,0,0.4)"
          zIndex={tokens.zIndex.dropdown}
          py={1}
        >
          {showSearch && (
            <Box px={2} pb={1} pt={1}>
              <Input
                size="sm"
                autoFocus
                placeholder={t('byok.modelPickerFilter')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={handleListKey}
                fontSize="12px"
                bg={tokens.colors.bg.sidebar}
                borderColor={tokens.colors.border.default}
                _focus={{ borderColor: 'rgba(254, 16, 99, 0.5)', boxShadow: 'none' }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
              />
            </Box>
          )}
          {filteredModels.length === 0 ? (
            <Box px={3} py={2}>
              <Text fontSize="11px" color={tokens.colors.text.disabled}>
                {t('byok.modelPickerNoResults')}
              </Text>
            </Box>
          ) : (
            filteredModels.map((m, idx) => {
              const isSelected = m.id === props.selectedId
              const isActive = idx === activeIndex
              return (
                <Flex
                  key={m.id}
                  id={`${idBase.current}-opt-${m.id}`}
                  data-row-index={idx}
                  role="option"
                  aria-selected={isSelected}
                  as="button"
                  align="center"
                  justify="space-between"
                  w="100%"
                  px={3}
                  py="8px"
                  textAlign="left"
                  bg={isSelected
                    ? 'rgba(254, 16, 99, 0.08)'
                    : isActive
                      ? tokens.colors.bg.hoverSubtle
                      : 'transparent'}
                  cursor="pointer"
                  transition={tokens.transition.fast}
                  _hover={{ bg: isSelected ? 'rgba(254, 16, 99, 0.12)' : tokens.colors.bg.hoverSubtle }}
                  onClick={() => commitSelection(idx)}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <VStack align="flex-start" gap={0} flex={1} minW={0}>
                    <HStack gap={1.5} w="100%">
                      <Text
                        fontSize="12px"
                        color={isSelected ? tokens.colors.accent.primary : tokens.colors.text.primary}
                        fontWeight={isSelected ? '600' : '500'}
                        truncate
                      >
                        {m.label}
                      </Text>
                      {isSelected && (
                        <Box color={tokens.colors.accent.primary} flexShrink={0}>
                          <FiCheck size={12} />
                        </Box>
                      )}
                    </HStack>
                    <Text
                      fontSize="10px"
                      color={tokens.colors.text.disabled}
                      fontFamily={tokens.fontFamily.mono}
                      truncate
                      maxW="100%"
                    >
                      {m.id}
                    </Text>
                  </VStack>
                  <HStack gap={2} flexShrink={0} ml={2}>
                    <CapabilityIcons model={m} />
                    <PricingTag model={m} compact />
                  </HStack>
                </Flex>
              )
            })
          )}
          {props.onPickOther && (
            <>
              <Box mx={2} my={1} h="1px" bg={tokens.colors.border.default} />
              <Flex
                id={`${idBase.current}-other`}
                data-row-index={otherIndex}
                role="option"
                aria-selected={false}
                as="button"
                align="center"
                gap={2}
                w="100%"
                px={3}
                py="8px"
                textAlign="left"
                bg={activeIndex === otherIndex ? tokens.colors.bg.hoverSubtle : 'transparent'}
                cursor="pointer"
                transition={tokens.transition.fast}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                onClick={() => commitSelection(otherIndex)}
                onMouseEnter={() => setActiveIndex(otherIndex)}
              >
                <Box color={tokens.colors.text.muted}>
                  <FiPlus size={12} />
                </Box>
                <Text fontSize="12px" color={tokens.colors.text.secondary} fontWeight="500">
                  {t('byok.modelPickerOther')}
                </Text>
              </Flex>
            </>
          )}
        </Box>
      )}
    </Box>
  )
}

// ── CapabilityIcons (compact icon row for the dropdown) ──

function CapabilityIcons(props: { model: ByokModel }) {
  const t = useTranslation()
  const { capabilities, supportsThinking } = props.model
  return (
    <HStack gap="3px">
      {capabilities.images && (
        <Box color="rgba(46, 160, 67, 0.7)" title={t('byok.capTooltipVision')} aria-label={t('byok.capTooltipVision')}>
          <FiEye size={11} />
        </Box>
      )}
      {capabilities.tools && (
        <Box color="rgba(163, 113, 247, 0.7)" title={t('byok.capTooltipTools')} aria-label={t('byok.capTooltipTools')}>
          <FiTool size={11} />
        </Box>
      )}
      {supportsThinking && (
        <Box color="rgba(247, 127, 0, 0.7)" title={t('byok.capTooltipReasoning')} aria-label={t('byok.capTooltipReasoning')}>
          <FiCpu size={11} />
        </Box>
      )}
    </HStack>
  )
}

// ── PricingTag (compact $/M format) ──

function PricingTag(props: { model: ByokModel; compact?: boolean }) {
  const p = props.model.pricing
  if (!p) {
    return (
      <Text
        fontSize="10px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
      >
        —
      </Text>
    )
  }
  const fmt = (n: number) => n < 1 ? `$${n.toFixed(2)}` : `$${n}`
  return (
    <Text
      fontSize="10px"
      color={tokens.colors.text.muted}
      fontFamily={tokens.fontFamily.mono}
      whiteSpace="nowrap"
      title={`Input ${fmt(p.inputPer1M)}/M • Output ${fmt(p.outputPer1M)}/M`}
    >
      {fmt(p.inputPer1M)}/{fmt(p.outputPer1M)}
    </Text>
  )
}
