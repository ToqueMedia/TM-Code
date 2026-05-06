import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Box, Button, Flex, HStack, Input, Switch, Text, VStack } from '@chakra-ui/react'
import { FiCheck, FiAlertCircle, FiTrash2, FiEye, FiTool, FiCpu, FiChevronDown, FiPlus, FiKey, FiPower, FiZap } from 'react-icons/fi'
import { useByokStore, type ByokProvider, type ByokModel, type ByokModelCapabilities } from '../../../stores/byokStore'
import { useBillingStore } from '../../../stores/billingStore'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'

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
  perProviderConfig: Record<string, { hasKey: boolean; baseURL?: string; lastUsed?: number; userDefinedModel?: { id: string; capabilities: ByokModelCapabilities; supportsThinking: boolean } }>
}) {
  const t = useTranslation()
  const { providers, enabled, activeProvider, activeModel, perProviderConfig } = props
  const [catalogOpen, setCatalogOpen] = useState(false)

  // Resolve the "active" tuple — provider + model + baseURL — same logic
  // as byokStore.resolveActive but inline so the hero re-renders when
  // any of the contributing fields change.
  const active = useMemo(() => {
    if (!enabled || !activeProvider || !activeModel) return null
    const provider = providers.find(p => p.id === activeProvider)
    if (!provider) return null
    const config = perProviderConfig[activeProvider]
    const baseURL = (config?.baseURL || provider.defaultBaseURL).replace(/\/$/, '')
    const userDefined = config?.userDefinedModel
    const registryModel = provider.models.find(m => m.id === activeModel)
    let model: ByokModel
    if (registryModel) {
      model = registryModel
    } else if (userDefined && userDefined.id === activeModel) {
      model = {
        id: userDefined.id,
        label: userDefined.id,
        capabilities: userDefined.capabilities,
        contextWindow: 0,
        supportsThinking: userDefined.supportsThinking,
      }
    } else if (provider.custom) {
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
  }, [enabled, activeProvider, activeModel, providers, perProviderConfig])

  // Sorted catalog (without the active provider when active is set).
  const otherProviders = useMemo(() => {
    return [...providers]
      .filter(p => !active || p.id !== active.provider.id)
      .sort((a, b) => {
        if (a.custom && !b.custom) return 1
        if (b.custom && !a.custom) return -1
        const aUsed = perProviderConfig[a.id]?.lastUsed ?? 0
        const bUsed = perProviderConfig[b.id]?.lastUsed ?? 0
        return bUsed - aUsed
      })
  }, [providers, active, perProviderConfig])

  return (
    <VStack align="stretch" gap={4}>
      {active && (
        <ActiveHeroCard
          provider={active.provider}
          model={active.model}
          baseURL={active.baseURL}
        />
      )}

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
          >
            <Text fontSize="12px" fontWeight="500" color={tokens.colors.text.secondary}>
              {t('settings.byokOrSwitchTo')} ({otherProviders.length})
            </Text>
            <Box color={tokens.colors.text.disabled} transform={catalogOpen ? 'rotate(180deg)' : 'rotate(0deg)'} transition="transform 0.15s">
              <FiChevronDown size={14} />
            </Box>
          </Flex>
          {catalogOpen && (
            <VStack align="stretch" gap={3} opacity={enabled ? 1 : 0.5} pointerEvents={enabled ? 'auto' : 'none'}>
              {otherProviders.map(provider => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  isActive={false}
                  activeModel={null}
                />
              ))}
            </VStack>
          )}
        </VStack>
      ) : (
        <VStack align="stretch" gap={3} opacity={enabled ? 1 : 0.5} pointerEvents={enabled ? 'auto' : 'none'}>
          {otherProviders.map(provider => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isActive={false}
              activeModel={null}
            />
          ))}
        </VStack>
      )}
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
  const toggle = useByokStore(s => s.toggle)
  const setActive = useByokStore(s => s.setActive)
  const testKey = useByokStore(s => s.testKey)
  const lastTokensUsed = useBillingStore(s => s.lastTokensUsed)

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
          </HStack>
        </Flex>

        {/* Capability badges */}
        <HStack gap="3px" wrap="wrap">
          {model.capabilities.images && <HeroCapBadge icon={<FiEye size={10} />} label="vision" />}
          {model.capabilities.tools && <HeroCapBadge icon={<FiTool size={10} />} label="tools" />}
          {model.supportsThinking && <HeroCapBadge icon={<FiCpu size={10} />} label="reasoning" />}
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
              <Box w="1px" h="10px" bg="rgba(255, 255, 255, 0.1)" />
              <Text>
                last:{' '}
                <Text as="span" color={lastCost !== null ? tokens.colors.accent.green : tokens.colors.text.disabled}>
                  {lastCost !== null ? `~$${lastCost < 0.01 ? lastCost.toFixed(4) : lastCost.toFixed(3)}` : '—'}
                </Text>
              </Text>
              {lastTokensUsed > 0 && (
                <>
                  <Box w="1px" h="10px" bg="rgba(255, 255, 255, 0.1)" />
                  <Text>{lastTokensUsed.toLocaleString()} tokens</Text>
                </>
              )}
            </>
          ) : (
            <Text>— pricing not available (e.g. OpenRouter passthrough)</Text>
          )}
        </Flex>

        {/* Inline model switcher (collapsible) */}
        {showSwitcher && provider.models.length > 0 && (
          <Box pt={1}>
            <ModelPicker
              models={provider.models}
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
          {provider.models.length > 0 && (
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

function HeroCapBadge(props: { icon: React.ReactNode; label: string }) {
  return (
    <HStack
      gap={1}
      px="6px"
      py="2px"
      borderRadius={tokens.radius.full}
      bg="rgba(46, 160, 67, 0.1)"
      border="1px solid rgba(46, 160, 67, 0.25)"
    >
      <Box color={tokens.colors.accent.green}>{props.icon}</Box>
      <Text fontSize="10px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono}>
        {props.label}
      </Text>
    </HStack>
  )
}

// ── ProviderCard ──

function ProviderCard(props: {
  provider: ByokProvider
  isActive: boolean
  activeModel: string | null
}) {
  const { provider, isActive, activeModel } = props
  const t = useTranslation()
  const config = useByokStore(s => s.perProviderConfig[provider.id])
  const setKey = useByokStore(s => s.setKey)
  const deleteKey = useByokStore(s => s.deleteKey)
  const setBaseURL = useByokStore(s => s.setBaseURL)
  const setActive = useByokStore(s => s.setActive)
  const testKey = useByokStore(s => s.testKey)
  const setUserDefinedModel = useByokStore(s => s.setUserDefinedModel)
  const clearUserDefinedModel = useByokStore(s => s.clearUserDefinedModel)

  const hasKey = config?.hasKey === true
  const baseURL = config?.baseURL ?? ''
  const userDefined = config?.userDefinedModel

  // Pick the first registry model when none picked — gives the dropdown a
  // sensible default. Users on the custom provider start with empty modelId.
  const initialModel = activeModel ?? provider.models[0]?.id ?? ''
  const [selectedModel, setSelectedModel] = useState(initialModel)
  const [draftKey, setDraftKey] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

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

  useEffect(() => {
    if (activeModel && activeModel !== selectedModel) {
      setSelectedModel(activeModel)
      // If activeModel matches a user-defined slot, switch into other mode.
      if (userDefined && userDefined.id === activeModel) {
        setIsOtherMode(true)
        setOtherModelId(userDefined.id)
        setOtherCaps(userDefined.capabilities)
        setOtherThinking(userDefined.supportsThinking)
      }
    }
  }, [activeModel, selectedModel, userDefined])

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
    setActive(provider.id, selectedModel)
  }, [provider.id, selectedModel, setActive, isOtherMode, otherModelId, otherCaps, otherThinking, setUserDefinedModel])

  const isCustom = provider.custom === true
  const isLocal = provider.local === true

  return (
    <Box
      px={4}
      py={4}
      borderRadius={tokens.radius.lg}
      bg={tokens.colors.bg.card}
      border="1px solid"
      borderColor={isActive ? 'rgba(254, 16, 99, 0.35)' : tokens.colors.bg.cardBorder}
      transition={tokens.transition.fast}
    >
      <VStack align="stretch" gap={3}>
        {/* Header: name + active badge */}
        <Flex align="center" justify="space-between">
          <HStack gap={2}>
            <Text fontSize="14px" fontWeight="600" color={tokens.colors.text.primary}>
              {provider.name}
            </Text>
            {isLocal && (
              <Text fontSize="10px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono}>
                LOCAL
              </Text>
            )}
            {isCustom && (
              <Text fontSize="10px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono}>
                CUSTOM
              </Text>
            )}
          </HStack>
          {isActive && (
            <HStack gap={1}>
              <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.primary} />
              <Text fontSize="10px" fontWeight="700" color={tokens.colors.accent.primary} textTransform="uppercase" letterSpacing="0.04em">
                {t('settings.byokActive')}
              </Text>
            </HStack>
          )}
        </Flex>

        {isCustom && (
          <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.5">
            {t('settings.byokCustomNote')}
          </Text>
        )}

        {/* Key input */}
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
            <Text fontSize="10px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono}>
              ✓ {t('settings.byokKeySaved')}
            </Text>
          )}
          {saveError && (
            <Text fontSize="10px" color={tokens.colors.accent.red} lineHeight="1.5">
              {saveError}
            </Text>
          )}
        </VStack>

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
          />
        </VStack>

        {/* Model picker (registered models) */}
        {!isCustom && provider.models.length > 0 && !isOtherMode && (
          <VStack align="stretch" gap={1.5}>
            <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
              {t('settings.byokModel')}
            </Text>
            <ModelPicker
              models={provider.models}
              selectedId={selectedModel}
              onSelect={setSelectedModel}
              onPickOther={() => {
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
            disabled={(!hasKey && !draftKey.trim()) || !selectedModel || testStatus === 'testing' || isLocal}
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
            variant={isActive ? 'solid' : 'outline'}
            bg={isActive ? tokens.colors.accent.primary : undefined}
            color={isActive ? 'white' : tokens.colors.text.secondary}
            borderColor={tokens.colors.border.default}
            _hover={{
              bg: isActive ? '#C10A69' : tokens.colors.bg.hoverSubtle,
              borderColor: tokens.colors.border.subtle,
            }}
            onClick={handleSetActive}
            disabled={!hasKey || !selectedModel}
          >
            {isActive ? t('settings.byokActive') : t('settings.byokSetActive')}
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
  /** When provided, an extra "Outro modelo" row appears at the bottom of the
   *  dropdown that, on click, transitions the parent to free-text mode. Only
   *  passed for curated providers — Custom already has free-text by default. */
  onPickOther?: () => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const selected = props.models.find(m => m.id === props.selectedId)
  const showSearch = props.models.length >= 5

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

  // Reset filter when closing
  useEffect(() => {
    if (!isOpen) setFilter('')
  }, [isOpen])

  const filteredModels = filter.trim()
    ? props.models.filter(m =>
        m.label.toLowerCase().includes(filter.toLowerCase())
        || m.id.toLowerCase().includes(filter.toLowerCase())
      )
    : props.models

  return (
    <Box ref={ref} position="relative">
      {/* Trigger */}
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
        onClick={() => setIsOpen(!isOpen)}
      >
        <HStack gap={2} flex={1} minW={0}>
          <Text fontSize="12px" color={tokens.colors.text.primary} fontWeight="500" truncate>
            {selected?.label || 'Selecciona um modelo'}
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
                placeholder="Filtrar modelos…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                fontSize="12px"
                bg={tokens.colors.bg.sidebar}
                borderColor={tokens.colors.border.default}
                _focus={{ borderColor: 'rgba(254, 16, 99, 0.5)', boxShadow: 'none' }}
              />
            </Box>
          )}
          {filteredModels.length === 0 ? (
            <Box px={3} py={2}>
              <Text fontSize="11px" color={tokens.colors.text.disabled}>
                Sem resultados.
              </Text>
            </Box>
          ) : (
            filteredModels.map(m => {
              const isSelected = m.id === props.selectedId
              return (
                <Flex
                  key={m.id}
                  as="button"
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
                    props.onSelect(m.id)
                    setIsOpen(false)
                  }}
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
                as="button"
                align="center"
                gap={2}
                w="100%"
                px={3}
                py="8px"
                textAlign="left"
                bg="transparent"
                cursor="pointer"
                transition={tokens.transition.fast}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                onClick={() => {
                  setIsOpen(false)
                  props.onPickOther?.()
                }}
              >
                <Box color={tokens.colors.text.muted}>
                  <FiPlus size={12} />
                </Box>
                <Text fontSize="12px" color={tokens.colors.text.secondary} fontWeight="500">
                  Outro modelo (escrever ID)
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
  const { capabilities, supportsThinking } = props.model
  return (
    <HStack gap="3px">
      {capabilities.images && (
        <Box color="rgba(46, 160, 67, 0.7)" title="Vision (image input)">
          <FiEye size={11} />
        </Box>
      )}
      {capabilities.tools && (
        <Box color="rgba(163, 113, 247, 0.7)" title="Tool calling">
          <FiTool size={11} />
        </Box>
      )}
      {supportsThinking && (
        <Box color="rgba(247, 127, 0, 0.7)" title="Reasoning / thinking">
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
