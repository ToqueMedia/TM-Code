import { sha256Prefix, secretHint } from './secrets'

export function createRequestId(request: Request): string {
  const incoming = request.headers.get('x-request-id') || request.headers.get('x-tm-request-id')
  if (incoming && /^[a-zA-Z0-9._:-]{6,128}$/.test(incoming)) return incoming
  return crypto.randomUUID()
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
