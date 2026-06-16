import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  isAdmin?: boolean
  /** Account suspended by an admin (users/{uid}.blocked). Drives the suspended
   *  banner + forces the Welcome screen in real time. */
  blocked?: boolean
  /** Human-readable reason shown in the suspended banner. */
  blockedReason?: string
}

interface AuthState {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  /**
   * Tracks whether signup has completed all required steps (phone link).
   * `null` means unknown — the backend hasn't responded yet, so we treat
   * it conservatively (don't render the IDE shell). `true` after /v1/me
   * confirms or after Google sign-in. `false` if the backend rejects with
   * `reason: 'signup_incomplete'`.
   */
  signupComplete: boolean | null
}

interface AuthActions {
  setUser: (user: AuthUser | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setSignupComplete: (complete: boolean | null) => void
  /** Merge the admin block state into the current user (no-op if signed out). */
  setBlocked: (blocked: boolean, reason?: string) => void
  clear: () => void
}

const AUTH_BROADCAST_CHANNEL = 'tmcode-auth-sync'
const AUTH_STORAGE_SYNC_KEY = 'tmcode-auth-sync-event'

type AuthSyncPayload = Pick<AuthState, 'user' | 'isAuthenticated' | 'signupComplete'>

let isApplyingRemoteAuth = false
let authBroadcastChannel: BroadcastChannel | null = null

function getAuthBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!authBroadcastChannel) authBroadcastChannel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL)
  return authBroadcastChannel
}

function broadcastAuthState(payload: AuthSyncPayload): void {
  if (isApplyingRemoteAuth) return
  try { getAuthBroadcastChannel()?.postMessage(payload) } catch { /* best-effort */ }
  try { localStorage.setItem(AUTH_STORAGE_SYNC_KEY, JSON.stringify({ payload, ts: Date.now() })) } catch { /* best-effort */ }
}

function applyRemoteAuthState(payload: AuthSyncPayload): void {
  isApplyingRemoteAuth = true
  try {
    useAuthStore.setState({
      user: payload.user,
      isAuthenticated: payload.isAuthenticated,
      signupComplete: payload.signupComplete,
      isLoading: false,
      error: null,
    })
  } finally {
    isApplyingRemoteAuth = false
  }
}

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,
      signupComplete: null,

      setUser: (user) => {
        set({
          user,
          isAuthenticated: !!user,
          isLoading: false,
          error: null
        })
        broadcastAuthState({
          user,
          isAuthenticated: !!user,
          signupComplete: useAuthStore.getState().signupComplete,
        })
      },
      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error, isLoading: false }),
      setBlocked: (blocked, reason) => {
        const current = useAuthStore.getState().user
        if (!current) return
        if (current.blocked === blocked && current.blockedReason === reason) return
        set({ user: { ...current, blocked, blockedReason: blocked ? reason : undefined } })
      },
      setSignupComplete: (signupComplete) => {
        set({ signupComplete })
        const state = useAuthStore.getState()
        broadcastAuthState({
          user: state.user,
          isAuthenticated: state.isAuthenticated,
          signupComplete,
        })
      },
      clear: () => {
        set({ user: null, isAuthenticated: false, error: null, signupComplete: null })
        broadcastAuthState({ user: null, isAuthenticated: false, signupComplete: null })
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        signupComplete: state.signupComplete,
      })
    }
  )
)

if (typeof window !== 'undefined') {
  try {
    getAuthBroadcastChannel()?.addEventListener('message', (event: MessageEvent<AuthSyncPayload>) => {
      applyRemoteAuthState(event.data)
    })
  } catch { /* best-effort */ }

  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_STORAGE_SYNC_KEY || !event.newValue) return
    try {
      const parsed = JSON.parse(event.newValue) as { payload?: AuthSyncPayload }
      if (parsed.payload) applyRemoteAuthState(parsed.payload)
    } catch { /* ignore malformed cross-window payload */ }
  })
}
