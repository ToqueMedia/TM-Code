import { useEffect, useRef } from 'react'
import FirebaseAuthService from '../services/auth/firebaseAuth'

/**
 * Refreshes billing state on event-driven triggers (NEVER polling).
 *
 * Triggers:
 *  1. Window becomes visible (user returns to the app)
 *  2. Network reconnects (user comes back online)
 *
 * The primary source of billing updates remains the SSE billing event injected
 * at the end of every /v1/chat/completions response. This hook handles the gaps
 * where state changes outside of chat:
 *  - User purchased a credit pack via web checkout (refresh on window focus)
 *  - User upgraded their plan via web (refresh on window focus)
 *  - Cycle reset happened externally (refresh on window focus)
 *  - User came back from offline (refresh on online event)
 *
 * Debounced: ignores triggers that fire within 2s of each other to avoid
 * burst-refreshing during rapid window-state changes.
 *
 * See `~/.claude/projects/.../memory/feedback_no_polling.md` — polling was
 * explicitly rejected as a sync mechanism.
 */
const DEBOUNCE_MS = 2000

export function useBillingRefresh(): void {
  const lastRefreshAt = useRef(0)

  useEffect(() => {
    const refresh = () => {
      const now = Date.now()
      if (now - lastRefreshAt.current < DEBOUNCE_MS) return
      lastRefreshAt.current = now
      // Fire-and-forget — failures are handled inside fetchBillingInfo.
      // Backend /v1/me always reads fresh from Firestore (no KV cache),
      // so stale billing data after plan changes is not a concern.
      FirebaseAuthService.getInstance().fetchBillingInfo().catch(err => {
        console.warn('[useBillingRefresh] fetchBillingInfo failed:', err)
      })
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }

    const handleOnline = () => {
      refresh()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
    }
  }, [])
}
