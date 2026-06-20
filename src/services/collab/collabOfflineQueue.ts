// Durable offline delivery for team chat, via Firebase Realtime Database.
//
// The mesh delivers chat P2P to teammates ONLINE at send time. This module is
// the backstop for those who were OFFLINE: the sender writes the message to an
// RTDB queue with a `pending` set of the members who did NOT get it P2P. When a
// member connects they read the queue, receive the messages where they're in
// `pending`, ACK (remove themselves), and delete the message once `pending` is
// empty — so:
//   • whoever already received (not in `pending`) never gets it again;
//   • the message is auto-removed once everyone has it.
//
// Entirely client-side + best-effort: when RTDB isn't configured (no
// VITE_FIREBASE_DATABASE_URL → rtdb() === null) every function is a silent
// no-op and chat still works P2P.

import { ref, set, onChildAdded, remove, get } from 'firebase/database'
import { doc, getDoc } from 'firebase/firestore'
import { rtdb, db } from '@/services/auth/firebaseAuth'
import type { ChatMessage } from '@/services/collab/collabChat'

const QUEUE_ROOT = 'collabChat'
/** Stale-message TTL — a message never drained (e.g. a member who left and never
 *  reconnects keeps it pending forever) is swept after this so the queue can't
 *  grow unbounded. */
const MESSAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000

interface QueueEntry {
  msg: ChatMessage
  pending: Record<string, true>
}

// ── Team roster (to know who must still receive a message) ───────────────────

let rosterCache: { teamId: string; uids: string[]; at: number } | null = null
const ROSTER_TTL_MS = 60_000

/** Member uids of `teams/{teamId}` (Firestore; a member may read their own team
 *  doc). Cached briefly so a burst of messages doesn't re-read it each time. */
export async function getTeamRoster(teamId: string): Promise<string[]> {
  if (rosterCache && rosterCache.teamId === teamId && Date.now() - rosterCache.at < ROSTER_TTL_MS) {
    return rosterCache.uids
  }
  try {
    const snap = await getDoc(doc(db(), 'teams', teamId))
    const members = (snap.data()?.members ?? {}) as Record<string, unknown>
    const uids = Object.keys(members)
    rosterCache = { teamId, uids, at: Date.now() }
    return uids
  } catch {
    return rosterCache?.teamId === teamId ? rosterCache.uids : []
  }
}

// ── Enqueue (sender side) ────────────────────────────────────────────────────

/**
 * Queue a message for the members in `pendingUids` (those who weren't online to
 * get it P2P). No-op when RTDB is unconfigured or no one is pending.
 */
export async function enqueueOfflineMessage(
  teamId: string,
  msg: ChatMessage,
  pendingUids: string[],
): Promise<void> {
  const database = rtdb()
  if (!database || pendingUids.length === 0) return
  const pending: Record<string, true> = {}
  for (const uid of pendingUids) pending[uid] = true
  try {
    await set(ref(database, `${QUEUE_ROOT}/${teamId}/${msg.id}`), { msg, pending } satisfies QueueEntry)
  } catch {
    /* best effort — P2P already delivered to the online members */
  }
}

// ── Subscribe (receiver side) ────────────────────────────────────────────────

/**
 * Subscribe to the team's offline queue. For each message where `selfUid` is
 * still pending: deliver it (caller dedups by id), ACK by removing self from
 * `pending`, then delete the whole message if no one is pending anymore.
 * Returns an unsubscribe function (no-op when RTDB is unconfigured).
 */
export function subscribeOfflineQueue(
  teamId: string,
  selfUid: string,
  onReceive: (msg: ChatMessage) => void,
): () => void {
  const database = rtdb()
  if (!database || !selfUid) return () => {}

  // onChildAdded fires for EXISTING children on first attach (initial drain) and
  // for any new ones afterwards.
  const unsub = onChildAdded(ref(database, `${QUEUE_ROOT}/${teamId}`), (snap) => {
    const id = snap.key
    const entry = snap.val() as QueueEntry | null
    if (!id || !entry?.msg) return

    // Sweep stale messages (any draining member can) so an inactive recipient
    // can't keep a message pending forever.
    if (typeof entry.msg.ts === 'number' && Date.now() - entry.msg.ts > MESSAGE_TTL_MS) {
      void remove(ref(database, `${QUEUE_ROOT}/${teamId}/${id}`)).catch(() => {})
      return
    }

    if (!entry.pending?.[selfUid]) return // not for me, or I already acked

    onReceive(entry.msg)

    // ACK + cleanup (best-effort, async).
    void (async () => {
      try {
        await remove(ref(database, `${QUEUE_ROOT}/${teamId}/${id}/pending/${selfUid}`))
        const pendingSnap = await get(ref(database, `${QUEUE_ROOT}/${teamId}/${id}/pending`))
        const remaining = pendingSnap.exists() ? Object.keys(pendingSnap.val() ?? {}).length : 0
        if (remaining === 0) {
          await remove(ref(database, `${QUEUE_ROOT}/${teamId}/${id}`))
        }
      } catch {
        /* a transient RTDB error just leaves the message queued for next time */
      }
    })()
  })

  return unsub
}
