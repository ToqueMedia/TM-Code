// Google Sign-In via the Google Identity Services (GIS) library.
//
// Hard rules from the google-signin skill:
//   1. NEVER use signInWithPopup / GoogleAuthProvider — popup is silently
//      blocked in iframe/IDE preview contexts. The GIS button renders
//      inline (FedCM dialog) and works everywhere.
//   2. Poll for window.google before calling initialize/renderButton — the
//      <script async defer> in index.html loads non-blocking.
//   3. Hook signature is (buttonRef, options?). Do not improvise.
//   4. After token exchange execute these 4 steps IN ORDER:
//        setAuthToken → authFetch('/api/auth/sync') → setUser → onSuccess
import { useEffect, type RefObject } from 'react'
import { authFetch, setAuthToken } from './authClient'
import { useAuthStore, type User } from '../store/authStore'

interface GoogleCredentialResponse {
  credential: string
  select_by: string
}

interface GoogleAccountsId {
  initialize: (config: {
    client_id: string
    callback: (response: GoogleCredentialResponse) => void
    cancel_on_tap_outside?: boolean
  }) => void
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } }
  }
}

interface UseGoogleSignInOptions {
  onSuccess?: (user: User) => void
  onError?: (err: Error) => void
}

export function useGoogleSignIn(
  buttonRef: RefObject<HTMLDivElement | null>,
  options: UseGoogleSignInOptions = {}
): void {
  useEffect(() => {
    let cancelled = false

    const waitForGsi = (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (window.google?.accounts?.id) {
          resolve()
          return
        }
        const interval = setInterval(() => {
          if (window.google?.accounts?.id) {
            clearInterval(interval)
            resolve()
          }
        }, 100)
        setTimeout(() => {
          clearInterval(interval)
          reject(new Error('Google Identity Services script failed to load'))
        }, 10000)
      })

    const init = async (): Promise<void> => {
      try {
        await waitForGsi()
        if (cancelled) return
        const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
        if (!clientId) {
          throw new Error('VITE_GOOGLE_CLIENT_ID missing — has provision_auth run?')
        }
        window.google!.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            try {
              await handleCredential(response.credential, options)
            } catch (err) {
              options.onError?.(err instanceof Error ? err : new Error(String(err)))
            }
          },
          cancel_on_tap_outside: false,
        })
        if (buttonRef.current) {
          window.google!.accounts.id.renderButton(buttonRef.current, {
            theme: 'outline',
            size: 'large',
            width: '100%',
            text: 'signin_with',
            shape: 'rectangular',
            logo_alignment: 'center',
          })
        }
      } catch (err) {
        if (!cancelled) {
          options.onError?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [buttonRef, options])
}

async function handleCredential(
  credential: string,
  options: UseGoogleSignInOptions
): Promise<void> {
  // 1. Exchange Google ID token for Firebase tokens via the proxy.
  const tokenRes = await fetch('/api/auth/proxy/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: credential }),
  })
  if (!tokenRes.ok) {
    const body = (await tokenRes.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || 'Authentication failed')
  }
  const tokens = (await tokenRes.json()) as {
    idToken: string
    refreshToken: string
    email: string
    displayName?: string
    photoUrl?: string
  }

  // 2. setAuthToken — REQUIRED before the next authFetch.
  setAuthToken(tokens.idToken, tokens.refreshToken)

  // 3. authFetch('/api/auth/sync') — upserts the user row.
  const syncRes = await authFetch('/api/auth/sync', {
    method: 'POST',
    body: JSON.stringify({
      name: tokens.displayName,
      avatarUrl: tokens.photoUrl,
    }),
  })
  if (!syncRes.ok) {
    throw new Error('Failed to sync user data')
  }
  const user = (await syncRes.json()) as User

  // 4. setUser + onSuccess.
  useAuthStore.getState().setUser(user)
  options.onSuccess?.(user)
}
