// Authoritative team-membership gate for signaling admission.
//
// We do NOT trust any client-supplied team id or the `teamMemberOf` field on
// the user's own doc (a user can write their own user doc). Instead we read the
// TEAM doc `teams/{room}` — whose `members` map is written ONLY server-side
// (Cloud Functions) and which Firestore rules let only members read — and check
// the authenticated uid appears in it. A non-member's read is denied by rules,
// so the gate fails closed.

import type { Env } from './types'

const DEFAULT_FIRESTORE_BASE = 'https://firestore.googleapis.com'
const FIRESTORE_READ_TIMEOUT_MS = 10_000

function firestoreBase(env: Env): string {
  return typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE
    ? env.FIRESTORE_REST_BASE.replace(/\/+$/, '')
    : DEFAULT_FIRESTORE_BASE
}

/** Shape of the slice of a `teams/{id}` doc we care about (Firestore REST). */
interface TeamDoc {
  fields?: {
    members?: { mapValue?: { fields?: Record<string, unknown> } }
  }
}

/** Pure: does `uid` appear in the team doc's `members` map? */
export function isMemberInDoc(doc: TeamDoc | null | undefined, uid: string): boolean {
  const members = doc?.fields?.members?.mapValue?.fields
  if (!members || typeof members !== 'object') return false
  return Object.prototype.hasOwnProperty.call(members, uid)
}

/**
 * Confirm `uid` is a member of team `room`. Reads the team doc with the user's
 * own ID token (self-authorized; emulator bypasses with `owner`). Fails CLOSED:
 * any read error / denied / missing doc → not a member.
 */
export async function checkMembership(
  room: string,
  uid: string,
  idToken: string,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return false

  // Emulator accepts `owner` to bypass rules; production uses the user's token
  // (Firestore rules permit a member to read their team doc).
  const emulator = typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE !== ''
  const bearer = emulator ? 'owner' : idToken

  const url =
    `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents/` +
    `teams/${encodeURIComponent(room)}?mask.fieldPaths=members`

  try {
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(FIRESTORE_READ_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const doc = (await response.json()) as TeamDoc
    return isMemberInDoc(doc, uid)
  } catch {
    return false
  }
}
