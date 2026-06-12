import { HttpError } from './errors'
import type { ActiveAIConfig, Env, ResolvedActiveAIConfig } from './types'

const CONFIG_CACHE_MS = 5_000

let cachedConfig: { value: ResolvedActiveAIConfig; expiresAt: number } | null = null

export function clearActiveConfigCache(): void {
  cachedConfig = null
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
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
  }
}

export async function getActiveConfig(env: Env, now = Date.now()): Promise<ResolvedActiveAIConfig> {
  if (cachedConfig && cachedConfig.expiresAt > now) return cachedConfig.value

  const key = env.ACTIVE_AI_CONFIG_KEY || 'active'
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
  cachedConfig = { value: resolved, expiresAt: now + CONFIG_CACHE_MS }
  return resolved
}

export function buildUpstreamUrl(config: ActiveAIConfig): string {
  const path = config.chatCompletionsPath.startsWith('/')
    ? config.chatCompletionsPath
    : `/${config.chatCompletionsPath}`
  return `${config.baseUrl}${path}`
}
