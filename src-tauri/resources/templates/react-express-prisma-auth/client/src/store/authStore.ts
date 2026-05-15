// Zustand auth store. Single source of truth for the authenticated user row.
//
// init() rehydrates on app load by calling /api/auth/me. Without this,
// onAuthStateChanged never fires (proxy flow) and a hard refresh strands
// the user on an infinite loading state.
import { create } from 'zustand'
import { authFetch, setAuthToken } from '../lib/authClient'

export interface User {
  id: string
  uid: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: string
  createdAt: string
  updatedAt: string
}

interface AuthState {
  user: User | null
  loading: boolean
  init: () => Promise<void>
  setUser: (u: User | null) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  setUser: (u) => set({ user: u }),
  logout: () => {
    setAuthToken(null, null)
    set({ user: null })
  },
  init: async () => {
    const token = sessionStorage.getItem('_auth_token')
    if (!token) {
      set({ user: null, loading: false })
      return
    }
    try {
      const res = await authFetch('/api/auth/me')
      if (res.ok) {
        set({ user: (await res.json()) as User, loading: false })
      } else {
        setAuthToken(null, null)
        set({ user: null, loading: false })
      }
    } catch {
      set({ user: null, loading: false })
    }
  },
}))
