/**
 * Lightweight analytics wrapper — sends structured events to Firebase
 * Analytics via the existing Firebase app instance.
 *
 * Lazy-initialized: the first call to `trackEvent()` initializes Analytics.
 * No-op in environments where Firebase config is missing (tests, CI) or
 * when the user is not authenticated (no Firebase app).
 *
 * Usage:
 *   import { trackEvent } from '@/services/analytics'
 *   trackEvent('tool_pool_turn_done', { totalTools: 5, conflictsAvoided: 2 })
 */

let analyticsInstance: import('firebase/analytics').Analytics | null = null
let initAttempted = false

async function getAnalyticsInstance(): Promise<import('firebase/analytics').Analytics | null> {
  if (analyticsInstance) return analyticsInstance
  if (initAttempted) return null
  initAttempted = true

  try {
    // Dynamic import to keep firebase/analytics out of the initial bundle.
    // Only loaded when the first event fires (typically after the first agent
    // turn, ~5-30s after app launch — well past the critical render path).
    const { getAnalytics } = await import('firebase/analytics')
    const { getApp } = await import('firebase/app')

    const app = getApp() // reuses the existing initialized app
    analyticsInstance = getAnalytics(app)
    return analyticsInstance
  } catch {
    // Firebase not initialized (tests, CI, missing config) — silently no-op.
    return null
  }
}

/**
 * Fire a structured analytics event. No-op if Firebase Analytics isn't
 * available. Never throws — swallows all errors to avoid disrupting the
 * agent loop or UI.
 *
 * Event names follow Firebase convention: snake_case, ≤40 chars.
 * Param values are auto-coerced to string/number by Firebase SDK.
 */
export async function trackEvent(
  name: string,
  params?: Record<string, string | number | boolean>,
): Promise<void> {
  try {
    const analytics = await getAnalyticsInstance()
    if (!analytics) return

    const { logEvent } = await import('firebase/analytics')
    logEvent(analytics, name, params)
  } catch {
    // Swallow — analytics failure must NEVER block agent execution.
  }
}
