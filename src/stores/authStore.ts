import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  isAdmin?: boolean
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
  clear: () => void
}

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,
      signupComplete: null,

      setUser: (user) => set({
        user,
        isAuthenticated: !!user,
        isLoading: false,
        error: null
      }),
      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error, isLoading: false }),
      setSignupComplete: (signupComplete) => set({ signupComplete }),
      clear: () => set({ user: null, isAuthenticated: false, error: null, signupComplete: null }),
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
