import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface UpdateInfo {
  version: string
  body: string | null
  date: string | null
}

interface UpdateState {
  pendingUpdate: UpdateInfo | null
  isBannerVisible: boolean
  lastSnoozedAt: number | null // timestamp in ms
  ignoredVersions: string[]

  setPendingUpdate: (update: UpdateInfo | null) => void
  showBanner: () => void
  hideBanner: () => void
  snoozeBanner: () => void
  ignoreUpdate: (version: string) => void
  checkSnooze: () => void
}

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      pendingUpdate: null,
      isBannerVisible: false,
      lastSnoozedAt: null,
      ignoredVersions: [],

      setPendingUpdate: (update) => {
        if (!update) {
          set({ pendingUpdate: null, isBannerVisible: false })
          return
        }
        
        const { ignoredVersions } = get()
        if (ignoredVersions.includes(update.version)) return

        set({ pendingUpdate: update, isBannerVisible: true })
      },

      showBanner: () => set({ isBannerVisible: true }),
      hideBanner: () => set({ isBannerVisible: false }),
      snoozeBanner: () => set({ 
        isBannerVisible: false, 
        lastSnoozedAt: Date.now() 
      }),
      ignoreUpdate: (version) => set((state) => ({
        ignoredVersions: [...state.ignoredVersions, version],
        isBannerVisible: false,
        pendingUpdate: null
      })),
      checkSnooze: () => {
        const { lastSnoozedAt, pendingUpdate, isBannerVisible, ignoredVersions } = get()
        if (!pendingUpdate || isBannerVisible) return
        if (ignoredVersions.includes(pendingUpdate.version)) return

        if (!lastSnoozedAt) {
          set({ isBannerVisible: true })
          return
        }

        const now = Date.now()
        const fiveMinutes = 5 * 60 * 1000
        if (now - lastSnoozedAt >= fiveMinutes) {
          set({ isBannerVisible: true, lastSnoozedAt: null })
        }
      }
    }),
    {
      name: 'exodus-update-store',
      partialize: (state) => ({ 
        lastSnoozedAt: state.lastSnoozedAt,
        pendingUpdate: state.pendingUpdate,
        ignoredVersions: state.ignoredVersions
      }),
    }
  )
)
