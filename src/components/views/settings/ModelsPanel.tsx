import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Input,
  NativeSelect,
  Portal,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { FiPlus, FiTrash2 } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { readAdminCache, writeAdminCache, ADMIN_CACHE_KEYS } from '@/services/adminCache'
import type {
  ActiveAIConfig,
  ActiveAIConfigInput,
  AdminModel,
  AdminModelInput,
  PersonaType,
  PersonasResponse,
  SidecarModel,
  SidecarModelInput,
  SidecarsResponse,
  SidecarType,
} from '../../../services/adminService'

const PERSONA_TYPES: PersonaType[] = ['standard', 'expert', 'master', 'tm']
const SIDECAR_ROLES: SidecarType[] = ['vision', 'web_search', 'utility', 'fim', 'image']

function slotsUsingEntry(
  entry: AdminModel | SidecarModel,
  personas: PersonasResponse | null,
  sidecars: SidecarsResponse | null,
): string[] {
  const labels: string[] = []
  const cfg = entry.activeConfig
  if (personas) {
    for (const type of PERSONA_TYPES) {
      const cur = personas.current[`persona:${type}`]
      if (cur && cur.enabled && sameServingTarget(cur, cfg)) labels.push(type)
    }
  }
  if (sidecars) {
    for (const type of SIDECAR_ROLES) {
      const cur = sidecars.current[`sidecar:${type}`]
      if (cur && cur.enabled && cur.provider === cfg.provider && cur.model === cfg.model) {
        labels.push(type)
      }
    }
  }
  return labels
}

function sameServingTarget(cur: ActiveAIConfig, cfg: ActiveAIConfigInput): boolean {
  return cur.provider === cfg.provider && cur.model === cfg.model && cur.baseUrl === cfg.baseUrl
}

const CONTEXT_WINDOW_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '128k', value: 131_072 },
  { label: '200k', value: 200_000 },
  { label: '256k', value: 262_144 },
  { label: '512k', value: 524_288 },
  { label: '768k', value: 786_432 },
  { label: '1M', value: 1_000_000 },
  { label: '2M', value: 2_000_000 },
]

const THINKING_PARAMS = ['reasoning_effort', 'enable_thinking', 'thinking_object'] as const
const THINKING_MODES = ['', 'toggleable', 'mandatory', 'none'] as const
const AUTH_SCHEMES = ['Bearer', 'none', 'google_oauth'] as const

type CatalogKind = 'coder' | 'sidecar'

type FormState = {
  id: string
  name: string
  providerLabel: string
  provider: string
  model: string
  speedModel: string
  baseUrl: string
  chatCompletionsPath: string
  authHeader: string
  authScheme: 'Bearer' | 'none' | 'google_oauth'
  apiKeyEnv: string
  contextWindow: string
  maxOutputTokens: string
  supportsVision: boolean
  supportsSearch: boolean
  thinkingMode: string
  thinkingParam: string
  thinkingOptions: string
  thinkingDefault: string
  extraBody: string
  roles: SidecarType[]
  imageOutput1k: string
  imageOutput2k: string
  imageInput: string
}

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  providerLabel: '',
  provider: 'dashscope',
  model: '',
  speedModel: '',
  baseUrl: 'https://',
  chatCompletionsPath: '/chat/completions',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  contextWindow: String(200_000),
  maxOutputTokens: '',
  supportsVision: false,
  supportsSearch: false,
  thinkingMode: '',
  thinkingParam: '',
  thinkingOptions: '',
  thinkingDefault: '',
  extraBody: '',
  roles: [],
  imageOutput1k: '',
  imageOutput2k: '',
  imageInput: '',
}

const fieldStyles = {
  bg: tokens.colors.bg.input,
  borderColor: tokens.colors.border.input,
  borderRadius: '8px',
  fontSize: '12px',
  color: tokens.colors.text.primary,
  h: '32px',
  _hover: { borderColor: tokens.colors.accent.primaryMuted },
  _focus: { borderColor: tokens.colors.accent.primary, boxShadow: `0 0 0 1px ${tokens.colors.accent.primaryMuted}` },
} as const

function entryToForm(entry: AdminModel | SidecarModel): FormState {
  const cfg = entry.activeConfig
  return {
    id: entry.id,
    name: entry.name,
    providerLabel: entry.providerLabel,
    provider: cfg.provider,
    model: cfg.model,
    speedModel: cfg.speedModel ?? '',
    baseUrl: cfg.baseUrl,
    chatCompletionsPath: cfg.chatCompletionsPath,
    authHeader: cfg.authHeader,
    authScheme: cfg.authScheme,
    apiKeyEnv: cfg.apiKeyEnv,
    contextWindow: cfg.contextWindow ? String(cfg.contextWindow) : '',
    maxOutputTokens: cfg.maxOutputTokens != null ? String(cfg.maxOutputTokens) : '',
    supportsVision: !!cfg.supportsVision,
    supportsSearch: !!cfg.supportsSearch,
    thinkingMode: cfg.thinkingMode ?? '',
    thinkingParam: cfg.thinking?.param ?? '',
    thinkingOptions: cfg.thinking?.options.join(', ') ?? '',
    thinkingDefault: cfg.thinking?.default ?? '',
    extraBody: cfg.extraBody ? JSON.stringify(cfg.extraBody, null, 2) : '',
    roles: 'roles' in entry ? [...entry.roles] : [],
    imageOutput1k: cfg.imagePricing?.output1k != null ? String(cfg.imagePricing.output1k) : '',
    imageOutput2k: cfg.imagePricing?.output2k != null ? String(cfg.imagePricing.output2k) : '',
    imageInput: cfg.imagePricing?.input != null ? String(cfg.imagePricing.input) : '',
  }
}

function buildActiveConfig(form: FormState): ActiveAIConfigInput {
  let extraBody: Record<string, unknown> | undefined
  if (form.extraBody.trim()) {
    const parsed = JSON.parse(form.extraBody) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('extraBody must be a JSON object')
    }
    extraBody = parsed as Record<string, unknown>
  }
  const options = form.thinkingOptions.split(',').map((s) => s.trim()).filter(Boolean)
  const thinking = form.thinkingParam && options.length > 0
    ? {
        param: form.thinkingParam as NonNullable<ActiveAIConfigInput['thinking']>['param'],
        options,
        default: form.thinkingDefault || options[0],
      }
    : undefined
  const pickPrice = (raw: string): number | undefined => {
    const n = Number(raw)
    return raw.trim() && Number.isFinite(n) && n > 0 ? n : undefined
  }
  const imagePricing = {
    output1k: pickPrice(form.imageOutput1k),
    output2k: pickPrice(form.imageOutput2k),
    input: pickPrice(form.imageInput),
  }
  const hasPricing = imagePricing.output1k != null || imagePricing.output2k != null || imagePricing.input != null
  const maxOut = Number(form.maxOutputTokens)
  return {
    provider: form.provider.trim(),
    model: form.model.trim(),
    baseUrl: form.baseUrl.trim(),
    chatCompletionsPath: form.chatCompletionsPath.trim(),
    authHeader: form.authHeader.trim() || 'Authorization',
    authScheme: form.authScheme,
    apiKeyEnv: form.apiKeyEnv.trim(),
    enabled: true,
    ...(form.speedModel.trim() ? { speedModel: form.speedModel.trim() } : {}),
    ...(form.contextWindow ? { contextWindow: Number(form.contextWindow) } : {}),
    ...(Number.isFinite(maxOut) && maxOut > 0 ? { maxOutputTokens: Math.floor(maxOut) } : {}),
    supportsVision: form.supportsVision,
    supportsSearch: form.supportsSearch,
    ...(form.thinkingMode ? { thinkingMode: form.thinkingMode as NonNullable<ActiveAIConfigInput['thinkingMode']> } : {}),
    ...(thinking ? { thinking } : {}),
    ...(extraBody ? { extraBody } : {}),
    ...(hasPricing ? { imagePricing } : {}),
  }
}

function FieldLabel(props: { children: React.ReactNode }) {
  return (
    <Text fontSize="9.5px" fontWeight="700" letterSpacing="0.06em" textTransform="uppercase"
      color={tokens.colors.text.disabled} mb="5px">
      {props.children}
    </Text>
  )
}

function FormSection(props: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text fontSize="11px" fontWeight="700" color={tokens.colors.text.secondary} mb={2}
        letterSpacing="0.04em" textTransform="uppercase">
        {props.title}
      </Text>
      <VStack align="stretch" gap={2.5}>{props.children}</VStack>
    </Box>
  )
}

function TextField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
  flex?: string
}) {
  return (
    <Box flex={props.flex} minW={0}>
      <FieldLabel>{props.label}</FieldLabel>
      <Input
        size="sm"
        value={props.value}
        placeholder={props.placeholder}
        onChange={function (e) { props.onChange(e.target.value) }}
        fontFamily={props.mono ? tokens.fontFamily.mono : undefined}
        {...fieldStyles}
      />
    </Box>
  )
}

function SelectField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
  flex?: string
}) {
  return (
    <Box flex={props.flex} minW={0}>
      <FieldLabel>{props.label}</FieldLabel>
      <NativeSelect.Root size="sm">
        <NativeSelect.Field {...fieldStyles} value={props.value}
          onChange={function (e) { props.onChange(e.target.value) }}>
          {props.children}
        </NativeSelect.Field>
        <NativeSelect.Indicator color={tokens.colors.text.disabled} />
      </NativeSelect.Root>
    </Box>
  )
}

function Chip(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Box
      as="button"
      px="8px"
      py="3px"
      borderRadius={tokens.radius.full}
      fontSize="10px"
      fontFamily={tokens.fontFamily.mono}
      cursor="pointer"
      border="1px solid"
      borderColor={props.active ? tokens.colors.accent.primary : tokens.colors.border.input}
      bg={props.active ? tokens.colors.accent.primarySubtle : tokens.colors.bg.input}
      color={props.active ? tokens.colors.text.primary : tokens.colors.text.muted}
      onClick={props.onClick}
    >
      {props.label}
    </Box>
  )
}

function ModelFormFields(props: {
  kind: CatalogKind
  form: FormState
  setForm: (next: FormState) => void
}) {
  const t = useTranslation()
  const { form, setForm } = props
  const patch = (partial: Partial<FormState>) => setForm({ ...form, ...partial })
  const showImagePricing = props.kind === 'sidecar' && form.roles.includes('image')

  return (
    <VStack align="stretch" gap={5}>
      <FormSection title={t('admin.models.sectionIdentity')}>
        <Flex gap={2} wrap="wrap">
          <TextField label={t('admin.models.id')} value={form.id} mono
            onChange={function (v) { patch({ id: v }) }} flex="1" />
          <TextField label={t('admin.models.name')} value={form.name}
            onChange={function (v) { patch({ name: v }) }} flex="1" />
          <TextField label={t('admin.models.providerLabel')} value={form.providerLabel}
            onChange={function (v) { patch({ providerLabel: v }) }} flex="1" />
        </Flex>
      </FormSection>

      <FormSection title={t('admin.models.sectionEndpoint')}>
        <Flex gap={2} wrap="wrap">
          <TextField label={t('admin.models.provider')} value={form.provider} mono
            onChange={function (v) { patch({ provider: v }) }} flex="1" />
          <TextField label={t('admin.models.model')} value={form.model} mono
            onChange={function (v) { patch({ model: v }) }} flex="1" />
          <TextField label={t('admin.models.speedModel')} value={form.speedModel} mono
            onChange={function (v) { patch({ speedModel: v }) }} flex="1" />
        </Flex>
        <TextField label={t('admin.models.baseUrl')} value={form.baseUrl} mono
          onChange={function (v) { patch({ baseUrl: v }) }} />
        <Flex gap={2} wrap="wrap">
          <TextField label={t('admin.models.chatPath')} value={form.chatCompletionsPath} mono
            onChange={function (v) { patch({ chatCompletionsPath: v }) }} flex="1" />
          <TextField label={t('admin.models.authHeader')} value={form.authHeader} mono
            onChange={function (v) { patch({ authHeader: v }) }} flex="1" />
          <SelectField label={t('admin.models.authScheme')} value={form.authScheme} flex="1"
            onChange={function (v) { patch({ authScheme: v as FormState['authScheme'] }) }}>
            {AUTH_SCHEMES.map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
        </Flex>
        <Box>
          <TextField label={t('admin.models.apiKeyEnv')} value={form.apiKeyEnv} mono
            onChange={function (v) { patch({ apiKeyEnv: v }) }} />
          <Text fontSize="10px" color={tokens.colors.text.disabled} mt={1} lineHeight="1.4">
            {t('admin.models.apiKeyEnvHint')}
          </Text>
        </Box>
      </FormSection>

      <FormSection title={t('admin.models.sectionCapabilities')}>
        <Flex gap={2} wrap="wrap">
          <SelectField label={t('admin.models.contextWindow')} value={form.contextWindow} flex="1"
            onChange={function (v) { patch({ contextWindow: v }) }}>
            <option value="">—</option>
            {CONTEXT_WINDOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </SelectField>
          <TextField label={t('admin.models.maxOutput')} value={form.maxOutputTokens} mono
            onChange={function (v) { patch({ maxOutputTokens: v }) }} flex="1" />
          <SelectField label={t('admin.models.thinkingMode')} value={form.thinkingMode} flex="1"
            onChange={function (v) { patch({ thinkingMode: v }) }}>
            {THINKING_MODES.map((s) => <option key={s || 'none-unset'} value={s}>{s || '—'}</option>)}
          </SelectField>
        </Flex>
        <HStack gap={1.5} wrap="wrap">
          <Chip label={t('admin.models.supportsVision')} active={form.supportsVision}
            onClick={function () { patch({ supportsVision: !form.supportsVision }) }} />
          <Chip label={t('admin.models.supportsSearch')} active={form.supportsSearch}
            onClick={function () { patch({ supportsSearch: !form.supportsSearch }) }} />
        </HStack>
      </FormSection>

      <FormSection title={t('admin.models.sectionThinking')}>
        <Flex gap={2} wrap="wrap">
          <SelectField label={t('admin.models.thinkingParam')} value={form.thinkingParam} flex="1"
            onChange={function (v) { patch({ thinkingParam: v }) }}>
            <option value="">—</option>
            {THINKING_PARAMS.map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
          <TextField label={t('admin.models.thinkingOptions')} value={form.thinkingOptions} mono
            onChange={function (v) { patch({ thinkingOptions: v }) }} flex="1" />
          <TextField label={t('admin.models.thinkingDefault')} value={form.thinkingDefault} mono
            onChange={function (v) { patch({ thinkingDefault: v }) }} flex="1" />
        </Flex>
        <Box>
          <FieldLabel>{t('admin.models.extraBody')}</FieldLabel>
          <Textarea
            value={form.extraBody}
            onChange={function (e) { patch({ extraBody: e.target.value }) }}
            rows={4}
            fontFamily={tokens.fontFamily.mono}
            fontSize="11px"
            bg={tokens.colors.bg.input}
            borderColor={tokens.colors.border.input}
            borderRadius="8px"
            color={tokens.colors.text.primary}
          />
        </Box>
      </FormSection>

      {props.kind === 'sidecar' && (
        <Box>
          <FieldLabel>{t('admin.models.roles')}</FieldLabel>
          <HStack gap={1} wrap="wrap">
            {SIDECAR_ROLES.map((role) => (
              <Chip
                key={role}
                label={role}
                active={form.roles.includes(role)}
                onClick={function () {
                  patch({
                    roles: form.roles.includes(role)
                      ? form.roles.filter((r) => r !== role)
                      : [...form.roles, role],
                  })
                }}
              />
            ))}
          </HStack>
        </Box>
      )}

      {showImagePricing && (
        <Box>
          <FieldLabel>{t('admin.models.imagePricing')}</FieldLabel>
          <Flex gap={2} wrap="wrap">
            <TextField label={t('admin.models.imageOutput1k')} value={form.imageOutput1k} mono
              onChange={function (v) { patch({ imageOutput1k: v }) }} flex="1" />
            <TextField label={t('admin.models.imageOutput2k')} value={form.imageOutput2k} mono
              onChange={function (v) { patch({ imageOutput2k: v }) }} flex="1" />
            <TextField label={t('admin.models.imageInput')} value={form.imageInput} mono
              onChange={function (v) { patch({ imageInput: v }) }} flex="1" />
          </Flex>
        </Box>
      )}
    </VStack>
  )
}

function CatalogList(props: {
  models: Array<AdminModel | SidecarModel>
  usedBy: Record<string, string[]>
  onEdit: (entry: AdminModel | SidecarModel) => void
  onDelete: (entry: AdminModel | SidecarModel) => void
  busy: boolean
}) {
  const t = useTranslation()
  if (props.models.length === 0) {
    return (
      <Box py={8} px={4} textAlign="center" borderRadius={tokens.radius.lg}
        border="1px dashed" borderColor={tokens.colors.border.panel}
        bg={tokens.colors.bg.card}>
        <Text fontSize="13px" color={tokens.colors.text.primary} mb={1}>{t('admin.models.empty')}</Text>
        <Text fontSize="11px" color={tokens.colors.text.muted}>{t('admin.models.emptyHint')}</Text>
      </Box>
    )
  }
  return (
    <VStack align="stretch" gap="6px">
      {props.models.map(function (entry) {
        const roles = 'roles' in entry ? entry.roles : []
        const serving = props.usedBy[entry.id] ?? []
        const caps: string[] = []
        if (entry.activeConfig.supportsVision) caps.push('vision')
        if (entry.activeConfig.supportsSearch) caps.push('search')
        const window = entry.activeConfig.contextWindow
        const windowLabel = window
          ? (CONTEXT_WINDOW_OPTIONS.find((o) => o.value === window)?.label ?? `${Math.round(window / 1000)}k`)
          : null
        return (
          <Flex
            key={entry.id}
            align="center"
            gap={3}
            px={3}
            py="10px"
            borderRadius={tokens.radius.lg}
            bg={tokens.colors.bg.card}
            border="1px solid"
            borderColor={tokens.colors.bg.cardBorder}
            cursor="pointer"
            role="button"
            tabIndex={0}
            transition={`border-color ${tokens.transition.fast}, background ${tokens.transition.fast}`}
            _hover={{ borderColor: tokens.colors.accent.primaryMuted, bg: tokens.colors.bg.hoverSubtle }}
            onClick={function () { props.onEdit(entry) }}
            onKeyDown={function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                props.onEdit(entry)
              }
            }}
          >
            <Box minW={0} flex="1">
              <Flex align="baseline" gap={2} wrap="wrap">
                <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>{entry.name}</Text>
                <Text fontSize="11px" color={tokens.colors.text.muted}>{entry.providerLabel}</Text>
              </Flex>
              <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.disabled} mt="2px" truncate>
                {entry.id} · {entry.activeConfig.provider}/{entry.activeConfig.model}
                {windowLabel ? ` · ${windowLabel}` : ''}
              </Text>
            </Box>
            <HStack gap={1} flexShrink={0} display={{ base: 'none', md: 'flex' }} wrap="wrap" justify="flex-end">
              {serving.length === 0 ? (
                <Text fontSize="9.5px" fontFamily={tokens.fontFamily.mono}
                  px="6px" py="1px" borderRadius={tokens.radius.full}
                  bg={tokens.colors.bg.input} color={tokens.colors.text.disabled}>
                  {t('admin.models.notLive')}
                </Text>
              ) : serving.map((tag) => (
                <Text key={tag} fontSize="9.5px" fontFamily={tokens.fontFamily.mono}
                  px="6px" py="1px" borderRadius={tokens.radius.full}
                  bg={tokens.colors.accent.greenSubtle} color={tokens.colors.accent.green}>
                  {tag}
                </Text>
              ))}
              {[...roles, ...caps].map((tag) => (
                <Text key={tag} fontSize="9.5px" fontFamily={tokens.fontFamily.mono}
                  px="6px" py="1px" borderRadius={tokens.radius.full}
                  bg={tokens.colors.bg.input} color={tokens.colors.text.muted}>
                  {tag}
                </Text>
              ))}
            </HStack>
            <Box
              as="span"
              role="button"
              aria-label={t('admin.models.delete')}
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="28px"
              h="28px"
              flexShrink={0}
              borderRadius={tokens.radius.md}
              color={tokens.colors.text.disabled}
              cursor={props.busy ? 'not-allowed' : 'pointer'}
              opacity={props.busy ? 0.4 : 1}
              onClick={function (e) {
                e.stopPropagation()
                if (!props.busy) props.onDelete(entry)
              }}
              _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.accent.redSubtle }}
            >
              <FiTrash2 size={13} />
            </Box>
          </Flex>
        )
      })}
    </VStack>
  )
}

function CatalogSection(props: {
  kind: CatalogKind
  title: string
  desc: string
  models: Array<AdminModel | SidecarModel>
  usedBy: Record<string, string[]>
  loading: boolean
  error: string | null
  onReload: () => Promise<void>
  onChanged: () => void
}) {
  const t = useTranslation()
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AdminModel | SidecarModel | null>(null)
  const [step, setStep] = useState<'form' | 'assign'>('form')
  const [assignTargets, setAssignTargets] = useState<string[]>([])

  function closeForm() {
    if (busy) return
    setEditing(null)
    setStep('form')
    setAssignTargets([])
    setLocalError(null)
  }

  function startCreate() {
    setEditing('__new__')
    setForm(EMPTY_FORM)
    setStep('form')
    setAssignTargets([])
    setLocalError(null)
  }

  function startEdit(entry: AdminModel | SidecarModel) {
    setEditing(entry.id)
    setForm(entryToForm(entry))
    setStep('form')
    setAssignTargets([])
    setLocalError(null)
  }

  async function save() {
    setBusy(true)
    setLocalError(null)
    try {
      const svc = await import('../../../services/adminService')
      const activeConfig = buildActiveConfig(form)
      const wasCreate = editing === '__new__'
      if (props.kind === 'coder') {
        const entry: AdminModelInput = {
          id: form.id.trim(),
          name: form.name.trim(),
          providerLabel: form.providerLabel.trim(),
          activeConfig,
        }
        if (!wasCreate && editing) await svc.updateModel(editing, entry)
        else await svc.createModel(entry)
      } else {
        const entry: SidecarModelInput = {
          id: form.id.trim(),
          name: form.name.trim(),
          providerLabel: form.providerLabel.trim(),
          roles: form.roles,
          activeConfig,
        }
        if (!wasCreate && editing) await svc.updateSidecarModel(editing, entry)
        else await svc.createSidecarModel(entry)
      }
      await props.onReload()
      props.onChanged()
      if (wasCreate) {
        setEditing(form.id.trim())
        setStep('assign')
        setAssignTargets(props.kind === 'sidecar' ? [...form.roles] : [])
      } else {
        setEditing(null)
        setStep('form')
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function toggleAssign(target: string) {
    setAssignTargets((cur) => cur.includes(target) ? cur.filter((x) => x !== target) : [...cur, target])
  }

  async function publishSelected() {
    if (assignTargets.length === 0) {
      closeForm()
      return
    }
    setBusy(true)
    setLocalError(null)
    try {
      const svc = await import('../../../services/adminService')
      const modelId = form.id.trim()
      const window = form.contextWindow ? Number(form.contextWindow) : undefined
      // Sequencial: dois publishes em paralelo reescreviam o doc com o valor
      // antigo do primeiro (KV eventualmente consistente).
      if (props.kind === 'coder') {
        for (const persona of assignTargets) {
          await svc.setPersona(persona as PersonaType, modelId, window)
        }
      } else {
        for (const type of assignTargets) {
          await svc.setSidecar(type as SidecarType, modelId)
        }
      }
      await props.onReload()
      props.onChanged()
      setEditing(null)
      setStep('form')
      setAssignTargets([])
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    const entry = pendingDelete
    if (!entry) return
    setBusy(true)
    setLocalError(null)
    try {
      const svc = await import('../../../services/adminService')
      if (props.kind === 'coder') await svc.deleteModel(entry.id)
      else await svc.deleteSidecarModel(entry.id)
      if (editing === entry.id) setEditing(null)
      setPendingDelete(null)
      await props.onReload()
      props.onChanged()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
      setPendingDelete(null)
    } finally {
      setBusy(false)
    }
  }

  const isNew = editing === '__new__'

  return (
    <Box>
      <Flex align="flex-start" justify="space-between" gap={3} mb={3}>
        <Box minW={0}>
          <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>{props.title}</Text>
          <Text fontSize="11px" color={tokens.colors.text.muted} mt="3px" lineHeight="1.45">{props.desc}</Text>
        </Box>
        <Button
          size="sm"
          h="30px"
          flexShrink={0}
          onClick={startCreate}
          bg={tokens.colors.accent.primary}
          color="white"
          borderRadius="8px"
          fontSize="12px"
          _hover={{ bg: tokens.colors.accent.primaryDark }}
        >
          <FiPlus size={13} />
          {t('admin.models.add')}
        </Button>
      </Flex>

      {props.loading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted}>{t('admin.loading')}</Text>
      ) : (
        <CatalogList
          models={props.models}
          usedBy={props.usedBy}
          busy={busy}
          onEdit={startEdit}
          onDelete={setPendingDelete}
        />
      )}

      {(props.error || localError) && (
        <Box mt={3} p={2.5} borderRadius={tokens.radius.md}
          bg={tokens.colors.accent.redSubtle} border="1px solid" borderColor={tokens.colors.accent.redMuted}>
          <Text fontSize="11px" color={tokens.colors.accent.red}>{localError || props.error}</Text>
        </Box>
      )}

      <Dialog.Root
        open={editing !== null}
        onOpenChange={function (d) { if (!d.open) closeForm() }}
        scrollBehavior="inside"
      >
        <Portal>
          <Dialog.Backdrop bg={tokens.colors.dialog.backdrop} backdropFilter="blur(8px)" />
          <Dialog.Positioner>
            <Dialog.Content
              bg={tokens.colors.dialog.bg}
              border={`1px solid ${tokens.colors.dialog.border}`}
              borderRadius="16px"
              color={tokens.colors.text.primary}
              maxW="720px"
              w="92%"
              maxH="88vh"
              display="flex"
              flexDirection="column"
            >
              <Dialog.Header pb={2}>
                <Dialog.Title fontSize="16px" fontWeight="600">
                  {step === 'assign'
                    ? t('admin.models.assignTitle')
                    : isNew ? t('admin.models.addTitle') : t('admin.models.editTitle')}
                </Dialog.Title>
                {step === 'assign' ? (
                  <Text fontSize="12px" color={tokens.colors.text.muted} mt={1} lineHeight="1.45">
                    {t('admin.models.assignHint')}
                  </Text>
                ) : !isNew && (
                  <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} mt={1}>
                    {form.id}
                  </Text>
                )}
              </Dialog.Header>
              <Dialog.CloseTrigger asChild>
                <Button
                  position="absolute"
                  top="14px"
                  right="14px"
                  variant="ghost"
                  size="xs"
                  minW="28px"
                  h="28px"
                  color={tokens.colors.text.muted}
                  _hover={{ bg: tokens.colors.accent.redSubtle, color: tokens.colors.accent.red }}
                  aria-label={t('admin.models.cancel')}
                >
                  ×
                </Button>
              </Dialog.CloseTrigger>
              <Dialog.Body py={3} overflowY="auto">
                {step === 'assign' ? (
                  <VStack align="stretch" gap={2}>
                    <Text fontSize="12px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                      {form.name} · {form.id}
                    </Text>
                    <HStack gap={1.5} wrap="wrap">
                      {(props.kind === 'coder' ? PERSONA_TYPES : form.roles).map((target) => (
                        <Chip
                          key={target}
                          label={target}
                          active={assignTargets.includes(target)}
                          onClick={function () { toggleAssign(target) }}
                        />
                      ))}
                    </HStack>
                  </VStack>
                ) : (
                  <ModelFormFields kind={props.kind} form={form} setForm={setForm} />
                )}
              </Dialog.Body>
              <Dialog.Footer gap={2} borderTop={`1px solid ${tokens.colors.border.subtle}`} pt={3}>
                {step === 'assign' ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={closeForm}
                      borderColor={tokens.colors.border.input}
                      color={tokens.colors.text.secondary}
                      _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                    >
                      {t('admin.models.assignSkip')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || assignTargets.length === 0}
                      onClick={publishSelected}
                      bg={tokens.colors.accent.primary}
                      color="white"
                      _hover={{ bg: tokens.colors.accent.primaryDark }}
                      _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
                    >
                      {busy ? t('admin.models.assignPublishing') : t('admin.models.assignPublish')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={closeForm}
                      borderColor={tokens.colors.border.input}
                      color={tokens.colors.text.secondary}
                      _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                    >
                      {t('admin.models.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={save}
                      bg={tokens.colors.accent.primary}
                      color="white"
                      _hover={{ bg: tokens.colors.accent.primaryDark }}
                      _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
                    >
                      {busy ? t('admin.models.saving') : t('admin.models.save')}
                    </Button>
                  </>
                )}
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <Dialog.Root
        open={pendingDelete !== null}
        onOpenChange={function (d) { if (!d.open && !busy) setPendingDelete(null) }}
      >
        <Portal>
          <Dialog.Backdrop bg={tokens.colors.dialog.backdrop} backdropFilter="blur(8px)" />
          <Dialog.Positioner>
            <Dialog.Content
              bg={tokens.colors.dialog.bg}
              border={`1px solid ${tokens.colors.dialog.border}`}
              borderRadius="16px"
              color={tokens.colors.text.primary}
              maxW="420px"
              w="92%"
            >
              <Dialog.Header>
                <Dialog.Title fontSize="16px" fontWeight="600">{t('admin.models.confirmDeleteTitle')}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="13px" color={tokens.colors.text.secondary} lineHeight="1.5">
                  {t('admin.models.confirmDelete').replace('{name}', pendingDelete?.name ?? '')}
                </Text>
              </Dialog.Body>
              <Dialog.Footer gap={2}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={function () { setPendingDelete(null) }}
                  borderColor={tokens.colors.border.input}
                  color={tokens.colors.text.secondary}
                  _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                >
                  {t('admin.models.cancel')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={confirmDelete}
                  bg={tokens.colors.accent.red}
                  color="white"
                  _hover={{ bg: '#d94841' }}
                >
                  {t('admin.models.confirmDeleteAction')}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  )
}

export default function ModelsPanel(props: { onCatalogChanged?: () => void }) {
  const t = useTranslation()
  // Local-first: lê o cache do localStorage uma vez (mount) para renderizar
  // imediatamente. O refresh do servidor corre em background e actualiza o
  // cache ao terminar. O catálogo muda raramente (só quando o admin edita),
  // por isso o cache é quase sempre fresco.
  const [cachedCoder] = useState(() => readAdminCache<AdminModel[]>(ADMIN_CACHE_KEYS.modelCatalog))
  const [cachedSidecar] = useState(() => readAdminCache<SidecarModel[]>(ADMIN_CACHE_KEYS.sidecarCatalog))
  const [cachedPersonas] = useState(() => readAdminCache<PersonasResponse>(ADMIN_CACHE_KEYS.personas))
  const [cachedSidecars] = useState(() => readAdminCache<SidecarsResponse>(ADMIN_CACHE_KEYS.sidecars))
  const hasCache = cachedCoder !== null || cachedSidecar !== null

  const [coder, setCoder] = useState<AdminModel[]>(cachedCoder ?? [])
  const [sidecar, setSidecar] = useState<SidecarModel[]>(cachedSidecar ?? [])
  const [personas, setPersonas] = useState<PersonasResponse | null>(cachedPersonas)
  const [sidecars, setSidecars] = useState<SidecarsResponse | null>(cachedSidecars)
  const [loading, setLoading] = useState(!hasCache)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async function () {
    if (!hasCache) setLoading(true)
    setError(null)
    try {
      const svc = await import('../../../services/adminService')
      const [coderList, sidecarList, personaState, sidecarState] = await Promise.all([
        svc.fetchModelCatalog(),
        svc.fetchSidecarCatalog(),
        svc.fetchPersonas(),
        svc.fetchSidecars(),
      ])
      setCoder(coderList)
      setSidecar(sidecarList)
      setPersonas(personaState)
      setSidecars(sidecarState)
      // Gravar no cache para a próxima visita ser instantânea.
      writeAdminCache(ADMIN_CACHE_KEYS.modelCatalog, coderList)
      writeAdminCache(ADMIN_CACHE_KEYS.sidecarCatalog, sidecarList)
      writeAdminCache(ADMIN_CACHE_KEYS.personas, personaState)
      writeAdminCache(ADMIN_CACHE_KEYS.sidecars, sidecarState)
    } catch (err) {
      if (!hasCache) {
        setError(err instanceof Error && err.message === 'FORBIDDEN'
          ? t('admin.forbidden')
          : (err instanceof Error ? err.message : String(err)))
      }
    } finally {
      setLoading(false)
    }
  }, [t, hasCache])

  useEffect(function () { load() }, [load])

  const changed = props.onCatalogChanged ?? function () {}
  const usedByCoder: Record<string, string[]> = {}
  for (const entry of coder) usedByCoder[entry.id] = slotsUsingEntry(entry, personas, sidecars)
  const usedBySidecar: Record<string, string[]> = {}
  for (const entry of sidecar) usedBySidecar[entry.id] = slotsUsingEntry(entry, personas, sidecars)

  return (
    <VStack align="stretch" gap={8}>
      <CatalogSection
        kind="coder"
        title={t('admin.models.title')}
        desc={t('admin.models.desc')}
        models={coder}
        usedBy={usedByCoder}
        loading={loading}
        error={error}
        onReload={load}
        onChanged={changed}
      />
      <CatalogSection
        kind="sidecar"
        title={t('admin.models.sidecarTitle')}
        desc={t('admin.models.sidecarDesc')}
        models={sidecar}
        usedBy={usedBySidecar}
        loading={loading}
        error={error}
        onReload={load}
        onChanged={changed}
      />
    </VStack>
  )
}
