// Ephemeral TURN credentials via Cloudflare Calls' TURN service.
//
// Why: the mesh is STUN-only by default — peers behind symmetric NATs get no
// direct path and fall back to the DO data relay, which cannot carry voice.
// TURN closes that gap while preserving the privacy model: a TURN server only
// forwards SRTP/DTLS packets, it can never read what the team exchanges.
//
// The DO mints short-lived credentials here and hands them to each member in
// the `welcome` message. The long-lived TURN key/token NEVER leave the worker
// (they are secrets); clients only ever see per-session ephemeral credentials.
// When the secrets are not configured (or the mint fails) we return null and
// the client silently stays STUN-only — TURN is an upgrade, not a dependency.

import type { Env, IceServerEntry } from './types'

/** RTCIceServer-shaped entry as delivered to the browser client. */
export type IceServer = IceServerEntry

const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/** Credential lifetime: 12 h. Comfortably outlives a work session; a socket
 *  drop reconnects through `welcome`, which re-delivers fresh credentials. */
export const TURN_TTL_SECONDS = 43_200

/** How long a minted set may be served from the DO cache (half the TTL, so a
 *  client always receives credentials with ≥ 6 h of life left). */
export const TURN_CACHE_MS = (TURN_TTL_SECONDS / 2) * 1000

/**
 * Normalize a Cloudflare TURN API response into a clean IceServer list.
 * Accepts BOTH shapes the API has shipped:
 *   - `credentials/generate`:            { iceServers: { urls, username, credential } }
 *   - `credentials/generate-ice-servers`: { iceServers: [ { urls, ... }, ... ] }
 * Returns null when nothing usable is present.
 */
export function normalizeIceServers(body: unknown): IceServer[] | null {
  if (!body || typeof body !== 'object') return null
  const raw = (body as { iceServers?: unknown }).iceServers
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: IceServer[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const urls = Array.isArray(e.urls)
      ? e.urls.filter((u): u is string => typeof u === 'string')
      : typeof e.urls === 'string'
        ? [e.urls]
        : []
    if (urls.length === 0) continue
    const server: IceServer = { urls }
    if (typeof e.username === 'string') server.username = e.username
    if (typeof e.credential === 'string') server.credential = e.credential
    out.push(server)
  }
  return out.length > 0 ? out : null
}

/**
 * Mint ephemeral TURN credentials. Null (never a throw) when TURN is not
 * configured, the API errors, or the response is malformed — callers treat
 * null as "STUN-only session".
 */
export async function mintTurnIceServers(env: Env): Promise<IceServer[] | null> {
  const keyId = env.TURN_KEY_ID
  const apiToken = env.TURN_KEY_API_TOKEN
  if (!keyId || !apiToken) return null
  // Failures degrade to STUN-only but must NEVER be silent — a mistyped token
  // would otherwise be indistinguishable from "TURN not configured". These
  // logs surface in `wrangler tail` and the observability dashboard.
  try {
    const res = await fetch(`${TURN_API_BASE}/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn('[turn] credential mint FAILED:', res.status, body.slice(0, 300))
      return null
    }
    const servers = normalizeIceServers(await res.json())
    if (!servers) {
      console.warn('[turn] credential mint returned an unrecognized body shape')
      return null
    }
    return servers
  } catch (e) {
    console.warn('[turn] credential mint threw:', (e as Error)?.message ?? e)
    return null
  }
}
