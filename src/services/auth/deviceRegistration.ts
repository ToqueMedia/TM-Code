import { tauriFetch } from '../tauriFetch'
import { resolveWorkerUrl } from '@/utils/devUrls'
import { getDeviceFingerprint } from './deviceFingerprint'
import FirebaseAuthService, { getAppCheckHeader } from './firebaseAuth'

export type DeviceRegistrationResult =
  | { ok: true }
  | { ok: false; reason: 'limit_exceeded' | 'disposable_email' | 'rate_limited' | 'appcheck_failed' | 'unauthorized' | 'network' }

/**
 * Register the current device fingerprint with the backend, atomically
 * checking the per-device account limit (currently 2). Called once per
 * signup, after the phone-number link succeeds.
 *
 * The backend response distinguishes "this fingerprint already has too many
 * accounts" (403, reason='limit_exceeded') from generic auth/network failures.
 * The caller should surface the limit_exceeded case as a user-facing error
 * and roll back the half-created account (`user.delete()`).
 */
export async function registerDevice(): Promise<DeviceRegistrationResult> {
  let token: string | null
  try {
    token = await FirebaseAuthService.getInstance().getIdToken()
  } catch {
    return { ok: false, reason: 'unauthorized' }
  }
  if (!token) return { ok: false, reason: 'unauthorized' }

  let fingerprint: string
  try {
    fingerprint = await getDeviceFingerprint()
  } catch (err) {
    console.warn('[device] fingerprint capture failed:', err)
    return { ok: false, reason: 'network' }
  }

  try {
    const appCheck = await getAppCheckHeader()
    const res = await tauriFetch(`${resolveWorkerUrl()}/v1/auth/register-device`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...appCheck,
      },
      body: JSON.stringify({ fingerprint }),
    })

    if (res.ok) return { ok: true }
    if (res.status === 429) return { ok: false, reason: 'rate_limited' }
    if (res.status === 403) {
      const data = await res.json().catch(() => ({})) as { reason?: string }
      if (data.reason === 'limit_exceeded') return { ok: false, reason: 'limit_exceeded' }
      if (data.reason === 'disposable_email') return { ok: false, reason: 'disposable_email' }
      if (data.reason === 'appcheck_failed') return { ok: false, reason: 'appcheck_failed' }
      return { ok: false, reason: 'unauthorized' }
    }
    if (res.status === 401) return { ok: false, reason: 'unauthorized' }
    return { ok: false, reason: 'network' }
  } catch {
    return { ok: false, reason: 'network' }
  }
}
