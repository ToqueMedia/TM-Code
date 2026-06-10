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

export interface AdminModelsResponse {
  models: AdminModel[]
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) throw new Error('Not authenticated')
  return { 'Authorization': `Bearer ${token}` }
}

export async function fetchAdminModels(): Promise<AdminModelsResponse> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/models`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to load admin models (${res.status}): ${detail.slice(0, 200)}`)
  }
  return await res.json() as AdminModelsResponse
}

export async function publishActiveAIConfig(config: ActiveAIConfigInput): Promise<ActiveAIConfig> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/ai/active-config`, {
    method: 'PUT',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    const raw = await res.text().catch(() => '')
    let human = raw
    try {
      const parsed = JSON.parse(raw) as { error?: string; detail?: string }
      human = parsed.detail || parsed.error || raw
    } catch { /* keep raw */ }
    throw new Error(`Failed to publish active AI config (${res.status}): ${human.slice(0, 300)}`)
  }
  const data = await res.json() as { config?: ActiveAIConfig }
  if (!data.config) {
    throw new Error('Failed to publish active AI config: missing config in response')
  }
  return data.config
}

export async function setActiveAIModel(model: AdminModel): Promise<ActiveAIConfig> {
  return publishActiveAIConfig(model.activeConfig)
}

export interface ActiveAIConfig {
  provider: string
  model: string
  baseUrl: string
  chatCompletionsPath: string
  authHeader: string
  authScheme: 'Bearer' | 'none'
  apiKeyEnv: string
  enabled: boolean
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
