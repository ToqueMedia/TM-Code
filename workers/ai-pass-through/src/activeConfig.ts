import { HttpError } from './errors'
import { decryptSecret } from './byokCrypto'
import type { ActiveAIConfig, Env, ResolvedActiveAIConfig } from './types'

const CONFIG_CACHE_MS = 5_000

let configCache = new Map<string, { value: ResolvedActiveAIConfig; expiresAt: number }>()

export function clearActiveConfigCache(): void {
  configCache = new Map()
}

// ── Sidecars ──────────────────────────────────────────────────────────────
//
// O proxy antigo roteava por X-Request-Type para modelos baratos/especiali-
// zados; a migração para o pass-through deixou esses headers a apontar para
// o vazio (web_search a 404, memory-* a pagar preço de flagship no modelo
// ativo, visão inexistente — análise 2026-06-12). Este mapa restaura o
// mecanismo de forma config-driven: cada tipo aponta para uma config no KV
// (`sidecar:*`, mesmo schema da ativa, publicada pelo admin). Sidecar
// ausente/inválido/desativado → degrada SILENCIOSAMENTE para a config ativa
// — o chat nunca parte por causa de um sidecar; o cliente distingue pelo
// header X-TM-Config-Key da resposta.

const REQUEST_TYPE_TO_SIDECAR_KEY: Record<string, string> = {
  // 'utility' é o tipo genérico que os serviços one-shot da IDE já enviam
  // (promptImprovementService) — estava FORA do mapa, logo caía no fallback
  // silencioso e pagava preço de flagship na config ativa (achado 04-08).
  'utility': 'sidecar:utility',
  'web_search': 'sidecar:web_search',
  'vision': 'sidecar:vision',
  'fim': 'sidecar:fim',
  'memory-extractor': 'sidecar:utility',
  'memory-selector': 'sidecar:utility',
  'memory-distiller': 'sidecar:utility',
  'summarize': 'sidecar:utility',
  // intent-router e context-planner SAÍRAM do mapa (decisão 2026-08-04): o
  // cliente nunca os enviou (o dispatch usa heurística local, "Intent (sem
  // router)") e a decisão de produto é não os ligar. Se um dia voltarem,
  // lembrar que o context-planner era STRICT (503 sem sidecar) — ver
  // git blame deste bloco e o strictSidecarRequestType no index.ts.
}

// Fallback de env por sidecar — espelho exacto do par KV/env da `active`
// (kvRaw || envRaw, KV ganha). Motivo: em `wrangler dev` o KV é simulação
// local vazia e não há caminho de admin para publicar sidecars — sem isto o
// dev local NUNCA exercita um sidecar, e o gap ficava invisível até prod.
const SIDECAR_ENV_FALLBACK: Record<string, keyof Env> = {
  'sidecar:utility': 'SIDECAR_UTILITY_CONFIG_JSON',
  'sidecar:vision': 'SIDECAR_VISION_CONFIG_JSON',
  'sidecar:web_search': 'SIDECAR_WEB_SEARCH_CONFIG_JSON',
  'sidecar:fim': 'SIDECAR_FIM_CONFIG_JSON',
}

export function sidecarKeyForRequestType(requestType: string | null): string | null {
  if (!requestType) return null
  return REQUEST_TYPE_TO_SIDECAR_KEY[requestType.trim().toLowerCase()] ?? null
}

function assertString(value: unknown, field: keyof ActiveAIConfig): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(500, 'tm_active_config_invalid', `Active AI config field "${field}" is required.`)
  }
  return value.trim()
}

function parseActiveConfig(raw: string): ActiveAIConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(500, 'tm_active_config_invalid', 'Active AI config is not valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(500, 'tm_active_config_invalid', 'Active AI config must be an object.')
  }

  const obj = parsed as Record<string, unknown>
  const authScheme = obj.authScheme === 'Bearer' || obj.authScheme === 'none' || obj.authScheme === 'google_oauth'
    ? obj.authScheme
    : null

  if (!authScheme) {
    throw new HttpError(500, 'tm_active_config_invalid', 'Active AI config authScheme must be "Bearer", "none" or "google_oauth".')
  }

  const enabled = obj.enabled
  if (typeof enabled !== 'boolean') {
    throw new HttpError(500, 'tm_active_config_invalid', 'Active AI config enabled must be boolean.')
  }

  const speedModel = typeof obj.speedModel === 'string' && obj.speedModel.trim() !== ''
    ? obj.speedModel.trim()
    : undefined

  // Campos extra de request do provider (ex.: DashScope enable_search para
  // a pesquisa nativa do Qwen). Só objetos planos são aceites.
  const extraBody = obj.extraBody && typeof obj.extraBody === 'object' && !Array.isArray(obj.extraBody)
    ? obj.extraBody as Record<string, unknown>
    : undefined

  // Janela de contexto real do modelo, emitida em X-Model-Context-Window.
  // Opcional: aceita number positivo finito; qualquer outra coisa → undefined
  // (a IDE cai no fallback de perfil). Tolerante de propósito — uma config
  // sem o campo nunca deve falhar o pedido.
  const contextWindow = typeof obj.contextWindow === 'number'
    && Number.isFinite(obj.contextWindow) && obj.contextWindow > 0
    ? Math.floor(obj.contextWindow)
    : undefined

  // Teto de saída do modelo, emitido em X-Model-Max-Output-Tokens. Mesma
  // tolerância do contextWindow: ausente/inválido → undefined e a IDE usa o
  // perfil local.
  const maxOutputTokens = typeof obj.maxOutputTokens === 'number'
    && Number.isFinite(obj.maxOutputTokens) && obj.maxOutputTokens > 0
    ? Math.floor(obj.maxOutputTokens)
    : undefined

  // Capacidades do modelo, emitidas em X-Model-Capabilities.
  //
  // PORQUÊ (auditoria 2026-07-29): a IDE tem uma tabela MODEL_PROFILES cozida
  // e, para um modelo desconhecido, herdava as flags de OUTRO modelo (o perfil
  // do plano). Num desenho em que "adicionar um modelo é editar a KV, não o
  // código", isso significa que publicar um modelo novo lhe atribuía silen-
  // ciosamente a visão, o pensamento e a pesquisa do modelo anterior — imagens
  // enviadas a quem não as lê, thinking imposto a quem não o suporta. Os dois
  // campos numéricos (contextWindow/maxOutputTokens) já vinham por aqui; estas
  // são as que faltavam. Mesma tolerância: ausente → undefined, e a IDE cai no
  // perfil local em vez de falhar o pedido.
  const readCapability = (key: string): boolean | undefined =>
    typeof (obj as Record<string, unknown>)[key] === 'boolean'
      ? (obj as Record<string, unknown>)[key] as boolean
      : undefined
  const capabilities = {
    vision: readCapability('supportsVision'),
    search: readCapability('supportsSearch'),
    thinking: typeof obj.thinkingMode === 'string'
      && ['toggleable', 'mandatory', 'none'].includes(obj.thinkingMode)
      ? obj.thinkingMode as 'toggleable' | 'mandatory' | 'none'
      : undefined,
  }
  const hasCapabilities = capabilities.vision !== undefined
    || capabilities.search !== undefined
    || capabilities.thinking !== undefined

  return {
    provider: assertString(obj.provider, 'provider'),
    model: assertString(obj.model, 'model'),
    capabilities: hasCapabilities ? capabilities : undefined,
    speedModel,
    baseUrl: assertString(obj.baseUrl, 'baseUrl').replace(/\/+$/, ''),
    chatCompletionsPath: assertString(obj.chatCompletionsPath, 'chatCompletionsPath'),
    authHeader: assertString(obj.authHeader, 'authHeader'),
    authScheme,
    apiKeyEnv: assertString(obj.apiKeyEnv, 'apiKeyEnv'),
    enabled,
    extraBody,
    contextWindow,
    maxOutputTokens,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
  }
}

export async function getActiveConfig(env: Env, now = Date.now()): Promise<ResolvedActiveAIConfig> {
  const key = env.ACTIVE_AI_CONFIG_KEY || 'active'
  const cached = configCache.get(key)
  if (cached && cached.expiresAt > now) return cached.value

  const kvRaw = env.ACTIVE_AI_CONFIG ? await env.ACTIVE_AI_CONFIG.get(key) : null
  const envRaw = typeof env.ACTIVE_AI_CONFIG_JSON === 'string' ? env.ACTIVE_AI_CONFIG_JSON : null
  const source: ResolvedActiveAIConfig['source'] = kvRaw ? 'kv' : 'env'
  const raw = kvRaw || envRaw

  if (!raw) {
    throw new HttpError(503, 'tm_active_config_missing', 'Active AI provider config is not published.')
  }

  const config = parseActiveConfig(raw)
  if (!config.enabled) {
    throw new HttpError(503, 'tm_active_config_disabled', 'Active AI provider config is disabled.')
  }

  const resolved = { config, source, key }
  configCache.set(key, { value: resolved, expiresAt: now + CONFIG_CACHE_MS })
  return resolved
}

/**
 * Resolve a config para um pedido: sidecar publicado para o X-Request-Type
 * quando existe e está ativo, senão a config ativa. Sidecar com JSON
 * inválido ou disabled NUNCA propaga erro — degrada para a ativa com um
 * warn nos logs (um sidecar mal publicado não pode partir o produto).
 */
export async function getConfigForRequest(
  env: Env,
  requestType: string | null,
  now = Date.now(),
): Promise<ResolvedActiveAIConfig> {
  const sidecarKey = sidecarKeyForRequestType(requestType)
  if (sidecarKey) {
    const cached = configCache.get(sidecarKey)
    if (cached && cached.expiresAt > now) return cached.value

    const kvRaw = env.ACTIVE_AI_CONFIG ? await env.ACTIVE_AI_CONFIG.get(sidecarKey) : null
    const envVar = SIDECAR_ENV_FALLBACK[sidecarKey]
    const envRaw = envVar && typeof env[envVar] === 'string' ? (env[envVar] as string) : null
    const raw = kvRaw || envRaw
    if (raw) {
      try {
        const config = parseActiveConfig(raw)
        if (config.enabled) {
          const resolved: ResolvedActiveAIConfig = { config, source: kvRaw ? 'kv' : 'env', key: sidecarKey }
          configCache.set(sidecarKey, { value: resolved, expiresAt: now + CONFIG_CACHE_MS })
          return resolved
        }
      } catch (error) {
        console.warn(`[ai-pass-through] sidecar config ${sidecarKey} invalid, falling back to active:`, error)
      }
    }
  }
  return getActiveConfig(env, now)
}

// ── Team BYOK (`team:{teamId}`) ─────────────────────────────────────────────
//
// Same shape as the managed active config, but the provider key is carried
// INLINE (`apiKey`) — team keys are per-team and dynamic, so they can't be
// worker env secrets like the managed `active`/`sidecar:*` configs. The
// control-plane publishes `team:{teamId}` to this KV when a team admin enables
// BYOK; the data-plane routes the team's MAIN model to it (sidecars stay TM
// infra) and skips TM metering (the team pays the provider directly).
//
// Supports Bearer (OpenAI-compat: Gemini AI Studio, DashScope, Custom) AND
// google_oauth (Vertex AI — the inline encrypted apiKey carries the service
// account JSON; buildUpstreamHeaders mints an OAuth token per request).
// Anthropic (apiShape) still needs the worker-side adapter (deferred).

function parseTeamByokConfig(raw: string): ActiveAIConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(500, 'tm_team_byok_invalid', 'Team BYOK config is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(500, 'tm_team_byok_invalid', 'Team BYOK config must be an object.')
  }
  const obj = parsed as Record<string, unknown>
  const apiKey = typeof obj.apiKey === 'string' && obj.apiKey.trim() !== '' ? obj.apiKey.trim() : undefined
  // Virtual shared budget (tokens). 0/absent → pass-through (no metering).
  const pool = typeof obj.pool === 'number' && Number.isFinite(obj.pool) && obj.pool > 0
    ? Math.floor(obj.pool)
    : undefined
  // The strict parser requires apiKeyEnv; for an inline-key team config inject a
  // placeholder so ALL other validation (provider/model/baseUrl/authScheme/…)
  // is reused verbatim instead of duplicated.
  if (apiKey && (typeof obj.apiKeyEnv !== 'string' || obj.apiKeyEnv.trim() === '')) {
    obj.apiKeyEnv = '__team_inline__'
  }
  const base = parseActiveConfig(JSON.stringify(obj))
  return { ...base, ...(apiKey ? { apiKey } : {}), ...(pool ? { pool } : {}) }
}

export async function getTeamByokConfig(
  env: Env,
  teamId: string,
  now = Date.now(),
): Promise<ResolvedActiveAIConfig | null> {
  if (!env.ACTIVE_AI_CONFIG || !teamId) return null
  const key = `team:${teamId}`
  const cached = configCache.get(key)
  if (cached && cached.expiresAt > now) return cached.value

  let raw: string | null = null
  try {
    raw = await env.ACTIVE_AI_CONFIG.get(key)
  } catch {
    return null // KV read failure → degrade to managed config; never break chat.
  }
  if (!raw) return null

  try {
    const config = parseTeamByokConfig(raw)
    // Bearer (OpenAI-compat) AND google_oauth (Vertex) are both supported: for
    // Vertex the inline (encrypted) `apiKey` carries the service-account JSON,
    // from which buildUpstreamHeaders mints an OAuth token per request.
    if (!config.enabled) return null
    // The team key is stored AES-GCM-encrypted; decrypt with the shared
    // TEAM_BYOK_ENC_KEY (the control-plane encrypted it on publish). Missing
    // secret or a decrypt failure → degrade to the managed model rather than
    // route with a broken/garbled key.
    if (config.apiKey) {
      if (!env.TEAM_BYOK_ENC_KEY) {
        console.warn(`[ai-pass-through] team byok ${key}: TEAM_BYOK_ENC_KEY missing — ignoring`)
        return null
      }
      try {
        config.apiKey = await decryptSecret(config.apiKey, env.TEAM_BYOK_ENC_KEY)
      } catch (e) {
        console.warn(`[ai-pass-through] team byok ${key}: key decrypt failed — ignoring:`, e)
        return null
      }
    }
    const resolved: ResolvedActiveAIConfig = { config, source: 'kv', key }
    configCache.set(key, { value: resolved, expiresAt: now + CONFIG_CACHE_MS })
    return resolved
  } catch (error) {
    console.warn(`[ai-pass-through] team byok config ${key} invalid, ignoring:`, error)
    return null
  }
}

export function buildUpstreamUrl(config: ActiveAIConfig): string {
  const path = config.chatCompletionsPath.startsWith('/')
    ? config.chatCompletionsPath
    : `/${config.chatCompletionsPath}`
  return `${config.baseUrl}${path}`
}
