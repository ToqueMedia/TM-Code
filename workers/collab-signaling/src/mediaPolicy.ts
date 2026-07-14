// Per-plan voice/screen limits, delivered to every member in the `welcome`
// message (same mechanism as the TURN credentials). The CLIENT enforces the
// UX limits (call size, duration, capture caps) — P2P media never touches our
// servers, so a tampered client costs us nothing and only degrades itself.
// The server-enforced money limit (TURN quota) is a separate follow-up.
//
// `plan` comes from the membership check (control-plane `planTier`, only when
// the team subscription is active). Unknown/absent plan → the conservative
// (pro) policy, so an old control-plane or a lapsed subscription never grants
// max-tier limits by accident.

/** Wire shape consumed by the IDE (see sanitizeMediaPolicy client-side). */
export interface MediaPolicy {
  /** Max simultaneous participants in the team voice call. */
  maxCallParticipants: number
  /** Max call duration in minutes; null = unlimited. */
  maxCallMinutes: number | null
  /** Max simultaneous screen-share watchers. */
  maxScreenWatchers: number
  /** Screen capture ceilings. Bitrate is the ENCODER ceiling per watcher —
   *  WebRTC congestion control adapts below it on weak uplinks, so a generous
   *  ceiling costs nothing on good networks and degrades gracefully on bad. */
  screenMaxHeight: number
  screenMaxFrameRate: number
  screenMaxBitrateKbps: number
}

const PRO_POLICY: MediaPolicy = {
  maxCallParticipants: 4,
  maxCallMinutes: 120,
  maxScreenWatchers: 3,
  screenMaxHeight: 1080,
  screenMaxFrameRate: 12,
  screenMaxBitrateKbps: 3000,
}

const MAX_POLICY: MediaPolicy = {
  maxCallParticipants: 8,
  maxCallMinutes: null,
  maxScreenWatchers: 8,
  screenMaxHeight: 1440,
  screenMaxFrameRate: 20,
  screenMaxBitrateKbps: 8000,
}

/** Resolve the media policy for a team plan tier (case-insensitive). */
export function policyForPlan(plan: string | null | undefined): MediaPolicy {
  return typeof plan === 'string' && plan.trim().toLowerCase() === 'max' ? MAX_POLICY : PRO_POLICY
}
