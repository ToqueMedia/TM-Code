import { create } from 'zustand'

interface TmSpeedState {
  /** Toggle do utilizador (`/speed`), persistido em users/{uid}.tmSpeedEnabled. */
  enabled: boolean
  /** O worker confirmou speed na última resposta (`X-TM-Speed-Applied: true`)?
   * Pode divergir de `enabled`: toggle ligado mas speedModel não publicado ou
   * plano não elegível ⇒ enabled=true, applied=false. A UI usa `enabled` para
   * o badge (intenção do utilizador); `applied` indica serviço real (e cobrança 3x). */
  applied: boolean
  isLoaded: boolean
  setEnabled: (enabled: boolean) => void
  setApplied: (applied: boolean) => void
  updateFromProfile: (profile: Record<string, unknown> | null | undefined) => void
  reset: () => void
}

export const useTmSpeedStore = create<TmSpeedState>((set) => ({
  enabled: false,
  applied: false,
  isLoaded: false,

  setEnabled: (enabled) => set({ enabled, isLoaded: true }),

  setApplied: (applied) => set({ applied }),

  updateFromProfile: (profile) => {
    set({
      enabled: profile?.tmSpeedEnabled === true,
      isLoaded: true,
    })
  },

  reset: () => set({ enabled: false, applied: false, isLoaded: false }),
}))
