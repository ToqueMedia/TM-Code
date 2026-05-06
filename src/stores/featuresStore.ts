import { create } from 'zustand'

// ── Feature flags ──
//
// Global toggles for staged rollouts. Bootstrapped from /v1/me on app launch
// (see firebaseAuth.fetchBillingInfo). The backend reads features/global in
// Firestore — same KV-cached pattern as plan config — so ops can flip a flag
// and all clients converge within ~90s without an IDE redeploy.
//
// Defaults are all OFF: missing flag = feature unavailable, fail closed.
//
// Add new flags here AND in the backend FeatureFlags interface
// (toquemedia-studio-api/src/firestore.ts).

export interface FeatureFlags {
  /** BYOK (Bring Your Own Key): enables the "API Keys" Settings section
   *  and BYOK request routing. Per-plan eligibility is enforced by the
   *  backend via subscription_plans/{plan}.byokAllowed; this flag is a
   *  global kill-switch for staged rollouts. */
  byokEnabled: boolean
}

const DEFAULTS: FeatureFlags = {
  byokEnabled: false,
}

interface FeaturesState extends FeatureFlags {
  isLoaded: boolean
  updateFromMe: (features: Partial<FeatureFlags> | undefined) => void
}

export const useFeaturesStore = create<FeaturesState>(set => ({
  ...DEFAULTS,
  isLoaded: false,

  updateFromMe: (features) => {
    set({
      byokEnabled: features?.byokEnabled === true,
      isLoaded: true,
    })
  },
}))
