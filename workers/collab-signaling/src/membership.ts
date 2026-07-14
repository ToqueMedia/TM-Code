// Authoritative team-membership gate for signaling admission.
//
// We do NOT trust any client-supplied team id or the `teamMemberOf` field on
// the user's own doc (a user can write their own user doc). Admission is gated
// on the authoritative TEAM doc `teams/{room}` — whose `members` map is written
// ONLY server-side (Cloud Functions, Admin SDK) — checking the authenticated
// uid appears in it. The gate fails CLOSED.
//
// TWO read paths, by environment:
//
//  • PRODUCTION — the Firestore REST API has **App Check ENFORCED**, so this
//    Worker (which only carries the user's ID token, no App Check token) is
//    rejected with 403 if it reads `teams/{teamId}` directly. Instead we POST
//    to the control-plane (`/v1/collab/membership`), which re-verifies the
//    token and reads the team with a SERVICE ACCOUNT (bypasses App Check +
//    rules) and returns whether the uid is a member.
//
//  • EMULATOR / LOCAL (`FIRESTORE_REST_BASE` set) — App Check is off on the
//    emulator, so we read the team doc directly (bearer `owner` bypasses the
//    emulator rules) and keep local dev self-contained without a running
//    control-plane.

import type { Env } from './types'

const DEFAULT_FIRESTORE_BASE = 'https://firestore.googleapis.com'
const FIRESTORE_READ_TIMEOUT_MS = 10_000
const MEMBERSHIP_PROXY_TIMEOUT_MS = 10_000

function firestoreBase(env: Env): string {
  return typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE
    ? env.FIRESTORE_REST_BASE.replace(/\/+$/, '')
    : DEFAULT_FIRESTORE_BASE
}

/** Membership verdict + the team's plan tier (null = unknown/inactive → the
 *  caller applies the conservative media policy). */
export interface MembershipResult {
  member: boolean
  plan: string | null
}

const NOT_MEMBER: MembershipResult = { member: false, plan: null }

/** Shape of the slice of a `teams/{id}` doc we care about (Firestore REST). */
interface TeamDoc {
  fields?: {
    members?: { mapValue?: { fields?: Record<string, unknown> } }
    planTier?: { stringValue?: string }
  }
}

/** Pure: does `uid` appear in the team doc's `members` map? */
export function isMemberInDoc(doc: TeamDoc | null | undefined, uid: string): boolean {
  const members = doc?.fields?.members?.mapValue?.fields
  if (!members || typeof members !== 'object') return false
  return Object.prototype.hasOwnProperty.call(members, uid)
}

/** Pure: membership + plan from a team doc (emulator-direct path — no
 *  subscription validation there; production gets it from the control-plane,
 *  which only returns a plan for ACTIVE subscriptions). */
export function membershipFromDoc(doc: TeamDoc | null | undefined, uid: string): MembershipResult {
  if (!isMemberInDoc(doc, uid)) return NOT_MEMBER
  const plan = doc?.fields?.planTier?.stringValue
  return { member: true, plan: typeof plan === 'string' && plan ? plan : null }
}

/**
 * Emulator/local path: read the team doc directly (bypassing rules with the
 * `owner` bearer). Only used when `FIRESTORE_REST_BASE` points at an emulator.
 */
async function checkMembershipDirect(
  room: string,
  uid: string,
  env: Env,
  fetcher: typeof fetch,
): Promise<MembershipResult> {
  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID : ''
  if (!projectId) return NOT_MEMBER

  const url =
    `${firestoreBase(env)}/v1/projects/${projectId}/databases/(default)/documents/` +
    `teams/${encodeURIComponent(room)}?mask.fieldPaths=members&mask.fieldPaths=planTier`

  try {
    const response = await fetcher(url, {
      headers: { authorization: `Bearer owner` },
      signal: AbortSignal.timeout(FIRESTORE_READ_TIMEOUT_MS),
    })
    if (!response.ok) return NOT_MEMBER
    const doc = (await response.json()) as TeamDoc
    return membershipFromDoc(doc, uid)
  } catch {
    return NOT_MEMBER
  }
}

/**
 * Production path: delegate the membership check to the control-plane, which
 * reads the team with a service account (the Worker's own user-token read is
 * blocked by Firestore App Check enforcement). Fails CLOSED on any error.
 */
async function checkMembershipViaControlPlane(
  room: string,
  idToken: string,
  env: Env,
  fetcher: typeof fetch,
): Promise<MembershipResult> {
  const base = typeof env.CONTROL_PLANE_URL === 'string' ? env.CONTROL_PLANE_URL.replace(/\/+$/, '') : ''
  if (!base) return NOT_MEMBER

  try {
    const response = await fetcher(`${base}/v1/collab/membership`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${idToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ teamId: room }),
      signal: AbortSignal.timeout(MEMBERSHIP_PROXY_TIMEOUT_MS),
    })
    if (!response.ok) return NOT_MEMBER
    // `plan` is absent from OLD control-plane deploys → null → conservative
    // media policy. Membership semantics are unchanged either way.
    const data = (await response.json()) as { member?: boolean; plan?: unknown }
    if (data.member !== true) return NOT_MEMBER
    return { member: true, plan: typeof data.plan === 'string' && data.plan ? data.plan : null }
  } catch {
    return NOT_MEMBER
  }
}

/**
 * Confirm `uid` is a member of team `room` and resolve the team's plan tier.
 * Fails CLOSED: any read error / denied / missing doc → not a member. Routes
 * to the emulator-direct path when `FIRESTORE_REST_BASE` is set, otherwise to
 * the control-plane proxy.
 */
export async function checkMembership(
  room: string,
  uid: string,
  idToken: string,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<MembershipResult> {
  if (typeof env.FIRESTORE_REST_BASE === 'string' && env.FIRESTORE_REST_BASE !== '') {
    return checkMembershipDirect(room, uid, env, fetcher)
  }
  return checkMembershipViaControlPlane(room, idToken, env, fetcher)
}
