import { create } from 'zustand'

/**
 * E2E testing UI state. Today only the browser-missing dialog lives here;
 * later milestones add the test results panel and run state.
 *
 * Promise-based gate: tool code can `await promptBrowserMissing()` and
 * receive `true` only when the user has confirmed they will install Chrome
 * (any value other than that resolves to `false`, including dismiss).
 */
interface E2EStore {
  browserMissingOpen: boolean
  /** Internal — resolves the pending `promptBrowserMissing` promise. */
  _resolver: ((accepted: boolean) => void) | null
  promptBrowserMissing: () => Promise<boolean>
  resolveBrowserMissing: (accepted: boolean) => void
}

export const useE2EStore = create<E2EStore>()((set, get) => ({
  browserMissingOpen: false,
  _resolver: null,
  promptBrowserMissing() {
    return new Promise<boolean>(resolve => {
      const prev = get()._resolver
      if (prev) prev(false)
      set({ browserMissingOpen: true, _resolver: resolve })
    })
  },
  resolveBrowserMissing(accepted) {
    const r = get()._resolver
    if (r) r(accepted)
    set({ browserMissingOpen: false, _resolver: null })
  },
}))
