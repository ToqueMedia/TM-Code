import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Flex, NativeSelect, Text, VStack } from '@chakra-ui/react'
import { FiRefreshCw } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import ModelsPanel from './ModelsPanel'
import { readAdminCache, writeAdminCache, ADMIN_CACHE_KEYS } from '@/services/adminCache'

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

// ─── Helpers de derivação de state a partir de dados do cache ────────────
// As seleções (sel) e janelas de contexto (ctxWin) são derivadas dos dados
// vindos do servidor. Ao ler do cache local, precisamos de computar esses
// estados derivados da mesma forma — estas funções partilham a lógica entre
// o initializer do useState (cache) e o load (servidor).

function computeSidecarSel(data: import('../../../services/adminService').SidecarsResponse): Record<string, string> {
  const next: Record<string, string> = {}
  for (const slot of SIDECAR_SLOTS) {
    const cur = data.current[`sidecar:${slot.type}`]
    const match = cur
      ? data.catalog.find(m =>
          m.activeConfig.model === cur.model && m.activeConfig.provider === cur.provider)
      : undefined
    next[slot.type] = match?.id ?? ''
  }
  return next
}

function computePersonaState(data: import('../../../services/adminService').PersonasResponse): {
  sel: Record<string, string>
  ctxWin: Record<string, string>
} {
  const sel: Record<string, string> = {}
  const ctxWin: Record<string, string> = {}
  for (const slot of PERSONA_SLOTS) {
    const cur = data.current[`persona:${slot.type}`]
    const match = cur
      ? data.catalog.find(m =>
          m.activeConfig.model === cur.model
          && m.activeConfig.provider === cur.provider
          && m.activeConfig.baseUrl === cur.baseUrl)
      : undefined
    sel[slot.type] = match?.id ?? ''
    ctxWin[slot.type] = String(cur?.contextWindow ?? match?.activeConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
  }
  return { sel, ctxWin }
}

function SidecarsPanel({ refreshKey }: { refreshKey?: number }) {
  const t = useTranslation()
  // Local-first: lê o cache do localStorage uma vez (mount) para renderizar
  // imediatamente. O refresh do servidor corre em background e actualiza o
  // cache ao terminar.
  const [cachedData] = useState(() => readAdminCache<import('../../../services/adminService').SidecarsResponse>(ADMIN_CACHE_KEYS.sidecars))
  const [data, setData] = useState<import('../../../services/adminService').SidecarsResponse | null>(cachedData)
  const hasCache = cachedData !== null
  const [loading, setLoading] = useState(!hasCache)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<Record<string, string>>(() => cachedData ? computeSidecarSel(cachedData) : {})

  const load = useCallback(async function () {
    if (!hasCache) setLoading(true)
    setError(null)
    try {
      const { fetchSidecars } = await import('../../../services/adminService')
      const d = await fetchSidecars()
      setData(d)
      writeAdminCache(ADMIN_CACHE_KEYS.sidecars, d)
      setSel(computeSidecarSel(d))
    } catch (err) {
      if (!hasCache) {
        setError(err instanceof Error && err.message === 'FORBIDDEN' ? t('admin.forbidden') : (err instanceof Error ? err.message : String(err)))
      }
    } finally {
      setLoading(false)
    }
  }, [t, hasCache])
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
  { type: 'tm', label: 'TM', desc: 'Slot exclusivo do plano Toque Media — não publicar até o deny estar em prod.' },
]

function PersonasPanel({ onPublished, refreshKey }: { onPublished?: () => void; refreshKey?: number }) {
  const t = useTranslation()
  // Local-first: lê o cache do localStorage uma vez (mount) para renderizar
  // imediatamente. O refresh do servidor corre em background e actualiza o
  // cache ao terminar.
  const [cachedData] = useState(() => readAdminCache<import('../../../services/adminService').PersonasResponse>(ADMIN_CACHE_KEYS.personas))
  const [data, setData] = useState<import('../../../services/adminService').PersonasResponse | null>(cachedData)
  const hasCache = cachedData !== null
  const [loading, setLoading] = useState(!hasCache)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<Record<string, string>>(() => {
    if (!cachedData) return {}
    return computePersonaState(cachedData).sel
  })
  const [ctxWin, setCtxWin] = useState<Record<string, string>>(() => {
    if (!cachedData) return {}
    return computePersonaState(cachedData).ctxWin
  })

  const load = useCallback(async function () {
    if (!hasCache) setLoading(true)
    setError(null)
    try {
      const { fetchPersonas } = await import('../../../services/adminService')
      const d = await fetchPersonas()
      setData(d)
      writeAdminCache(ADMIN_CACHE_KEYS.personas, d)
      const derived = computePersonaState(d)
      setSel(derived.sel)
      setCtxWin(derived.ctxWin)
    } catch (err) {
      if (!hasCache) {
        setError(err instanceof Error && err.message === 'FORBIDDEN' ? t('admin.forbidden') : (err instanceof Error ? err.message : String(err)))
      }
    } finally {
      setLoading(false)
    }
  }, [t, hasCache])
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
  // Local-first: personas e sidecars são lidos do cache no mount para o
  // Live tab renderizar imediatamente. O verify vem do parent (já cached).
  const [cachedPersonas] = useState(() => readAdminCache<import('../../../services/adminService').PersonasResponse>(ADMIN_CACHE_KEYS.personas))
  const [cachedSidecars] = useState(() => readAdminCache<import('../../../services/adminService').SidecarsResponse>(ADMIN_CACHE_KEYS.sidecars))
  const [personas, setPersonas] = useState<import('../../../services/adminService').PersonasResponse | null>(cachedPersonas)
  const [sidecars, setSidecars] = useState<import('../../../services/adminService').SidecarsResponse | null>(cachedSidecars)
  const hasCache = cachedPersonas !== null || cachedSidecars !== null
  const [loading, setLoading] = useState(!hasCache)

  const loadSlots = useCallback(async function () {
    if (!hasCache) setLoading(true)
    try {
      const svc = await import('../../../services/adminService')
      const [p, s] = await Promise.all([svc.fetchPersonas(), svc.fetchSidecars()])
      setPersonas(p)
      setSidecars(s)
      writeAdminCache(ADMIN_CACHE_KEYS.personas, p)
      writeAdminCache(ADMIN_CACHE_KEYS.sidecars, s)
    } catch {
      // Em modo cache, mantemos os dados antigos visíveis.
      if (!hasCache) {
        setPersonas(null)
        setSidecars(null)
      }
    } finally {
      setLoading(false)
    }
  }, [hasCache])

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
  // Local-first: o cache do localStorage é lido SINCRONAMENTE no initializer
  // do useState. Se existir, a UI renderiza instantaneamente (isLoading=false)
  // e o fetch do servidor corre em background para validar/atualizar. Se não
  // existir (primeira visita), mostra "Loading…" normalmente.
  const [verify, setVerify] = useState<import('../../../services/adminService').VerifyResponse | null>(
    () => readAdminCache<import('../../../services/adminService').VerifyResponse>(ADMIN_CACHE_KEYS.verify),
  )
  const hasCache = verify !== null
  const [isLoading, setIsLoading] = useState(!hasCache)
  const [isRefreshing, setIsRefreshing] = useState(hasCache)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalogEpoch, setCatalogEpoch] = useState(0)
  const [tab, setTab] = useState<AdminTab>('personas')

  const load = useCallback(async function () {
    // Se já temos cache, não mostramos "Loading…" — o refresh é em background.
    if (!hasCache) setIsLoading(true)
    else setIsRefreshing(true)
    setError(null)
    try {
      const { fetchAdminVerify } = await import('../../../services/adminService')
      const result = await fetchAdminVerify()
      setVerify(result)
      writeAdminCache(ADMIN_CACHE_KEYS.verify, result)
    } catch (err) {
      if (err instanceof Error && err.message === 'FORBIDDEN') {
        setForbidden(true)
      } else {
        // Em modo cache, não sobrepomos os dados do cache com o erro —
        // o utilizador mantém os dados antigos visíveis e vê o erro como
        // aviso secundário.
        if (!hasCache) setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [hasCache])

  const refreshVerify = useCallback(async function () {
    setIsRefreshing(true)
    try {
      const { fetchAdminVerify } = await import('../../../services/adminService')
      const result = await fetchAdminVerify()
      setVerify(result)
      writeAdminCache(ADMIN_CACHE_KEYS.verify, result)
    } catch (err) {
      if (err instanceof Error && err.message === 'FORBIDDEN') setForbidden(true)
    } finally {
      setIsRefreshing(false)
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
      <Flex align="center" justify="space-between" gap={3}>
        <Text fontSize="12px" color={tokens.colors.text.muted} lineHeight="1.5">{t('admin.subtitle')}</Text>
        {isRefreshing && (
          <Flex align="center" gap="4px" flexShrink={0}>
            <Box
              w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.primary}
              css={{
                '@keyframes tmAdminRefreshPulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.3 } },
                animation: 'tmAdminRefreshPulse 1s ease-in-out infinite',
              }}
            />
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontWeight="600">
              {t('admin.refreshing')}
            </Text>
          </Flex>
        )}
      </Flex>

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
        <LivePanel verify={verify} isVerifying={isRefreshing} onRefresh={refreshVerify} refreshKey={catalogEpoch} />
      )}
    </VStack>
  )
}
