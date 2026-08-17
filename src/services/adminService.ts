import { tauriFetch } from './tauriFetch'
import { resolveWorkerUrl } from '../utils/devUrls'
import FirebaseAuthService from './auth/firebaseAuth'

export type ModelCategory = 'coder' | 'reasoning' | 'other'

export interface AdminModel {
  id: string
  name: string
  providerLabel: string
  category: ModelCategory
  activeConfig: ActiveAIConfigInput
  updatedAt?: string
  updatedBy?: string
}

export type ActiveAIConfigInput = Omit<ActiveAIConfig, 'updatedAt' | 'updatedBy'>

async function authHeaders(): Promise<Record<string, string>> {
  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) throw new Error('Not authenticated')
  return { 'Authorization': `Bearer ${token}` }
}

// publishActiveAIConfig/setActiveAIModel/fetchAdminModels REMOVIDOS
// (2026-08-05): as PERSONAS substituem o painel de config ativa — publicar a
// Standard escreve também a chave `active` no control-plane. Os endpoints
// /v1/admin/models e /v1/admin/ai/active-config continuam vivos no servidor
// (compat/testes); a IDE deixou de os consumir.

export interface ActiveAIConfig {
  provider: string
  model: string
  /** Modelo alternativo quando o pedido traz X-TM-Speed. */
  speedModel?: string
  baseUrl: string
  chatCompletionsPath: string
  authHeader: string
  authScheme: 'Bearer' | 'none' | 'google_oauth'
  apiKeyEnv: string
  enabled: boolean
  /** Janela de contexto real (tokens) escolhida pelo admin no Select. Emitida
   *  pelo data-plane em X-Model-Context-Window; alimenta a pressão de contexto
   *  e o auto-compact na IDE. Opcional → fallback de perfil. */
  contextWindow?: number
  /** Extras de request do provider (ex.: DashScope enable_search, Gemini
   *  thinking_config) merged no corpo pelo data-plane. */
  extraBody?: Record<string, unknown>
  /** Multiplicador de custo da persona (só nas configs `persona:*`): o
   *  data-plane fatura billableTokenTotal (cache já a 50%) × este valor. */
  costMultiplier?: number
  thinking?: {
    param: 'reasoning_effort' | 'enable_thinking' | 'thinking_object'
    options: string[]
    default: string
  }
  supportsVision?: boolean
  supportsSearch?: boolean
  thinkingMode?: 'toggleable' | 'mandatory' | 'none'
  maxOutputTokens?: number
  imagePricing?: { output1k?: number; output2k?: number; input?: number }
  updatedAt?: string
  updatedBy?: string
}

export interface VerifyResponse {
  activeAIConfig?: ActiveAIConfig | null
  cache: {
    activeConfigKey: string
  }
}

export async function fetchAdminVerify(): Promise<VerifyResponse> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/verify`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to verify admin state (${res.status}): ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as Partial<VerifyResponse>
  return {
    ...data,
    activeAIConfig: data.activeAIConfig ?? null,
    cache: {
      activeConfigKey: data.cache?.activeConfigKey ?? 'active',
    },
  }
}

// ─── Sidecars (vision / web_search / utility / fim) ─────────────────────────
// The data-plane routes X-Request-Type → KV `sidecar:*`. The admin assigns a
// catalog model to each slot; a blind active model then gets images described
// (vision) or web results (web_search) by the sidecar instead of degrading.

// 'image' = GERAÇÃO de imagens (2026-08-07), ao contrário de 'vision' que as LÊ.
// Publicável pelo admin; nenhum caminho do agente envia X-Request-Type: image.
export type SidecarType = 'vision' | 'web_search' | 'utility' | 'fim' | 'image'

export interface SidecarModel {
  id: string
  name: string
  providerLabel: string
  roles: SidecarType[]
  activeConfig: ActiveAIConfigInput
  updatedAt?: string
  updatedBy?: string
}

export interface SidecarsResponse {
  catalog: SidecarModel[]
  /** Keyed by full KV key, e.g. `sidecar:vision`. null when not published. */
  current: Record<string, ActiveAIConfig | null>
}

export async function fetchSidecars(): Promise<SidecarsResponse> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/sidecars`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to load sidecars (${res.status}): ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as Partial<SidecarsResponse>
  return { catalog: data.catalog ?? [], current: data.current ?? {} }
}

export async function setSidecar(type: SidecarType, modelId: string): Promise<ActiveAIConfig> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/sidecars`, {
    method: 'PUT',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, modelId }),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const raw = await res.text().catch(() => '')
    let human = raw
    try {
      const parsed = JSON.parse(raw) as { error?: string }
      human = parsed.error || raw
    } catch { /* keep raw */ }
    throw new Error(`Failed to set sidecar (${res.status}): ${human.slice(0, 300)}`)
  }
  const data = (await res.json()) as { config?: ActiveAIConfig }
  if (!data.config) throw new Error('Failed to set sidecar: missing config in response')
  return data.config
}

export async function disableSidecar(type: SidecarType): Promise<void> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/sidecars`, {
    method: 'PUT',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, disable: true }),
  })
  if (!res.ok && res.status !== 404) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    throw new Error(`Failed to disable sidecar (${res.status})`)
  }
}

// ─── Personas (Escolha do Modelo, 2026-08-04) ───────────────────────────────
// O selector do utilizador expõe Standard/Expert/Master sem revelar modelos;
// o admin atribui aqui um modelo do catálogo coder e a janela de contexto a
// cada persona. O campo costMultiplier continua obrigatório no control-plane
// por compatibilidade, mas o data-plane já não o aplica (metering 30/70).

export type PersonaType = 'standard' | 'expert' | 'master'

export interface PersonasResponse {
  /** Catálogo coder completo — o admin escolhe entre estes por persona. */
  catalog: AdminModel[]
  /** Keyed by full KV key, e.g. `persona:expert`. null when not published. */
  current: Record<string, ActiveAIConfig | null>
}

export async function fetchPersonas(): Promise<PersonasResponse> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/personas`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to load personas (${res.status}): ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as Partial<PersonasResponse>
  return { catalog: data.catalog ?? [], current: data.current ?? {} }
}

export async function setPersona(
  persona: PersonaType,
  modelId: string,
  contextWindow?: number,
): Promise<ActiveAIConfig> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/personas`, {
    method: 'PUT',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      persona,
      modelId,
      // Compatibilidade com o endpoint actual; não representa uma escolha de
      // consumo e é ignorado pelo data-plane.
      costMultiplier: 1,
      ...(contextWindow ? { contextWindow } : {}),
    }),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const raw = await res.text().catch(() => '')
    let human = raw
    try {
      const parsed = JSON.parse(raw) as { error?: string }
      human = parsed.error || raw
    } catch { /* keep raw */ }
    throw new Error(`Failed to set persona (${res.status}): ${human.slice(0, 300)}`)
  }
  const data = (await res.json()) as { config?: ActiveAIConfig }
  if (!data.config) throw new Error('Failed to set persona: missing config in response')
  return data.config
}

export async function disablePersona(persona: PersonaType): Promise<void> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/personas`, {
    method: 'PUT',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona, disable: true }),
  })
  if (!res.ok && res.status !== 404) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    throw new Error(`Failed to disable persona (${res.status})`)
  }
}

// ─── Catálogo KV (CRUD) ─────────────────────────────────────────────────────
// Adicionar/remover um modelo é uma edição de dados. As constantes compiladas
// no control-plane são só seed de primeiro boot; depois disto o KV
// (`catalog:coder` / `catalog:sidecar`) é a fonte de verdade. Um apiKeyEnv
// NOVO exige `wrangler secret put` no data-plane — não um deploy de código.

export type AdminModelInput = {
  id: string
  name: string
  providerLabel: string
  activeConfig: ActiveAIConfigInput
}

export type SidecarModelInput = {
  id: string
  name: string
  providerLabel: string
  roles: SidecarType[]
  activeConfig: ActiveAIConfigInput
}

async function catalogRequest<T>(
  path: string,
  init: { method: string; body?: string },
  failLabel: string,
): Promise<T> {
  const res = await tauriFetch(`${resolveWorkerUrl()}${path}`, {
    method: init.method,
    body: init.body,
    headers: {
      ...(await authHeaders()),
      ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const raw = await res.text().catch(() => '')
    let human = raw
    try {
      const parsed = JSON.parse(raw) as { error?: string }
      human = parsed.error || raw
    } catch { /* keep raw */ }
    throw new Error(human || `${failLabel} (${res.status})`)
  }
  return await res.json() as T
}

export async function fetchModelCatalog(): Promise<AdminModel[]> {
  const data = await catalogRequest<{ models?: AdminModel[] }>(
    '/v1/admin/models',
    { method: 'GET' },
    'Failed to load model catalog',
  )
  return data.models ?? []
}

export async function createModel(entry: AdminModelInput): Promise<AdminModel> {
  const data = await catalogRequest<{ model?: AdminModel }>(
    '/v1/admin/models',
    { method: 'POST', body: JSON.stringify(entry) },
    'Failed to create model',
  )
  if (!data.model) throw new Error('Failed to create model: missing model in response')
  return data.model
}

export async function updateModel(id: string, entry: AdminModelInput): Promise<AdminModel> {
  const data = await catalogRequest<{ model?: AdminModel }>(
    `/v1/admin/models/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(entry) },
    'Failed to update model',
  )
  if (!data.model) throw new Error('Failed to update model: missing model in response')
  return data.model
}

export async function deleteModel(id: string): Promise<void> {
  await catalogRequest<{ deleted?: string }>(
    `/v1/admin/models/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Failed to delete model',
  )
}

export async function fetchSidecarCatalog(): Promise<SidecarModel[]> {
  const data = await catalogRequest<{ models?: SidecarModel[] }>(
    '/v1/admin/sidecar-models',
    { method: 'GET' },
    'Failed to load sidecar catalog',
  )
  return data.models ?? []
}

export async function createSidecarModel(entry: SidecarModelInput): Promise<SidecarModel> {
  const data = await catalogRequest<{ model?: SidecarModel }>(
    '/v1/admin/sidecar-models',
    { method: 'POST', body: JSON.stringify(entry) },
    'Failed to create sidecar model',
  )
  if (!data.model) throw new Error('Failed to create sidecar model: missing model in response')
  return data.model
}

export async function updateSidecarModel(id: string, entry: SidecarModelInput): Promise<SidecarModel> {
  const data = await catalogRequest<{ model?: SidecarModel }>(
    `/v1/admin/sidecar-models/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(entry) },
    'Failed to update sidecar model',
  )
  if (!data.model) throw new Error('Failed to update sidecar model: missing model in response')
  return data.model
}

export async function deleteSidecarModel(id: string): Promise<void> {
  await catalogRequest<{ deleted?: string }>(
    `/v1/admin/sidecar-models/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Failed to delete sidecar model',
  )
}
