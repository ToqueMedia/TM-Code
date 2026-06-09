import { create } from 'zustand'

interface TmSpeedState {
  enabled: boolean
  isLoaded: boolean
  setEnabled: (enabled: boolean) => void
  updateFromProfile: (profile: Record<string, unknown> | null | undefined) => void
  reset: () => void
}

export const useTmSpeedStore = create<TmSpeedState>((set) => ({
  enabled: false,
  isLoaded: false,

  setEnabled: (enabled) => set({ enabled, isLoaded: true }),

  updateFromProfile: (profile) => {
    set({
      enabled: profile?.tmSpeedEnabled === true,
      isLoaded: true,
    })
  },

  reset: () => set({ enabled: false, isLoaded: false }),
}))
