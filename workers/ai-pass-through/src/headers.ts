import type { ActiveAIConfig, Env, Fetcher } from './types'
import { cleanSecret } from './secrets'
import { HttpError } from './errors'
import { mintAccessToken, OAUTH_SCOPE_CLOUD_PLATFORM } from './googleAuth'

const DEFAULT_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'X-Firebase-AppCheck',
  'X-Request-Type',
  'X-TM-Speed',
  'X-TM-Reasoning-Effort',
  'X-TM-Persona',
  'X-Conversation-Id',
  'x-app',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-retry-count',
  'x-stainless-timeout',
  'x-stainless-helper-method',
].join(', ')

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export function buildCorsHeaders(request: Request): Headers {
  const headers = new Headers()
  const origin = request.headers.get('origin') || '*'
  const requestedHeaders = request.headers.get('access-control-request-headers')

  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', 'POST, OPTIONS')
  headers.set('access-control-allow-headers', requestedHeaders || DEFAULT_ALLOWED_HEADERS)
  headers.set('access-control-expose-headers', [
    'X-TM-Request-Id',
    'X-TM-Provider',
    'X-TM-Model',
    // Janela de contexto real do modelo ativo — consumida por
    // applyStreamingResponseHeaders na IDE (agentStore.modelContextWindow).
    // Sem este nome no expose-list, o browser não consegue LER o header
    // cross-origin mesmo que seja enviado.
    'X-Model-Context-Window',
    'X-Model-Max-Output-Tokens',
    'X-Model-Capabilities',
    'X-TM-Speed-Applied',
    'X-TM-Upstream-Status',
    'X-TM-Config-Source',
    'X-TM-Config-Key',
    // Team BYOK: a equipa serviu pelo seu próprio provedor/chave — a IDE mostra
    // o indicador "Team BYOK" e sabe que não há metering da TM neste pedido.
    'X-TM-Team-Byok',
    // Billing — consumidos por billingStore.updateFromHeaders na IDE.
    'X-Plan',
    'X-Budget-Status',
    'X-Budget-Pct',
    'X-Tokens-Consumed',
    'X-Extra-Tokens',
    'X-Cycle-End',
    // Contexto de equipa (§3.5) — a IDE enquadra "fatia/bolo" + CTA de bloqueio.
    'X-Team-Id',
    'X-Team-Tier',
    'X-Slice-Tokens',
    'X-Pie-Total',
    'Retry-After',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
  ].join(', '))
  headers.set('access-control-max-age', '86400')
  headers.set('vary', 'Origin, Access-Control-Request-Headers')
  return headers
}

export function corsPreflight(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request),
  })
}

export function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of buildCorsHeaders(request)) {
    headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function shouldForwardRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (HOP_BY_HOP_HEADERS.has(lower)) return false
  if (lower === 'authorization') return false
  if (lower === 'cookie') return false
  if (lower.startsWith('cf-')) return false
  if (lower.startsWith('x-tm-')) return false
  return lower === 'content-type' || lower === 'accept' || lower === 'accept-encoding'
}

export async function buildUpstreamHeaders(
  request: Request,
  config: ActiveAIConfig,
  env: Env,
  fetcher: Fetcher,
): Promise<{
  headers: Headers
  providerKey: string
}> {
  const headers = new Headers()
  for (const [name, value] of request.headers) {
    if (shouldForwardRequestHeader(name)) headers.set(name, value)
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  headers.delete('authorization')

  // Vertex AI (google_oauth): não existe API key estática — `apiKeyEnv`
  // aponta para o JSON completo da service account e o token OAuth2 é
  // mintado aqui (cache ~55 min em googleAuth.ts, por isso o custo do
  // round-trip ao oauth2.googleapis.com é ~1×/hora/isolate). O providerKey
  // devolvido para logging é o client_email — nunca o token.
  if (config.authScheme === 'google_oauth') {
    // Team BYOK (Vertex) carries the service-account JSON inline (decrypted);
    // managed configs read it from env[apiKeyEnv]. Inline wins.
    const raw = config.apiKey ?? env[config.apiKeyEnv]
    let sa: { client_email?: string; private_key?: string } | null = null
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        sa = JSON.parse(raw) as { client_email?: string; private_key?: string }
      } catch {
        sa = null
      }
    }
    if (!sa?.client_email || !sa?.private_key) {
      throw new HttpError(500, 'tm_provider_secret_missing', 'Active provider service account is not configured.')
    }
    let token: string
    try {
      token = await mintAccessToken(sa.client_email, sa.private_key, fetcher, OAUTH_SCOPE_CLOUD_PLATFORM)
    } catch (error) {
      console.error('[ai-pass-through] google_oauth token mint failed:', error)
      throw new HttpError(502, 'tm_provider_auth_failed', 'Unable to authenticate with the active AI provider.')
    }
    headers.set(config.authHeader, `Bearer ${token}`)
    return { headers, providerKey: sa.client_email }
  }

  // Team BYOK carries the key inline (per-team, dynamic — not a worker env
  // secret); managed configs always resolve from env[apiKeyEnv]. Inline wins.
  const providerKey = cleanSecret(config.apiKey ?? env[config.apiKeyEnv], config.authScheme)
  if (!providerKey) {
    throw new HttpError(500, 'tm_provider_secret_missing', 'Active provider API key is not configured.')
  }

  if (config.authScheme === 'Bearer') {
    headers.set(config.authHeader, `Bearer ${providerKey}`)
  } else {
    headers.set(config.authHeader, providerKey)
  }

  return { headers, providerKey }
}

export interface BudgetHeaderMeta {
  plan: string
  status: string
  consumedPct: number
  tokensConsumed: number
  extraUsageBalance: number
  cycleEnd: string
  /** Contexto de EQUIPA (§3.5): presente só quando o user é membro de uma
   *  equipa. `plan` continua a ser o plano-BASE (team-pro→pro); o tier cru e a
   *  pie/fatia em tokens vão aqui, para a IDE enquadrar "a tua fatia / o bolo". */
  team?: { teamId: string; tier: string; sliceTokens: number; pieTotal: number }
}

export function buildResponseHeaders(upstream: Response, meta: {
  requestId: string
  provider: string
  model: string
  speedApplied: boolean
  configSource: 'kv' | 'env'
  configKey: string
  /** Team BYOK serviu este pedido (config `team:{teamId}`). Emite
   *  X-TM-Team-Byok para a IDE indicar e saber que não houve metering da TM. */
  teamByok?: boolean
  /** Janela de contexto (tokens) do modelo ativo, vinda da config KV. Ausente
   *  → o header não é emitido e a IDE cai no fallback de perfil local. */
  contextWindow?: number
  /** Teto de tokens de SAÍDA do modelo ativo, vindo da config KV. Mesma
   *  semântica de ausência do contextWindow. */
  maxOutputTokens?: number
  /** Capacidades do modelo ativo, vindas da config KV. Mesma semântica de
   *  ausência: sem elas a IDE fica com o perfil local. */
  capabilities?: { vision?: boolean; search?: boolean; thinking?: 'toggleable' | 'mandatory' | 'none' }
  /** Estado de billing pré-voo (ausente quando o lookup falhou ou billing off). */
  budget?: BudgetHeaderMeta
}): Headers {
  const headers = new Headers()
  const contentType = upstream.headers.get('content-type')
  const retryAfter = upstream.headers.get('retry-after')

  if (contentType) headers.set('content-type', contentType)
  if (retryAfter) headers.set('retry-after', retryAfter)

  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase()
    if (
      lower.startsWith('x-ratelimit-') ||
      lower.startsWith('ratelimit-') ||
      lower === 'retry-after'
    ) {
      headers.set(name, value)
    }
  }

  headers.set('x-tm-request-id', meta.requestId)
  headers.set('x-tm-provider', meta.provider)
  headers.set('x-tm-model', meta.model)
  headers.set('x-tm-speed-applied', meta.speedApplied ? 'true' : 'false')
  headers.set('x-tm-upstream-status', String(upstream.status))
  headers.set('x-tm-config-source', meta.configSource)
  headers.set('x-tm-config-key', meta.configKey)
  // Always emitted (true/false) so the IDE can clear a stale flag when a later
  // turn is served by the managed path again.
  headers.set('x-tm-team-byok', meta.teamByok ? 'true' : 'false')
  // Janela de contexto real — só quando a config a declara. A IDE usa-a como
  // denominador autoritativo da pressão de contexto E do gatilho de
  // auto-compactação (substitui a adivinha da tabela de perfis local).
  if (typeof meta.contextWindow === 'number' && meta.contextWindow > 0) {
    headers.set('x-model-context-window', String(meta.contextWindow))
  }
  // Teto de SAÍDA — o irmão que faltava. Sem ele a IDE usava o perfil local e
  // um modelo novo publicado só no KV ficava calado no teto do fallback (32K),
  // que é também o teto da escalada anti-truncagem do loop.
  if (typeof meta.maxOutputTokens === 'number' && meta.maxOutputTokens > 0) {
    headers.set('x-model-max-output-tokens', String(meta.maxOutputTokens))
  }
  // CAPACIDADES — o terceiro irmão. Sem elas, a IDE atribuía a um modelo
  // desconhecido as flags do perfil de FALLBACK: visão, pensamento e pesquisa
  // de outro modelo. Formato `k=v;k=v` para caber num header e crescer sem
  // quebrar o parser do cliente (chaves desconhecidas são ignoradas lá).
  // Só as chaves DECLARADAS são emitidas: silêncio significa "não sei", que é
  // diferente de "não suporta".
  if (meta.capabilities) {
    const parts: string[] = []
    if (typeof meta.capabilities.vision === 'boolean') parts.push(`vision=${meta.capabilities.vision ? 1 : 0}`)
    if (typeof meta.capabilities.search === 'boolean') parts.push(`search=${meta.capabilities.search ? 1 : 0}`)
    if (meta.capabilities.thinking) parts.push(`thinking=${meta.capabilities.thinking}`)
    if (parts.length > 0) headers.set('x-model-capabilities', parts.join(';'))
  }

  // Billing pré-voo — nomes exatos que billingStore.updateFromHeaders já
  // consome na IDE (estavam mortos desde a remoção do proxy worker antigo).
  if (meta.budget) {
    headers.set('x-plan', meta.budget.plan)
    headers.set('x-budget-status', meta.budget.status)
    headers.set('x-budget-pct', meta.budget.consumedPct.toFixed(4))
    headers.set('x-tokens-consumed', String(meta.budget.tokensConsumed))
    headers.set('x-extra-tokens', String(meta.budget.extraUsageBalance))
    if (meta.budget.cycleEnd) headers.set('x-cycle-end', meta.budget.cycleEnd)
    if (meta.budget.team) {
      headers.set('x-team-id', meta.budget.team.teamId)
      headers.set('x-team-tier', meta.budget.team.tier)
      headers.set('x-slice-tokens', String(meta.budget.team.sliceTokens))
      headers.set('x-pie-total', String(meta.budget.team.pieTotal))
    }
  }
  return headers
}
