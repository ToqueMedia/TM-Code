import { tauriFetch } from './tauriFetch'
import { resolveWorkerUrl } from '../utils/devUrls'
import FirebaseAuthService from './auth/firebaseAuth'

export type ModelCategory = 'coder' | 'reasoning' | 'other'

export interface AdminModel {
  id: string
  name: string
  providerLabel: string
  category: ModelCategory
}

export interface AdminModelsResponse {
  models: AdminModel[]
  live: {
    free: string
    paid: string | null
    paidDivergent: Record<string, string> | null
  }
}

export type AdminPlanGroup = 'free' | 'paid'

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

export async function setLiveModel(plan: AdminPlanGroup, modelId: string): Promise<void> {
  const res = await tauriFetch(`${resolveWorkerUrl()}/v1/admin/live-model`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, modelId }),
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('FORBIDDEN')
    // The worker returns a structured JSON envelope: `{ error: string, detail?: string }`.
    // Surface the human-readable `detail` when present (covers the
    // common "Plan(s) not found in Firestore" case the user kept hitting
    // — previously came through as a raw JSON dump in the UI error banner).
    // Falls back to the raw body when not JSON / no detail field.
    const raw = await res.text().catch(() => '')
    let human = raw
    try {
      const parsed = JSON.parse(raw) as { error?: string; detail?: string }
      if (parsed.detail) {
        human = parsed.detail
      } else if (parsed.error) {
        human = parsed.error
      }
    } catch { /* not JSON — keep raw */ }
    throw new Error(`Failed to update live model (${res.status}): ${human.slice(0, 300)}`)
  }
}

export interface VerifyEntry {
  plan: string
  storedIdeModel: string
  resolvedProvider: string | null
  resolvedUpstreamModel: string | null
  providerUrl: string | null
  ok: boolean
}

export interface VerifyResponse {
  verified: VerifyEntry[]
  cache: {
    kvLive: Record<string, string | null>
    stalePlans: string[]
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
  return await res.json() as VerifyResponse
}
