import { HttpError } from './errors'
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
  'web_search': 'sidecar:web_search',
  'vision': 'sidecar:vision',
  'fim': 'sidecar:fim',
  'memory-extractor': 'sidecar:utility',
  'memory-selector': 'sidecar:utility',
  'memory-distiller': 'sidecar:utility',
  'summarize': 'sidecar:utility',
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

  return {
    provider: assertString(obj.provider, 'provider'),
    model: assertString(obj.model, 'model'),
    speedModel,
    baseUrl: assertString(obj.baseUrl, 'baseUrl').replace(/\/+$/, ''),
    chatCompletionsPath: assertString(obj.chatCompletionsPath, 'chatCompletionsPath'),
    authHeader: assertString(obj.authHeader, 'authHeader'),
    authScheme,
    apiKeyEnv: assertString(obj.apiKeyEnv, 'apiKeyEnv'),
    enabled,
    extraBody,
    contextWindow,
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
  if (sidecarKey && env.ACTIVE_AI_CONFIG) {
    const cached = configCache.get(sidecarKey)
    if (cached && cached.expiresAt > now) return cached.value

    const raw = await env.ACTIVE_AI_CONFIG.get(sidecarKey)
    if (raw) {
      try {
        const config = parseActiveConfig(raw)
        if (config.enabled) {
          const resolved: ResolvedActiveAIConfig = { config, source: 'kv', key: sidecarKey }
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

export function buildUpstreamUrl(config: ActiveAIConfig): string {
  const path = config.chatCompletionsPath.startsWith('/')
    ? config.chatCompletionsPath
    : `/${config.chatCompletionsPath}`
  return `${config.baseUrl}${path}`
}
