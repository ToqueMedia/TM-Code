# Plan: Early Access Trial (7 dias Pro + 35 TMS)

> Author: TM Code Architect
> Date: 2026-03-30
> Status: PENDING IMPLEMENTATION

## 1. Context

**Current state:** New users sign up with `userPlan: 'explorer'` (Free). They get 10 TMS/day with only mimo-v2-flash model.
**Problem:** First-time users can't experience the full IDE (Pro models, higher limits) before deciding to subscribe. Low conversion.
**Goal:** Give every new user 7 days of Pro access with 35 TMS total, then auto-downgrade to Free.

## 2. Design

### Firestore User Document — New Fields

```
users/{uid}:
  trial: {
    active: true,
    startDate: "2026-04-01",      // when trial started
    endDate: "2026-04-08",        // startDate + 7 days
    tmsGranted: 35,               // total TMS given for trial
  }
```

### Flow

1. **Signup** → `userPlan: 'pro'`, `trial.active: true`, `trial.endDate: now + 7 days`
2. **tmsQuota.monthlyPool** seeded with 35 (not the Pro default of 100)
3. **Backend on every request** → check `trial.endDate`. If expired:
   - Set `userPlan: 'explorer'`, `trial.active: false`
   - Reset tmsQuota to Free defaults
4. **Frontend** → Show trial banner: "Pro trial: 4 days left, 22/35 TMS"
5. **Upgrade during trial** → Cancel trial, set real Pro plan, keep remaining TMS

### Key Decisions

| Decision | Chosen | Alternative | Trade-off |
|----------|--------|-------------|-----------|
| 35 TMS pool type | Monthly pool (not daily) | 5/day for 7 days | Monthly = user can burst all 35 in day 1, more flexible. Daily = spreads usage but limits heavy sessions. |
| Trial check location | Backend (every request) | Cron job (daily) | Per-request = instant downgrade. Cron = up to 24h delay but cheaper. Per-request chosen for accuracy. |
| Post-trial TMS | Reset to 0 (fresh Free) | Keep unused trial TMS | Reset = clean slate, no gaming. Keep = friendlier but allows hoarding. |
| Trial re-activation | Not allowed (one per account) | Allow after 30 days | One-time only prevents abuse. |

## 3. Implementation Phases

### Phase 1 — Backend: Trial check on request
- `firestore.ts` / `getUserData`: read `trial` field, check `endDate`, auto-downgrade if expired
- `billing.ts`: no changes (monthlyPool consumption works as-is)
- `firebaseAuth.ts` (IDE signup): set trial fields on new user creation

### Phase 2 — Backend: Seed trial TMS on signup
- `firebaseAuth.ts`: on signup, set `userPlan: 'pro'`, `tmsQuota.monthlyPool: 35`, `trial: { active: true, endDate: +7d }`

### Phase 3 — Frontend: Trial banner
- Component in ChatView header showing days left + TMS remaining
- "Upgrade" CTA button

### Phase 4 — Edge cases
- User upgrades mid-trial: cancel trial, activate real subscription
- User trial expires mid-session: next request fails gracefully, UI updates
- Grace period: 1 day after trial ends before hard downgrade

## 4. Open Questions

- Should trial users have access to ALL Pro models or a subset?
- Should the 35 TMS be refilled if user upgrades (credit towards subscription)?
- Email notification 1 day before trial ends?
