import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Flex, NativeSelect, Text, VStack } from '@chakra-ui/react'
import { FiRefreshCw } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import ModelsPanel from './ModelsPanel'

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

type AdminTab = 'personas' | 'sidecars' | 'catalog' | 'live'

const TABS: Array<{ id: AdminTab; key: 'admin.tab.personas' | 'admin.tab.sidecars' | 'admin.tab.catalog' | 'admin.tab.live' }> = [
  { id: 'personas', key: 'admin.tab.personas' },
  { id: 'sidecars', key: 'admin.tab.sidecars' },
  { id: 'catalog', key: 'admin.tab.catalog' },
  { id: 'live', key: 'admin.tab.live' },
]

function StatusPill(props: { live: boolean; label: string }) {
  return props.live ? (
    <Flex align="center" gap="5px" px="8px" py="2px" borderRadius="999px"
      bg={tokens.colors.accent.greenSubtle} border={`1px solid ${tokens.colors.accent.greenMuted}`}>
      <Box w="5px" h="5px" borderRadius="full" bg={tokens.colors.accent.green} />
      <Text fontSize="9.5px" fontWeight="700" color={tokens.colors.accent.green}>{props.label}</Text>
    </Flex>
  ) : (
    <Flex px="8px" py="2px" borderRadius="999px" bg={tokens.colors.bg.whiteSubtle}>
      <Text fontSize="9.5px" fontWeight="600" color={tokens.colors.text.disabled}>{props.label}</Text>
    </Flex>
  )
}

function AdminSelect(props: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
  width?: string
  flex?: string
}) {
  return (
    <Box flex={props.flex} width={props.width} minW={0}>
      <Text fontSize="9.5px" fontWeight="700" letterSpacing="0.06em" textTransform="uppercase"
        color={tokens.colors.text.disabled} mb="4px">
        {props.label}
      </Text>
      <NativeSelect.Root size="sm">
        <NativeSelect.Field
          bg={tokens.colors.bg.input}
          borderColor={tokens.colors.border.input}
          borderRadius="8px"
          color={tokens.colors.text.primary}
          fontSize="12px"
          h="32px"
          transition={`border-color ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`}
          _hover={{ borderColor: tokens.colors.accent.primaryMuted }}
          _focus={{ borderColor: tokens.colors.accent.primary, boxShadow: `0 0 0 1px ${tokens.colors.accent.primaryMuted}` }}
          value={props.value}
          onChange={function (e) { props.onChange(e.target.value) }}
        >
          {props.children}
        </NativeSelect.Field>
        <NativeSelect.Indicator color={tokens.colors.text.disabled} />
      </NativeSelect.Root>
    </Box>
  )
}

const SIDECAR_SLOTS: Array<{ type: import('../../../services/adminService').SidecarType; label: string; desc: string }> = [
  { type: 'vision', label: 'Visão (imagens)', desc: 'Descreve imagens para modelos sem visão (GLM)' },
  { type: 'web_search', label: 'Web Search', desc: 'Pesquisa web para modelos sem busca nativa' },
  { type: 'utility', label: 'Utility (memória)', desc: 'Memória, sumarização e títulos (memory-*, summarize). Desligar → usa o modelo ativo.' },
  { type: 'fim', label: 'FIM (autocomplete)', desc: 'Code completion inline (X-Request-Type: fim)' },
  { type: 'image', label: 'Imagem (geração)', desc: 'Gera imagens (X-Request-Type: image). Ainda não usado pelo agente.' },
]

function SidecarsPanel({ refreshKey }: { refreshKey?: number }) {
  const t = useTranslation()
  const [data, setData] = useState<import('../../../services/adminService').SidecarsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<Record<string, string>>({})

  const load = useCallback(async function () {
    setLoading(true)
    setError(null)
    try {
      const { fetchSidecars } = await import('../../../services/adminService')
      const d = await fetchSidecars()
      setData(d)
      const next: Record<string, string> = {}
      for (const slot of SIDECAR_SLOTS) {
        const cur = d.current[`sidecar:${slot.type}`]
        const match = cur
          ? d.catalog.find(m =>
              m.activeConfig.model === cur.model && m.activeConfig.provider === cur.provider)
          : undefined
        next[slot.type] = match?.id ?? ''
      }
      setSel(next)
    } catch (err) {
      setError(err instanceof Error && err.message === 'FORBIDDEN' ? t('admin.forbidden') : (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [t])
  useEffect(function () { load() }, [load, refreshKey])

  async function apply(type: import('../../../services/adminService').SidecarType, action: 'publish' | 'disable') {
    setBusy(type)
    setError(null)
    try {
      const svc = await import('../../../services/adminService')
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
    <Box>
      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} mb="4px">
        {t('admin.sidecars.title')}
      </Text>
      <Text fontSize="11px" color={tokens.colors.text.muted} mb={4} lineHeight="1.45">
        {t('admin.sidecars.desc')}
      </Text>

      {loading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.loading')}</Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {SIDECAR_SLOTS.map(function (slot) {
            const cur = data?.current[`sidecar:${slot.type}`] ?? null
            const published = !!cur && cur.enabled
            const eligible = (data?.catalog ?? []).filter(m => m.roles.includes(slot.type))
            const selModel = (data?.catalog ?? []).find(m => m.id === sel[slot.type])
            const isCurrent = published && !!selModel
              && selModel.activeConfig.model === cur!.model
              && selModel.activeConfig.provider === cur!.provider
            const canPublish = !!sel[slot.type] && !isCurrent && busy === null
            return (
              <Box
                key={slot.type}
                p={3}
                borderRadius={tokens.radius.lg}
                bg={tokens.colors.bg.card}
                border="1px solid"
                borderColor={published ? tokens.colors.bg.cardBorder : tokens.colors.border.panel}
              >
                <Flex justify="space-between" align="flex-start" mb={2} gap={2}>
                  <Box minW={0}>
                    <Flex align="center" gap={2}>
                      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>{slot.label}</Text>
                      <StatusPill live={published} label={published ? t('admin.live') : t('admin.unpublished')} />
                    </Flex>
                    <Text fontSize="10.5px" color={tokens.colors.text.muted} mt="3px">{slot.desc}</Text>
                  </Box>
                  {published && (
                    <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} flexShrink={0}
                      color={tokens.colors.text.secondary}>
                      {cur!.model}
                    </Text>
                  )}
                </Flex>
                <Flex align="flex-end" gap={2} wrap="wrap">
                  <AdminSelect label={t('admin.models.model')} flex="1" value={sel[slot.type] ?? ''}
                    onChange={function (v) { setSel(s => ({ ...s, [slot.type]: v })) }}>
                    <option value="">— {t('admin.chooseModel')} —</option>
                    {eligible.map(m => <option key={m.id} value={m.id}>{m.name} · {m.providerLabel}</option>)}
                  </AdminSelect>
                  <Flex gap="6px" flexShrink={0}>
                    <Button
                      size="sm"
                      h="32px"
                      disabled={!canPublish}
                      onClick={function () { apply(slot.type, 'publish') }}
                      bg={tokens.colors.accent.primary}
                      color="white"
                      borderRadius="8px"
                      _hover={{ bg: tokens.colors.accent.primaryDark }}
                      _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
                    >
                      {busy === slot.type ? '…' : t('admin.publish')}
                    </Button>
                    {published && (
                      <Button
                        size="sm"
                        h="32px"
                        variant="ghost"
                        borderRadius="8px"
                        disabled={busy === slot.type}
                        onClick={function () { apply(slot.type, 'disable') }}
                        color={tokens.colors.text.secondary}
                        _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.bg.hoverSubtle }}
                      >
                        {t('admin.disable')}
                      </Button>
                    )}
                  </Flex>
                </Flex>
              </Box>
            )
          })}
        </VStack>
      )}

      {error && <Text fontSize="11px" color={tokens.colors.accent.red} mt={2}>{error}</Text>}
    </Box>
  )
}

const PERSONA_SLOTS: Array<{ type: import('../../../services/adminService').PersonaType; label: string; desc: string }> = [
  { type: 'standard', label: 'Standard', desc: 'Persona base — o dia-a-dia.' },
  { type: 'expert', label: 'Expert', desc: 'Trabalho complexo — modelo mais forte.' },
  { type: 'master', label: 'Master', desc: 'Capacidade máxima — o topo do catálogo.' },
]

function PersonasPanel({ onPublished, refreshKey }: { onPublished?: () => void; refreshKey?: number }) {
  const t = useTranslation()
  const [data, setData] = useState<import('../../../services/adminService').PersonasResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<Record<string, string>>({})
  const [ctxWin, setCtxWin] = useState<Record<string, string>>({})

  const load = useCallback(async function () {
    setLoading(true)
    setError(null)
    try {
      const { fetchPersonas } = await import('../../../services/adminService')
      const d = await fetchPersonas()
      setData(d)
      const nextSel: Record<string, string> = {}
      const nextCtx: Record<string, string> = {}
      for (const slot of PERSONA_SLOTS) {
        const cur = d.current[`persona:${slot.type}`]
        const match = cur
          ? d.catalog.find(m =>
              m.activeConfig.model === cur.model
              && m.activeConfig.provider === cur.provider
              && m.activeConfig.baseUrl === cur.baseUrl)
          : undefined
        nextSel[slot.type] = match?.id ?? ''
        nextCtx[slot.type] = String(cur?.contextWindow ?? match?.activeConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
      }
      setSel(nextSel)
      setCtxWin(nextCtx)
    } catch (err) {
      setError(err instanceof Error && err.message === 'FORBIDDEN' ? t('admin.forbidden') : (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [t])
  useEffect(function () { load() }, [load, refreshKey])

  function pickModel(type: string, id: string) {
    setSel(s => ({ ...s, [type]: id }))
    const preset = data?.catalog.find(m => m.id === id)?.activeConfig.contextWindow
    if (preset) setCtxWin(s => ({ ...s, [type]: String(preset) }))
  }

  async function apply(type: import('../../../services/adminService').PersonaType, action: 'publish' | 'disable') {
    setBusy(type)
    setError(null)
    try {
      const svc = await import('../../../services/adminService')
      if (action === 'disable') {
        await svc.disablePersona(type)
      } else if (sel[type]) {
        await svc.setPersona(type, sel[type], Number(ctxWin[type]) || undefined)
      }
      await load()
      onPublished?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Box>
      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} mb="4px">
        {t('admin.personas.title')}
      </Text>
      <Text fontSize="11px" color={tokens.colors.text.muted} mb={4} lineHeight="1.45">
        {t('admin.personas.desc')}
      </Text>

      {loading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.loading')}</Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {PERSONA_SLOTS.map(function (slot) {
            const cur = data?.current[`persona:${slot.type}`] ?? null
            const published = !!cur && cur.enabled
            const selModel = (data?.catalog ?? []).find(m => m.id === sel[slot.type])
            const isCurrent = published && !!selModel
              && selModel.activeConfig.model === cur!.model
              && selModel.activeConfig.provider === cur!.provider
              && String(cur!.contextWindow ?? '') === (ctxWin[slot.type] || '')
            const canPublish = !!sel[slot.type] && !isCurrent && busy === null
            return (
              <Box
                key={slot.type}
                p="14px"
                borderRadius={tokens.radius.lg}
                bg={tokens.colors.bg.card}
                border="1px solid"
                borderColor={published ? tokens.colors.bg.cardBorder : tokens.colors.border.panel}
                transition={`border-color ${tokens.transition.fast}`}
                _hover={{ borderColor: tokens.colors.accent.primaryMuted }}
              >
                <Flex justify="space-between" align="flex-start" mb="12px" gap={2}>
                  <Box minW={0}>
                    <Flex align="center" gap="8px">
                      <Text fontSize="13px" fontWeight="700" color={tokens.colors.text.primary}>{slot.label}</Text>
                      <StatusPill live={published} label={published ? t('admin.live') : t('admin.unpublished')} />
                    </Flex>
                    <Text fontSize="10.5px" color={tokens.colors.text.muted} mt="2px">{slot.desc}</Text>
                  </Box>
                  {published && (
                    <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} flexShrink={0} textAlign="right"
                      color={tokens.colors.text.secondary}>
                      {cur!.model}
                      <Text as="span" color={tokens.colors.text.disabled}>
                        {' '}· {formatContextWindow(cur!.contextWindow ?? DEFAULT_CONTEXT_WINDOW)}
                      </Text>
                    </Text>
                  )}
                </Flex>

                <Flex align="flex-end" gap="10px" wrap="wrap">
                  <AdminSelect label={t('admin.models.model')} flex="1" value={sel[slot.type] ?? ''}
                    onChange={function (v) { pickModel(slot.type, v) }}>
                    <option value="">— {t('admin.choose')} —</option>
                    {(data?.catalog ?? []).map(m => (
                      <option key={m.id} value={m.id}>{m.name} · {m.providerLabel}</option>
                    ))}
                  </AdminSelect>
                  <AdminSelect label={t('admin.window')} width="96px" value={ctxWin[slot.type] ?? String(DEFAULT_CONTEXT_WINDOW)}
                    onChange={function (v) { setCtxWin(s => ({ ...s, [slot.type]: v })) }}>
                    {CONTEXT_WINDOW_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </AdminSelect>
                  <Flex gap="6px" flexShrink={0}>
                    <Button
                      size="sm"
                      h="32px"
                      disabled={!canPublish}
                      onClick={function () { apply(slot.type, 'publish') }}
                      bg={tokens.colors.accent.primary}
                      color="white"
                      borderRadius="8px"
                      _hover={{ bg: tokens.colors.accent.primaryDark }}
                      _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
                    >
                      {busy === slot.type ? '…' : t('admin.publish')}
                    </Button>
                    {published && (
                      <Button
                        size="sm"
                        h="32px"
                        variant="ghost"
                        borderRadius="8px"
                        disabled={busy === slot.type}
                        onClick={function () { apply(slot.type, 'disable') }}
                        color={tokens.colors.text.secondary}
                        _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.bg.hoverSubtle }}
                      >
                        {t('admin.disable')}
                      </Button>
                    )}
                  </Flex>
                </Flex>
              </Box>
            )
          })}
        </VStack>
      )}

      {error && <Text fontSize="11px" color={tokens.colors.accent.red} mt={2}>{error}</Text>}
    </Box>
  )
}

function LiveSlot(props: {
  title: string
  hint?: string
  config: import('../../../services/adminService').ActiveAIConfig | null | undefined
}) {
  const t = useTranslation()
  const cfg = props.config
  const live = !!cfg && cfg.enabled
  return (
    <Box
      p={3}
      borderRadius={tokens.radius.lg}
      bg={tokens.colors.bg.card}
      border="1px solid"
      borderColor={live ? tokens.colors.bg.cardBorder : tokens.colors.border.panel}
    >
      <Flex justify="space-between" align="center" mb={live ? 2 : 0} gap={2}>
        <Box minW={0}>
          <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>{props.title}</Text>
          {props.hint && (
            <Text fontSize="10.5px" color={tokens.colors.text.muted} mt="2px" lineHeight="1.4">{props.hint}</Text>
          )}
        </Box>
        <StatusPill live={live} label={live ? t('admin.live') : t('admin.unpublished')} />
      </Flex>
      {live && cfg && (
        <VStack align="stretch" gap={0.5}>
          <Text fontSize="12px" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
            {cfg.provider} / {cfg.model}
          </Text>
          <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
            {cfg.baseUrl}{cfg.chatCompletionsPath}
          </Text>
          <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
            {t('admin.window')} · {cfg.contextWindow ? formatContextWindow(cfg.contextWindow) : '—'}
          </Text>
        </VStack>
      )}
    </Box>
  )
}

function LivePanel(props: {
  verify: import('../../../services/adminService').VerifyResponse | null
  isVerifying: boolean
  onRefresh: () => void
  refreshKey: number
}) {
  const t = useTranslation()
  const [personas, setPersonas] = useState<import('../../../services/adminService').PersonasResponse | null>(null)
  const [sidecars, setSidecars] = useState<import('../../../services/adminService').SidecarsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const loadSlots = useCallback(async function () {
    setLoading(true)
    try {
      const svc = await import('../../../services/adminService')
      const [p, s] = await Promise.all([svc.fetchPersonas(), svc.fetchSidecars()])
      setPersonas(p)
      setSidecars(s)
    } catch {
      setPersonas(null)
      setSidecars(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(function () { loadSlots() }, [loadSlots, props.refreshKey])

  async function refreshAll() {
    await Promise.all([props.onRefresh(), loadSlots()])
  }

  const busy = props.isVerifying || loading
  const fallback = props.verify?.activeAIConfig

  return (
    <Box>
      <Flex align="flex-start" justify="space-between" gap={3} mb={4}>
        <Box minW={0}>
          <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>{t('admin.verifyTitle')}</Text>
          <Text fontSize="11px" color={tokens.colors.text.muted} mt="3px" lineHeight="1.45">{t('admin.verifyDesc')}</Text>
        </Box>
        <Button
          size="sm"
          h="30px"
          variant="ghost"
          disabled={busy}
          onClick={refreshAll}
          color={tokens.colors.text.secondary}
          _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
          _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
        >
          <FiRefreshCw size={12} />
          {busy ? t('admin.verifyChecking') : t('admin.verifyRefresh')}
        </Button>
      </Flex>

      {busy && !personas && !sidecars && !fallback ? (
        <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.verifyChecking')}</Text>
      ) : (
        <VStack align="stretch" gap={5}>
          <VStack align="stretch" gap={2}>
            <Text fontSize="11px" fontWeight="700" letterSpacing="0.05em" textTransform="uppercase"
              color={tokens.colors.text.disabled}>
              {t('admin.personas.title')}
            </Text>
            {PERSONA_SLOTS.map(function (slot) {
              return (
                <LiveSlot
                  key={slot.type}
                  title={slot.label}
                  hint={slot.desc}
                  config={personas?.current[`persona:${slot.type}`]}
                />
              )
            })}
          </VStack>

          <VStack align="stretch" gap={2}>
            <Text fontSize="11px" fontWeight="700" letterSpacing="0.05em" textTransform="uppercase"
              color={tokens.colors.text.disabled}>
              {t('admin.sidecars.title')}
            </Text>
            {SIDECAR_SLOTS.map(function (slot) {
              return (
                <LiveSlot
                  key={slot.type}
                  title={slot.label}
                  hint={slot.desc}
                  config={sidecars?.current[`sidecar:${slot.type}`]}
                />
              )
            })}
          </VStack>

          <VStack align="stretch" gap={2}>
            <Text fontSize="11px" fontWeight="700" letterSpacing="0.05em" textTransform="uppercase"
              color={tokens.colors.text.disabled}>
              {t('admin.fallbackTitle')}
            </Text>
            <LiveSlot
              title={t('admin.fallbackTitle')}
              hint={t('admin.fallbackHint')}
              config={fallback}
            />
          </VStack>
        </VStack>
      )}
    </Box>
  )
}

export default function AdminSection() {
  const t = useTranslation()
  const [isLoading, setIsLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verify, setVerify] = useState<import('../../../services/adminService').VerifyResponse | null>(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [catalogEpoch, setCatalogEpoch] = useState(0)
  const [tab, setTab] = useState<AdminTab>('personas')

  const load = useCallback(async function () {
    setIsLoading(true)
    setError(null)
    try {
      const { fetchAdminVerify } = await import('../../../services/adminService')
      setVerify(await fetchAdminVerify())
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
      const { fetchAdminVerify } = await import('../../../services/adminService')
      setVerify(await fetchAdminVerify())
    } catch (err) {
      if (err instanceof Error && err.message === 'FORBIDDEN') setForbidden(true)
    } finally {
      setIsVerifying(false)
    }
  }, [])

  useEffect(function () { load() }, [load])

  if (forbidden) {
    return <Text fontSize="13px" color={tokens.colors.accent.red}>{t('admin.forbidden')}</Text>
  }
  if (isLoading) {
    return <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.loading')}</Text>
  }

  return (
    <VStack align="stretch" gap={5}>
      <Text fontSize="12px" color={tokens.colors.text.muted} lineHeight="1.5">{t('admin.subtitle')}</Text>

      {error && (
        <Box p={3} borderRadius={tokens.radius.lg} bg={tokens.colors.accent.redSubtle}
          border="1px solid" borderColor={tokens.colors.accent.red}>
          <Text fontSize="12px" color={tokens.colors.accent.red}>{error}</Text>
        </Box>
      )}

      <Flex
        p="3px"
        bg={tokens.colors.bg.card}
        border="1px solid"
        borderColor={tokens.colors.bg.cardBorder}
        borderRadius="10px"
        gap="2px"
      >
        {TABS.map(function (item) {
          const active = tab === item.id
          return (
            <Box
              key={item.id}
              as="button"
              flex="1"
              py="6px"
              px="8px"
              borderRadius="8px"
              fontSize="12px"
              fontWeight={active ? 600 : 500}
              color={active ? tokens.colors.text.primary : tokens.colors.text.muted}
              bg={active ? tokens.colors.bg.activeItem : 'transparent'}
              cursor="pointer"
              transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}`}
              _hover={{ color: tokens.colors.text.primary, bg: active ? tokens.colors.bg.activeItem : tokens.colors.bg.hoverSubtle }}
              onClick={function () { setTab(item.id) }}
            >
              {t(item.key)}
            </Box>
          )
        })}
      </Flex>

      {tab === 'personas' && (
        <PersonasPanel refreshKey={catalogEpoch} onPublished={refreshVerify} />
      )}
      {tab === 'sidecars' && (
        <SidecarsPanel refreshKey={catalogEpoch} />
      )}
      {tab === 'catalog' && (
        <ModelsPanel onCatalogChanged={function () { setCatalogEpoch((n) => n + 1) }} />
      )}
      {tab === 'live' && (
        <LivePanel verify={verify} isVerifying={isVerifying} onRefresh={refreshVerify} refreshKey={catalogEpoch} />
      )}
    </VStack>
  )
}
