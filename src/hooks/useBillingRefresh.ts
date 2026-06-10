import { useEffect, useRef } from 'react'
import FirebaseAuthService from '../services/auth/firebaseAuth'
import { useAuthStore } from '../stores/authStore'
import { useBillingStore } from '../stores/billingStore'

/**
 * Refreshes billing state on event-driven triggers (NEVER polling).
 *
 * Triggers:
 *  1. Window becomes visible (user returns to the app)
 *  2. Network reconnects (user comes back online)
 *
 * Billing state is refreshed from the Control Plane. The dedicated AI
 * data-plane Worker is a thin pass-through and does not inject billing events
 * into /v1/chat/completions streams. This hook handles state changes outside
 * of chat:
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

    // 3. Auth becomes ready (app launch / login) and billing never loaded.
    //    Safety net for the onAuthStateChanged-driven fetch: if it aborted or
    //    exhausted its retries at cold boot, the plan card stayed empty until
    //    the next window-focus or a chat turn touched the user doc. This is a
    //    single deferred check per auth-ready event — NOT polling.
    let bootRetryTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleBootCheck = (isAuthed: boolean) => {
      if (!isAuthed || useBillingStore.getState().isLoaded) return
      if (bootRetryTimer) clearTimeout(bootRetryTimer)
      bootRetryTimer = setTimeout(() => {
        bootRetryTimer = null
        if (!useBillingStore.getState().isLoaded) refresh()
      }, 3000)
    }
    scheduleBootCheck(useAuthStore.getState().isAuthenticated)
    const unsubAuth = useAuthStore.subscribe((state, prev) => {
      if (state.isAuthenticated && !prev.isAuthenticated) {
        scheduleBootCheck(true)
      }
    })

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      if (bootRetryTimer) clearTimeout(bootRetryTimer)
      unsubAuth()
    }
  }, [])
}
