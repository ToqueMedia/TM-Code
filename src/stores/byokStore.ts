import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke } from '@/utils/invokeMetrics'
import { tauriFetch } from '../services/tauriFetch'
import { inferLocalModelCapabilities } from './byokModelCapabilities'
import { cleanBaseURL } from './byokBaseURL'

// Re-export the pure URL helper so any consumer that imports from byokStore
// keeps working (callers may have grabbed `cleanBaseURL` from here before
// it moved to its own pure module — see byokBaseURL.ts).
export { cleanBaseURL }

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
    const active = useByokStore.getState().resolveActive()
    if (active) {
      const configuredWindow = useByokStore.getState().perProviderConfig[active.provider.id]?.contextWindow
      const contextWindow = configuredWindow && configuredWindow > 0
        ? configuredWindow
        : active.model.contextWindow > 0
          ? active.model.contextWindow
          : undefined
      agent.setModelInfo(
        active.model.id,
        active.provider.id,
        active.model.supportsThinking ? 'toggleable' : 'none',
        contextWindow,
      )
    }
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
  | 'openrouter_reasoning'
  | 'mimo_chat_template_kwargs'

export type ByokReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  /** Catalog rendering bucket (ApiKeysSection groups Cloud / Local / Custom).
   *  Anthropic is a curated cloud provider but lives under Custom by product
   *  decision, so it sets `group:'custom'` while keeping `custom:false` (it
   *  still shows its curated model list, not the free-text Custom input).
   *  When absent, the UI derives the bucket from `local`/`custom` flags. */
  group?: 'cloud' | 'local' | 'custom'
}

export interface ByokProviderConfig {
  /** Whether the keychain has a key for this provider. Sourced from
   *  byok_has_key Tauri command at load time and after set/delete. */
  hasKey: boolean
  /** Last 4 characters of the saved key, captured at setKey time so the
   *  Settings UI can render `sk-...abcd` for visual confirmation that the
   *  saved key is the right one. The full key never leaves the OS keychain;
   *  this hint is purely a memory aid and is safe to persist (4 chars don't
   *  reduce key entropy meaningfully). Cleared on deleteKey. */
  keyHint?: string
  /** Local providers (Ollama, LM Studio) without auth: marked TRUE once the
   *  user confirms the connection (Test passed) so resolveActive can route
   *  to them without a key. Cloud providers ignore this — the implicit
   *  "configured" signal there is `hasKey`. */
  configured?: boolean
  /** User-supplied baseURL override (org gateway). Empty/undefined = use
   *  provider.defaultBaseURL. */
  baseURL?: string
  /** User-declared context window for the BYOK model, in tokens. Under BYOK the
   *  request bypasses the worker, so the IDE can't learn the real window from
   *  the X-Model-Context-Window response header — the USER declares the value
   *  their model supports (Settings dropdown: 128K/192K/200K/256K/1M/2M) and
   *  the agent's auto-compact uses it. Empty = fall back to the catalog model's
   *  contextWindow, then FALLBACK_CONTEXT_WINDOW. Persisted. */
  contextWindow?: number
  /** User-selected reasoning depth for BYOK providers. Not every provider
   *  supports every level; routing maps this to the provider-native control
   *  where possible and ignores it for boolean-only thinking APIs. */
  reasoningEffort?: ByokReasoningEffort
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
  /** For local providers: live model list pulled from the local server's
   *  discovery endpoint (Ollama /api/tags, LM Studio /v1/models). NOT
   *  persisted — refreshed on demand because the user can pull/delete
   *  models via CLI between launches. */
  dynamicCatalog?: { fetchedAt: number; models: ByokModel[] }
}

export interface TestKeyResult {
  valid: boolean
  latencyMs?: number
  error?: string
  statusCode?: number
}

function buildDirectValidationURL(provider: ByokProvider, baseURLOverride?: string): string | null {
  const baseURL = cleanBaseURL(baseURLOverride || provider.defaultBaseURL)
  if (!baseURL) return null
  const base = baseURL.replace(/\/+$/, '')
  return provider.apiShape === 'anthropic'
    ? `${base}/v1/messages`
    : `${base}/chat/completions`
}

function buildDirectValidationBody(provider: ByokProvider, modelId: string): Record<string, unknown> {
  if (provider.apiShape === 'anthropic') {
    return {
      model: modelId,
      max_tokens: 5,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      stream: false,
    }
  }

  return {
    model: modelId,
    messages: [{ role: 'user', content: 'ok' }],
    max_tokens: 5,
    stream: false,
  }
}

function buildDirectValidationHeaders(provider: ByokProvider, apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [provider.authHeader]: `${provider.authPrefix}${apiKey}`,
    ...(provider.extraHeaders ?? {}),
  }
}

// ── Local providers (hardcoded) ──
//
// Ollama and LM Studio are always available regardless of auth state, so the
// user can run TM Code fully offline. They're merged into `providers` after
// the cloud catalog is fetched from the worker (cloud entries with the same
// id win — the worker may eventually serve these too).
//
// Both expose OpenAI-compatible /v1/chat/completions, so apiShape is openai_compat
// and authHeader is empty (we don't inject Authorization for local-no-auth).
// `models: []` is intentional — local models are dynamic; the IDE refreshes
// them via `refreshLocalModels()` which calls the discovery endpoint.
// ── Cloud providers (hardcoded) ──
//
// BYOK is IDE → SDK → provider DIRECT (never the TM worker), so the catalog is
// owned by the IDE — there is no server `/v1/byok/providers` fetch anymore.
// Curated set: Google Gemini + DashScope/Alibaba + StepFun (OpenAI-compat),
// Custom (free-text OpenAI-compatible), and Anthropic (native Messages API).
//
// `contextWindow` here is only a DEFAULT — under BYOK the user declares the
// real window via the Settings dropdown (perProviderConfig.contextWindow),
// because the worker (which used to emit X-Model-Context-Window) is bypassed.
// Model ids are sensible defaults; users pin exact ids via "Other model".
const CLOUD_PROVIDERS: ByokProvider[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    enabled: true,
    group: 'cloud',
    // OpenAI-compat endpoint. The SDK appends /chat/completions → .../openai/chat/completions.
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    apiShape: 'openai_compat',
    // June 2026: Gemini 3 / 3.5 generation. The OpenAI-compat endpoint maps
    // reasoning_effort → thinkingConfig; reasoning can't be disabled on Pro/3
    // models, so the default `medium` (buildThinkingConfig) is always valid.
    models: [
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 1_048_576, supportsThinking: true, thinkingShape: 'gemini_thinking_budget' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 1_048_576, supportsThinking: true, thinkingShape: 'gemini_thinking_budget' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 1_048_576, supportsThinking: true, thinkingShape: 'gemini_thinking_budget' },
    ],
  },
  {
    id: 'dashscope',
    name: 'DashScope (Alibaba Cloud)',
    enabled: true,
    group: 'cloud',
    // International endpoint. CN users override the baseURL with
    // https://dashscope.aliyuncs.com/compatible-mode/v1 in the Base URL field.
    defaultBaseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    apiShape: 'openai_compat',
    // supportsThinking:false by default — DashScope's `enable_thinking` only
    // applies to some Qwen3 SKUs and errors on non-streaming; users opt in per
    // model via "Other model" if they run a thinking SKU. The thinkingShape is
    // still detected from the host (qwen_enable_thinking) when they do.
    models: [
      { id: 'qwen3-max', label: 'Qwen3 Max', capabilities: { images: false, audio: false, video: false, tools: true }, contextWindow: 262_144, supportsThinking: false },
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', capabilities: { images: false, audio: false, video: false, tools: true }, contextWindow: 1_048_576, supportsThinking: false },
      { id: 'qwen-plus', label: 'Qwen Plus', capabilities: { images: false, audio: false, video: false, tools: true }, contextWindow: 131_072, supportsThinking: false },
      { id: 'qwen-max', label: 'Qwen Max', capabilities: { images: false, audio: false, video: false, tools: true }, contextWindow: 32_768, supportsThinking: false },
    ],
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    enabled: true,
    group: 'cloud',
    defaultBaseURL: 'https://api.stepfun.ai/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    apiShape: 'openai_compat',
    models: [
      { id: 'step-3.7-flash', label: 'Step 3.7 Flash', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 262_144, supportsThinking: true, thinkingShape: 'openai_reasoning_effort' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    enabled: true,
    // Curated cloud provider, but grouped under Custom per product decision.
    group: 'custom',
    defaultBaseURL: 'https://api.anthropic.com',
    // Anthropic authenticates with x-api-key, not Authorization: Bearer.
    authHeader: 'x-api-key',
    authPrefix: '',
    apiShape: 'anthropic',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 200_000, supportsThinking: true, thinkingShape: 'anthropic' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 200_000, supportsThinking: true, thinkingShape: 'anthropic' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 200_000, supportsThinking: true, thinkingShape: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', capabilities: { images: true, audio: false, video: false, tools: true }, contextWindow: 200_000, supportsThinking: false, thinkingShape: 'anthropic' },
    ],
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-Compatible)',
    enabled: true,
    group: 'custom',
    custom: true,
    defaultBaseURL: '',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    apiShape: 'openai_compat',
    models: [],
  },
]

const LOCAL_PROVIDERS: ByokProvider[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    enabled: true,
    group: 'local',
    defaultBaseURL: 'http://localhost:11434',
    authHeader: '',
    authPrefix: '',
    apiShape: 'openai_compat',
    models: [],
    local: true,
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    enabled: true,
    group: 'local',
    defaultBaseURL: 'http://localhost:1234',
    authHeader: '',
    authPrefix: '',
    apiShape: 'openai_compat',
    models: [],
    local: true,
  },
]

// Discovery endpoint per local provider. Both return JSON that we map to
// ByokModel entries; capabilities default to false (user can override per
// model via the existing "Other model" capability checkboxes).
const LOCAL_DISCOVERY_PATH: Record<string, string> = {
  ollama: '/api/tags',
  'lm-studio': '/v1/models',
}

// Map the provider-specific discovery payload to ByokModel[]. Capabilities
// come from inferLocalModelCapabilities — see that function for the family
// matrix. The user can override per-model via the "Other model" capability
// checkboxes if our heuristic is wrong for their specific build.
function parseLocalModels(providerId: string, data: Record<string, unknown>): ByokModel[] {
  const buildModel = (id: string): ByokModel => {
    const inferred = inferLocalModelCapabilities(id)
    return {
      id,
      label: id,
      capabilities: inferred.capabilities,
      contextWindow: 0,
      supportsThinking: inferred.supportsThinking,
    }
  }

  if (providerId === 'ollama') {
    const list = Array.isArray(data.models) ? data.models : []
    return list
      .map((m: unknown): ByokModel | null => {
        if (!m || typeof m !== 'object') return null
        const obj = m as Record<string, unknown>
        const id = typeof obj.name === 'string' ? obj.name : null
        return id ? buildModel(id) : null
      })
      .filter((x): x is ByokModel => x !== null)
  }
  if (providerId === 'lm-studio') {
    const list = Array.isArray(data.data) ? data.data : []
    return list
      .map((m: unknown): ByokModel | null => {
        if (!m || typeof m !== 'object') return null
        const obj = m as Record<string, unknown>
        const id = typeof obj.id === 'string' ? obj.id : null
        return id ? buildModel(id) : null
      })
      .filter((x): x is ByokModel => x !== null)
  }
  return []
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
  /** Set the user-declared context window (tokens) for a provider's BYOK model.
   *  Drives auto-compact under BYOK (the worker is bypassed, so no
   *  X-Model-Context-Window header). Persisted. */
  setContextWindow: (providerId: string, contextWindow: number | undefined) => void
  setReasoningEffort: (providerId: string, effort: ByokReasoningEffort | undefined) => void
  testKey: (
    providerId: string,
    modelId: string,
    keyOverride?: string,
    baseURLOverride?: string,
  ) => Promise<TestKeyResult>
  toggle: (enabled: boolean) => void
  setActive: (providerId: string | null, modelId: string | null) => void
  markUsed: (providerId: string) => void
  /** Mark a local provider as configured/unconfigured. Local providers don't
   *  have a key, so `hasKey` is meaningless — `configured` is what gates
   *  whether resolveActive returns them. Cloud providers should ignore this. */
  markConfigured: (providerId: string, configured: boolean) => void
  /** Read every local-provider's catalog from the cross-project disk
   *  cache (~/.toquemedia-studio/byok-dynamic-cache.json) and seed the
   *  in-memory `perProviderConfig.{provider}.dynamicCatalog` entries.
   *  Idempotent — only overwrites entries older than the cached one. */
  hydrateLocalModelsFromCache: () => Promise<void>
  /** Hit the local provider's discovery endpoint and populate dynamicCatalog.
   *  Returns the resolved model list (or null on failure with the error
   *  surfaced via toast/UI by the caller). */
  refreshLocalModels: (providerId: string) => Promise<ByokModel[] | null>
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
        // Catalog is hardcoded in the IDE — BYOK is IDE → provider DIRECT, so
        // there is NO server `/v1/byok/providers` fetch (and no Firestore
        // override). Cloud first, then local; Custom/Anthropic carry
        // group:'custom'. Local providers are always present for offline use.
        const providers: ByokProvider[] = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS]

        const config = { ...get().perProviderConfig }
        for (const provider of providers) {
          if (provider.local) {
            // Local: ensure a config entry exists so the UI renders the baseURL
            // field. hasKey stays false; `configured` persists from localStorage.
            if (!config[provider.id]) config[provider.id] = { hasKey: false }
            continue
          }
          // Cloud: refresh hasKey from the keychain (source of truth — a
          // persisted hasKey can go stale after a manual key delete).
          const existing = config[provider.id] || { hasKey: false }
          try {
            const present = await invoke<boolean>('byok_has_key', { provider: provider.id })
            config[provider.id] = { ...existing, hasKey: present }
          } catch (err) {
            console.warn(`[byok] byok_has_key(${provider.id}) failed:`, err)
          }
        }

        set({ providers, perProviderConfig: config, catalogLoaded: true })
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
        // Capture the last 4 chars as a visual hint for the Settings UI
        // (sk-...abcd). The key itself stays in the keychain; this hint is
        // a memory aid only. Trim defensive: callers should pass already
        // trimmed but we don't want " abcd" hints from sloppy paste.
        const trimmed = key.trim()
        const keyHint = trimmed.length >= 4 ? trimmed.slice(-4) : undefined
        // Setting a key implicitly configures the provider — covers the
        // optional-auth case for local providers (LM Studio behind a private
        // gateway, Ollama with a header rewriter).
        config[providerId] = { ...(config[providerId] || { hasKey: false }), hasKey: true, configured: true, keyHint }
        set({ perProviderConfig: config })
        syncActiveSessionSnapshot()
      },

      deleteKey: async (providerId) => {
        await invoke('byok_delete_key', { provider: providerId })
        const config = { ...get().perProviderConfig }
        const provider = get().providers.find(p => p.id === providerId)
        // Local providers without auth: deleting "the key" only clears the
        // hasKey flag — `configured` stays so the user doesn't lose their
        // baseURL setup. Cloud providers: drop both — there's nothing left.
        const stillConfigured = provider?.local === true
          ? (config[providerId]?.configured === true)
          : false
        config[providerId] = {
          ...(config[providerId] || { hasKey: false }),
          hasKey: false,
          configured: stillConfigured,
          keyHint: undefined,
        }
        // If this was the active provider AND it's no longer reachable
        // (cloud, or local that lost its configured flag), deactivate.
        const next: Partial<ByokState> = { perProviderConfig: config }
        if (get().activeProvider === providerId && !stillConfigured) {
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

      setContextWindow: (providerId, contextWindow) => {
        const config = { ...get().perProviderConfig }
        const existing = config[providerId] || { hasKey: false }
        config[providerId] = { ...existing, contextWindow }
        set({ perProviderConfig: config })
        // Re-capture the active session snapshot so the new window takes effect
        // for the current conversation's auto-compact immediately.
        syncActiveSessionSnapshot()
      },

      setReasoningEffort: (providerId, effort) => {
        const config = { ...get().perProviderConfig }
        const existing = config[providerId] || { hasKey: false }
        config[providerId] = { ...existing, reasoningEffort: effort }
        set({ perProviderConfig: config })
        syncActiveSessionSnapshot()
      },

      testKey: async (providerId, modelId, keyOverride, baseURLOverride) => {
        const provider = get().providers.find(p => p.id === providerId)
        if (!provider) return { valid: false, error: `Unknown provider: ${providerId}` }

        // Local providers: the worker can't reach the user's localhost. Hit
        // the discovery endpoint directly; success means the server is up
        // and reachable from the WebView. Latency is measured from the
        // tauriFetch round-trip (Rust HTTP client, no CORS).
        if (provider?.local) {
          const baseURL = (baseURLOverride ?? get().perProviderConfig[providerId]?.baseURL ?? provider.defaultBaseURL).replace(/\/$/, '')
          const path = LOCAL_DISCOVERY_PATH[providerId]
          if (!path) return { valid: false, error: `Discovery endpoint unknown for ${providerId}` }
          const start = Date.now()
          try {
            const res = await tauriFetch(`${baseURL}${path}`, { timeoutSecs: 5 })
            const latencyMs = Date.now() - start
            if (!res.ok) {
              return { valid: false, latencyMs, statusCode: res.status, error: `Local server returned ${res.status}` }
            }
            return { valid: true, latencyMs }
          } catch (err) {
            return {
              valid: false,
              error: err instanceof Error
                ? `Cannot reach ${baseURL}: ${err.message}. Is the server running?`
                : String(err),
            }
          }
        }

        try {
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

          const url = buildDirectValidationURL(
            provider,
            baseURLOverride ?? get().perProviderConfig[providerId]?.baseURL,
          )
          if (!url) return { valid: false, error: 'Base URL is required for this provider' }
          const startedAt = Date.now()
          const res = await tauriFetch(url, {
            method: 'POST',
            headers: buildDirectValidationHeaders(provider, key),
            body: JSON.stringify(buildDirectValidationBody(provider, modelId)),
            timeoutSecs: 20,
          })
          const latencyMs = Date.now() - startedAt

          if (res.ok) return { valid: true, latencyMs }

          const text = await res.text().catch(() => '')
          return {
            valid: false,
            latencyMs,
            statusCode: res.status,
            error: text.slice(0, 300) || `Provider returned ${res.status}`,
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

      markConfigured: (providerId, configured) => {
        const config = { ...get().perProviderConfig }
        const existing = config[providerId] || { hasKey: false }
        config[providerId] = { ...existing, configured }
        // If un-configuring an active local provider, deactivate so requests
        // don't try to route to a provider the user just disowned.
        const next: Partial<ByokState> = { perProviderConfig: config }
        if (!configured && get().activeProvider === providerId) {
          next.activeProvider = null
          next.activeModel = null
        }
        set(next as ByokState)
        syncActiveSessionSnapshot()
      },

      refreshLocalModels: async (providerId) => {
        const provider = get().providers.find(p => p.id === providerId)
        if (!provider || !provider.local) return null

        const baseURL = (get().perProviderConfig[providerId]?.baseURL || provider.defaultBaseURL).replace(/\/$/, '')
        const path = LOCAL_DISCOVERY_PATH[providerId]
        if (!path) {
          console.warn(`[byok] no discovery path registered for ${providerId}`)
          return null
        }

        try {
          const res = await tauriFetch(`${baseURL}${path}`, { timeoutSecs: 5 })
          if (!res.ok) {
            console.warn(`[byok] refreshLocalModels(${providerId}) HTTP ${res.status}`)
            return null
          }
          const data = await res.json() as Record<string, unknown>
          const models = parseLocalModels(providerId, data)

          const config = { ...get().perProviderConfig }
          const existing = config[providerId] || { hasKey: false }
          config[providerId] = {
            ...existing,
            dynamicCatalog: { fetchedAt: Date.now(), models },
          }
          set({ perProviderConfig: config })
          // Write through to the cross-project disk cache (TTL 30min).
          // Lets the NEXT IDE launch skip the discovery round-trip and
          // hit the cache while the in-memory state is empty. Fire-and-
          // forget — the network refresh already succeeded.
          void import('../services/byokDynamicCachePersistence').then(({ saveByokDynamicCache }) =>
            saveByokDynamicCache(providerId, models),
          ).catch(() => { /* persistence best-effort */ })
          return models
        } catch (err) {
          console.warn(`[byok] refreshLocalModels(${providerId}) failed:`, err)
          return null
        }
      },

      hydrateLocalModelsFromCache: async () => {
        // Called at module init time AND on Settings open. Reads the
        // disk cache (entries within 30min TTL) and seeds the in-memory
        // store. Doesn't replace `refreshLocalModels` — callers are
        // expected to schedule a background refresh anyway to catch any
        // model the user pulled since the cache was last written.
        const { loadByokDynamicCache } = await import('../services/byokDynamicCachePersistence')
        const cache = await loadByokDynamicCache()
        const entries = Object.entries(cache)
        if (entries.length === 0) return
        const config = { ...get().perProviderConfig }
        let touched = false
        for (const [providerId, entry] of entries) {
          const existing = config[providerId] || { hasKey: false }
          // Only seed if the in-memory store has nothing fresher. Avoids
          // overwriting a refresh that already landed since boot.
          if (!existing.dynamicCatalog || existing.dynamicCatalog.fetchedAt < entry.fetchedAt) {
            config[providerId] = { ...existing, dynamicCatalog: entry }
            touched = true
          }
        }
        if (touched) set({ perProviderConfig: config })
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

        // Local providers must be explicitly marked configured (the user
        // confirmed the local server is reachable). Cloud providers don't
        // have this gate — the implicit signal is hasKey, enforced by the
        // agentService BYOK_KEY_MISSING path.
        if (provider.local && !config?.configured) return null

        const userDefined = config?.userDefinedModel
        const registryModel = provider.models.find(m => m.id === activeModel)
        const dynamicModel = config?.dynamicCatalog?.models.find(m => m.id === activeModel)
        const baseURL = (config?.baseURL || provider.defaultBaseURL).replace(/\/$/, '')

        // Resolution paths, in order:
        //   1. Catalog hit (server-curated)
        //   2. Dynamic catalog hit (local discovery — Ollama /api/tags, LM Studio /v1/models)
        //   3. User-defined "other model" — capabilities user-declared
        //   4. Custom provider with free-text model
        if (registryModel) {
          return { provider, model: registryModel, baseURL }
        }
        if (dynamicModel) {
          return { provider, model: dynamicModel, baseURL }
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
        if (provider.custom || provider.local) {
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
      // `dynamicCatalog` (local model lists) is also stripped — the user
      // can pull/delete models via CLI between launches, so we refetch.
      partialize: (state) => ({
        enabled: state.enabled,
        activeProvider: state.activeProvider,
        activeModel: state.activeModel,
        perProviderConfig: Object.fromEntries(
          Object.entries(state.perProviderConfig).map(([id, cfg]) => {
            const { dynamicCatalog: _drop, ...rest } = cfg
            return [id, rest]
          }),
        ),
      }),
    },
  ),
)
