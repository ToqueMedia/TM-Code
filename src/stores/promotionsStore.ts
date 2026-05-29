import { create } from 'zustand'

// ── Promotion type (mirrored from @studio/shared) ──

export interface Promotion {
  id: string
  title: string
  description: string
  badge: string
  ctaText: string
  discountPercent: number
  targetPlanKey: string | null
  ctaUrl: string
  audience: string
  targetPlans: string[]
  startsAt: string
  endsAt: string
  color: string
  priority: number
  surfaces: string[]
  active: boolean
  createdAt: string
  updatedAt: string
}

/** Check if a promotion is currently active (within time window and enabled). */
export function isPromotionActive(promo: Pick<Promotion, 'active' | 'startsAt' | 'endsAt'>): boolean {
  if (!promo.active) return false
  const now = Date.now()
  const start = new Date(promo.startsAt).getTime()
  const end = new Date(promo.endsAt).getTime()
  return now >= start && now <= end
}

/** Filter promotions for a specific surface, active now, sorted by priority desc. */
export function filterActivePromotions(
  promotions: Promotion[],
  surface: string,
  currentPlan?: string,
): Promotion[] {
  return promotions
    .filter(p => isPromotionActive(p))
    .filter(p => p.surfaces.includes(surface))
    .filter(p => {
      if (p.audience === 'all') return true
      if (p.audience === 'specific_plans' && currentPlan) {
        return p.targetPlans.includes(currentPlan)
      }
      return true
    })
    .sort((a, b) => b.priority - a.priority)
}

// ── Promotions store ──
//
// Active promotions fetched from the backend /v1/me endpoint.
// The backend reads from Firestore `promotions` collection (KV-cached, 30s TTL)
// and filters by active=true + time window + surface='ide'.

interface PromotionsState {
  promotions: Promotion[]
  isLoaded: boolean
  updateFromMe: (promotions: Promotion[] | undefined) => void
}

export const usePromotionsStore = create<PromotionsState>(set => ({
  promotions: [],
  isLoaded: false,

  updateFromMe: (promotions) => {
    set({
      promotions: promotions ?? [],
      isLoaded: true,
    })
  },
}))
