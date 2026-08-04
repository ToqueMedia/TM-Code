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
  baseUrl: string
  chatCompletionsPath: string
  authHeader: string
  authScheme: 'Bearer' | 'none'
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

export type SidecarType = 'vision' | 'web_search' | 'utility' | 'fim'

export interface SidecarModel {
  id: string
  name: string
  providerLabel: string
  roles: SidecarType[]
  activeConfig: ActiveAIConfigInput
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
// o admin atribui aqui um modelo do catálogo coder + um costMultiplier a cada
// persona. O control-plane publica `persona:*` no KV do data-plane, que fatura
// billableTokenTotal (cache já a 50%) × multiplier.

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
  costMultiplier: number,
  contextWindow?: number,
): Promise<ActiveAIConfig> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/personas`, {
    method: 'PUT',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona, modelId, costMultiplier, ...(contextWindow ? { contextWindow } : {}) }),
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
