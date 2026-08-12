import { sha256Prefix, secretHint } from './secrets'

export function createRequestId(request: Request): string {
  const incoming = request.headers.get('x-request-id') || request.headers.get('x-tm-request-id')
  if (incoming && /^[a-zA-Z0-9._:-]{6,128}$/.test(incoming)) return incoming
  return crypto.randomUUID()
}

/**
 * Evento de CACHE, um por pedido metered — hit **ou miss**.
 *
 * PORQUÊ EXISTE: até 2026-08-12 o worker só escrevia quando
 * `cachedTokens > 0`. O log dava o NUMERADOR e escondia o DENOMINADOR, logo a
 * taxa de acerto do cache nunca foi mensurável a partir daqui: a sessão de
 * 10-08 com 11 misses em 17 pedidos aparecia no `wrangler tail` como 6 linhas
 * de sucesso — indistinguível de 6 pedidos com 100% de acerto.
 *
 * É o que bloqueia a decisão do Cloudflare (35% de cache → margem −55%): sem
 * denominador não há como confirmar o número, nem como comparar a afinidade
 * por SESSÃO com a afinidade por utilizador que está em produção.
 *
 * `affinity` vai no evento porque a pergunta é exactamente essa: pedidos com a
 * MESMA chave aterram na mesma instância? Vai já hasheado da origem
 * (`applySessionAffinity`) — nunca é o uid nem o id da sessão em claro.
 *
 * Função PURA e separada do `console.info` de propósito: a forma do evento é
 * testável sem simular um Worker inteiro, e o teste de que ela é emitida SEM
 * condição vive ao lado (cacheObservability.test.ts).
 */
export interface CacheEventInput {
  requestId: string
  provider: string
  model: string
  affinity: string | null
  promptTokens: number
  cachedTokens: number
  authoritative: boolean
}

export function buildCacheEvent(input: CacheEventInput): Record<string, unknown> {
  return {
    event: 'ai_cache',
    request_id: input.requestId,
    provider: input.provider,
    model: input.model,
    affinity: input.affinity,
    prompt_tokens: input.promptTokens,
    cached_tokens: input.cachedTokens,
    cached_pct: input.promptTokens > 0
      ? Math.round((input.cachedTokens / input.promptTokens) * 1000) / 10
      : 0,
    hit: input.cachedTokens > 0,
    // Um `usage` ESTIMADO tem cachedTokens=0 por construção (o provider omitiu
    // o objecto e contámos bytes). Sem esta flag, esses pedidos entram na
    // amostra como misses e afundam a taxa medida sem nada os denunciar —
    // filtrar por `authoritative: true` antes de calcular seja o que for.
    authoritative: input.authoritative,
  }
}

export async function logRequest(event: {
  requestId: string
  userId: string
  provider: string
  model: string
  upstreamStatus: number
  durationMs: number
  providerKey?: string
  configSource?: string
  configKey?: string
  /** True when served via Team BYOK (`team:{teamId}`) — the team's own key,
   *  no TM metering. Surfaced so `wrangler tail` proves which carrier ran. */
  teamByok?: boolean
  /** Host the request was actually sent to (the team provider's, under BYOK). */
  upstreamHost?: string
}): Promise<void> {
  const key = event.providerKey
  const keyHash = key ? await sha256Prefix(key) : undefined
  console.info(JSON.stringify({
    event: 'ai_pass_through',
    request_id: event.requestId,
    user_id: event.userId,
    team_byok: event.teamByok === true,
    provider: event.provider,
    model: event.model,
    upstream_host: event.upstreamHost,
    upstream_status: event.upstreamStatus,
    duration_ms: event.durationMs,
    config_source: event.configSource,
    config_key: event.configKey,
    key_hint: key ? secretHint(key) : undefined,
    key_sha256_10: keyHash,
  }))
}
