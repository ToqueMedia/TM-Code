import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke } from '@tauri-apps/api/core'
import { tauriFetch } from '../services/tauriFetch'
import { resolveWorkerUrl } from '../utils/devUrls'
import FirebaseAuthService from '../services/auth/firebaseAuth'

// ── Base URL normalisation ──
//
// Single source of truth for trimming user-supplied provider base URLs.
// Applied uniformly for every provider (anthropic, openai, openrouter,
// gemini, deepseek, xai, ollama, custom, …) by routing every Settings
// input through `setBaseURL`, which calls this helper.
//
// Convention: the value stored is the API ROOT — the backend proxy
// appends provider-specific paths (`/chat/completions`, `/v1/messages`,
// `/api/chat`, …). Without trimming, users routinely copy the full
// endpoint URL from provider docs and produce doubled paths like
// `…/v1/chat/completions/chat/completions`.
//
// Patterns trimmed (case-insensitive, anchored at end):
//   - trailing `/` (any number)
//   - `/chat/completions`        — OpenAI-compatible providers
//   - `/v1/chat/completions`     — same as above when user includes /v1
//   - `/responses`               — OpenAI Responses API
//   - `/v1/messages`             — Anthropic Messages API
//   - `/api/chat`, `/api/generate` — Ollama native endpoints
//   - `/embeddings`              — sometimes pasted from docs
const BASE_URL_TRIM_PATTERNS: RegExp[] = [
  /\/v1\/chat\/completions$/i,
  /\/chat\/completions$/i,
  /\/v1\/messages$/i,
  /\/responses$/i,
  /\/api\/chat$/i,
  /\/api\/generate$/i,
  /\/embeddings$/i,
]

export function cleanBaseURL(input: string | undefined): string | undefined {
  if (input === undefined || input === null) return undefined
  let cleaned = input.trim().replace(/\/+$/, '')
  // Apply patterns iteratively — a pasted URL could end with both
  // `/v1/chat/completions` and a trailing slash; one pass per call is
  // sufficient because each pattern strips its own suffix.
  for (const pattern of BASE_URL_TRIM_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  // Strip trailing slash one more time in case a pattern left one.
  cleaned = cleaned.replace(/\/+$/, '')
  return cleaned.length === 0 ? undefined : cleaned
}

// ── Active-session snapshot sync ──
//
// When the user changes any BYOK selection (provider, model, baseURL,
// key presence, user-defined model, master toggle), the active chat
// session's byokSnapshot is stale — agentService routes via the snapshot,
// and ModelIndicator reads it to label the chat header. Calling
// chatStore.syncByokSnapshot() re-captures the current selection into
// the active session so both stay in sync with what the user just chose.
//
// We also flip agentStore.byokActive=false. byokActive is set TRUE by
// the X-BYOK-Active response header and is sticky across renders — it's
// the IndicatorComponent's "server-confirmed" branch and reads
// agentStore.modelName (the LAST response's model). After a BYOK switch
// no new response has arrived yet, so leaving byokActive=true makes the
// indicator label the OLD model. Flipping it false lets the indicator
// fall back to the "configured/preview" branch, which reads the live
// byokStore selection. The next response's X-BYOK-Active header will
// re-set it with the now-current model.
//
// Dynamic imports to break the circular byokStore ↔ chatStore /
// agentStore module cycle (chatStore already imports captureByokSnapshot
// from sessionService, which itself reads byokStore — a static back-edge
// would create a cycle).
function syncActiveSessionSnapshot(): void {
  void import('./chatStore').then(({ useChatStore }) => {
    useChatStore.getState().syncByokSnapshot()
  }).catch(() => { /* non-critical */ })
  void import('./agentStore').then(({ useAgentStore }) => {
    const agent = useAgentStore.getState()
    if (agent.byokActive) agent.setByokActive(false)
  }).catch(() => { /* non-critical */ })
}

// ── BYOK store ──
//
// Runtime + persisted state for Bring Your Own Key. Three layers:
//
//   1. Provider catalog (`providers`) — fetched from /v1/byok/providers
//      after auth + features.byokEnabled. Cached in-memory only; not
//      persisted (admin can update it server-side at any time).
//
//   2. Per-provider configuration (`perProviderConfig`) — metadata about
//      which providers the user has set up (hasKey, optional baseURL
//      override). PERSISTED to localStorage. NEVER contains the API key
//      itself — the key lives in the OS keychain via Tauri commands.
//
//   3. Active selection (`enabled`, `activeProvider`, `activeModel`) —
//      what the IDE will route through. Persisted. Per-session snapshot
//      is taken when a chat session is created (sessionService) so
//      switching active provider only affects new sessions.

export interface ByokModelCapabilities {
  images: boolean
  audio: boolean
  video: boolean
  tools: boolean
}

export type ThinkingShape =
  | 'anthropic'
  | 'openai_reasoning_effort'
  | 'qwen_enable_thinking'
  | 'gemini_thinking_budget'

export interface ByokModel {
  id: string
  label: string
  capabilities: ByokModelCapabilities
  contextWindow: number
  supportsThinking: boolean
  thinkingShape?: ThinkingShape
  pricing?: { inputPer1M: number; outputPer1M: number }
}

export type ApiShape = 'openai_compat' | 'anthropic'

export interface ByokProvider {
  id: string
  name: string
  enabled: boolean
  defaultBaseURL: string
  authHeader: string
  authPrefix: string
  apiShape: ApiShape
  extraHeaders?: Record<string, string>
  models: ByokModel[]
  local?: boolean
  custom?: boolean
}

export interface ByokProviderConfig {
  /** Whether the keychain has a key for this provider. Sourced from
   *  byok_has_key Tauri command at load time and after set/delete. */
  hasKey: boolean
  /** User-supplied baseURL override (org gateway). Empty/undefined = use
   *  provider.defaultBaseURL. */
  baseURL?: string
  /** Last-used timestamp (ms). Updated on every chat send so the Settings
   *  UI can rank providers. */
  lastUsed?: number
  /** "Other model" — user typed a model id not in the curated registry
   *  (e.g. a brand-new release the catalog hasn't caught up with). When
   *  set, resolveActive() synthesizes a ByokModel from this so the rest
   *  of the pipeline works without a registry hit. */
  userDefinedModel?: {
    id: string
    capabilities: ByokModelCapabilities
    supportsThinking: boolean
  }
}

export interface TestKeyResult {
  valid: boolean
  latencyMs?: number
  error?: string
  statusCode?: number
}

interface ByokState {
  /** Master toggle. When false, no BYOK headers are sent regardless of the
   *  active provider/model selection. */
  enabled: boolean
  activeProvider: string | null
  activeModel: string | null
  /** In-memory only — refreshed from /v1/byok/providers each time
   *  features.byokEnabled goes from false → true. */
  providers: ByokProvider[]
  /** Per-provider metadata (NOT keys). Keyed by provider id. */
  perProviderConfig: Record<string, ByokProviderConfig>
  /** Has the catalog ever been loaded since this app session started? */
  catalogLoaded: boolean

  // ── actions ──
  loadProviders: () => Promise<void>
  setKey: (providerId: string, key: string) => Promise<void>
  deleteKey: (providerId: string) => Promise<void>
  setBaseURL: (providerId: string, baseURL: string | undefined) => void
  testKey: (
    providerId: string,
    modelId: string,
    keyOverride?: string,
    baseURLOverride?: string,
  ) => Promise<TestKeyResult>
  toggle: (enabled: boolean) => void
  setActive: (providerId: string | null, modelId: string | null) => void
  markUsed: (providerId: string) => void
  /** Set the user-defined "Other model" for a curated provider — the user
   *  declared the model id and its capabilities themselves. Persists in
   *  localStorage so the option stays around between launches. */
  setUserDefinedModel: (
    providerId: string,
    model: { id: string; capabilities: ByokModelCapabilities; supportsThinking: boolean },
  ) => void
  clearUserDefinedModel: (providerId: string) => void
  /** Look up effective config for the active selection, including the
   *  resolved baseURL (override or default). Returns null if BYOK isn't
   *  fully configured to send headers. */
  resolveActive: () => {
    provider: ByokProvider
    model: ByokModel
    baseURL: string
  } | null
}

export const useByokStore = create<ByokState>()(
  persist(
    (set, get) => ({
      enabled: false,
      activeProvider: null,
      activeModel: null,
      providers: [],
      perProviderConfig: {},
      catalogLoaded: false,

      loadProviders: async () => {
        try {
          const token = await FirebaseAuthService.getInstance().getIdToken()
          if (!token) return
          const res = await tauriFetch(`${resolveWorkerUrl()}/v1/byok/providers`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (!res.ok) {
            console.warn(`[byok] /v1/byok/providers returned ${res.status}`)
            return
          }
          const data = await res.json() as { providers: ByokProvider[] }
          const providers = Array.isArray(data.providers) ? data.providers : []

          // Refresh hasKey for each known provider (keychain is the source of
          // truth — persisted hasKey could be stale after a manual delete).
          const config = { ...get().perProviderConfig }
          for (const provider of providers) {
            const existing = config[provider.id] || { hasKey: false }
            try {
              const present = await invoke<boolean>('byok_has_key', { provider: provider.id })
              config[provider.id] = { ...existing, hasKey: present }
            } catch (err) {
              console.warn(`[byok] byok_has_key(${provider.id}) failed:`, err)
            }
          }

          set({ providers, perProviderConfig: config, catalogLoaded: true })
        } catch (err) {
          console.warn('[byok] loadProviders failed:', err)
        }
      },

      setKey: async (providerId, key) => {
        // The Rust side (byok_set_key) tries the OS keychain first and falls
        // back to an encrypted file when the keychain is unavailable (typical
        // on unsigned dev builds). It returns Ok in BOTH cases — the key is
        // safely persisted somewhere reachable by byok_get_key. If invoke()
        // throws, the Rust side returned Err and the caller's try/catch
        // surfaces the message to the UI.
        await invoke('byok_set_key', { provider: providerId, key })
        const config = { ...get().perProviderConfig }
        config[providerId] = { ...(config[providerId] || {}), hasKey: true }
        set({ perProviderConfig: config })
        syncActiveSessionSnapshot()
      },

      deleteKey: async (providerId) => {
        await invoke('byok_delete_key', { provider: providerId })
        const config = { ...get().perProviderConfig }
        config[providerId] = { ...(config[providerId] || { hasKey: false }), hasKey: false }
        // If this was the active provider, deactivate to avoid sending headers
        // for a provider that has no key.
        const next: Partial<ByokState> = { perProviderConfig: config }
        if (get().activeProvider === providerId) {
          next.activeProvider = null
          next.activeModel = null
          next.enabled = false
        }
        set(next as ByokState)
        syncActiveSessionSnapshot()
      },

      setBaseURL: (providerId, baseURL) => {
        const config = { ...get().perProviderConfig }
        const existing = config[providerId] || { hasKey: false }
        config[providerId] = { ...existing, baseURL: cleanBaseURL(baseURL) }
        set({ perProviderConfig: config })
        syncActiveSessionSnapshot()
      },

      testKey: async (providerId, modelId, keyOverride, baseURLOverride) => {
        try {
          const token = await FirebaseAuthService.getInstance().getIdToken()
          if (!token) return { valid: false, error: 'Not authenticated' }

          // Resolve the key — explicit override wins (Settings form before
          // saving), otherwise read from keychain.
          let key = keyOverride
          if (!key) {
            try {
              const stored = await invoke<string | null>('byok_get_key', { provider: providerId })
              if (!stored) return { valid: false, error: 'No key set for this provider' }
              key = stored
            } catch (err) {
              return { valid: false, error: `Keychain read failed: ${String(err)}` }
            }
          }

          const baseURL = baseURLOverride ?? get().perProviderConfig[providerId]?.baseURL

          const res = await tauriFetch(`${resolveWorkerUrl()}/v1/byok/validate`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ provider: providerId, key, model: modelId, baseURL }),
          })

          const data = await res.json().catch(() => ({})) as {
            valid?: boolean
            latencyMs?: number
            error?: string
            statusCode?: number
          }
          return {
            valid: data.valid === true,
            latencyMs: data.latencyMs,
            error: data.error,
            statusCode: data.statusCode,
          }
        } catch (err) {
          return { valid: false, error: err instanceof Error ? err.message : String(err) }
        }
      },

      toggle: (enabled) => {
        set({ enabled })
        syncActiveSessionSnapshot()
      },

      setActive: (providerId, modelId) => {
        set({ activeProvider: providerId, activeModel: modelId })
        syncActiveSessionSnapshot()
      },

      markUsed: (providerId) => {
        const config = { ...get().perProviderConfig }
        const existing = config[providerId]
        if (!existing) return
        config[providerId] = { ...existing, lastUsed: Date.now() }
        set({ perProviderConfig: config })
      },

      setUserDefinedModel: (providerId, model) => {
        const config = { ...get().perProviderConfig }
        config[providerId] = {
          ...(config[providerId] || { hasKey: false }),
          userDefinedModel: model,
        }
        set({ perProviderConfig: config })
        syncActiveSessionSnapshot()
      },

      clearUserDefinedModel: (providerId) => {
        const config = { ...get().perProviderConfig }
        const existing = config[providerId]
        if (!existing?.userDefinedModel) return
        const { userDefinedModel: _drop, ...rest } = existing
        config[providerId] = rest as ByokProviderConfig
        set({ perProviderConfig: config })
        syncActiveSessionSnapshot()
      },

      resolveActive: () => {
        const { enabled, activeProvider, activeModel, providers, perProviderConfig } = get()
        if (!enabled || !activeProvider || !activeModel) return null
        const provider = providers.find(p => p.id === activeProvider)
        if (!provider) return null

        const config = perProviderConfig[activeProvider]
        const userDefined = config?.userDefinedModel
        const registryModel = provider.models.find(m => m.id === activeModel)
        const baseURL = (config?.baseURL || provider.defaultBaseURL).replace(/\/$/, '')

        // Three resolution paths, in order:
        //   1. Catalog hit — use the registry entry as-is
        //   2. User-defined "other model" matches the active selection —
        //      synthesise from user-declared metadata
        //   3. Custom provider with free-text model — synthesise minimal entry
        //      (capabilities decided by the user in the custom provider's UI)
        if (registryModel) {
          return { provider, model: registryModel, baseURL }
        }
        if (userDefined && userDefined.id === activeModel) {
          const synthesized: ByokModel = {
            id: userDefined.id,
            label: userDefined.id,
            capabilities: userDefined.capabilities,
            contextWindow: 0,
            supportsThinking: userDefined.supportsThinking,
          }
          return { provider, model: synthesized, baseURL }
        }
        if (provider.custom) {
          const synthesized: ByokModel = {
            id: activeModel,
            label: activeModel,
            capabilities: { images: false, audio: false, video: false, tools: false },
            contextWindow: 0,
            supportsThinking: false,
          }
          return { provider, model: synthesized, baseURL }
        }
        return null
      },
    }),
    {
      name: 'byok-storage',
      // Persist ONLY metadata. Never persist the key itself, never persist
      // the providers catalog (it can change server-side and is refetched
      // on every load). `catalogLoaded` is in-memory only.
      partialize: (state) => ({
        enabled: state.enabled,
        activeProvider: state.activeProvider,
        activeModel: state.activeModel,
        perProviderConfig: state.perProviderConfig,
      }),
    },
  ),
)
