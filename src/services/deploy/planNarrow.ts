/**
 * Narrow a DeployPlan to the kinds the deploy flow can actually handle
 * today. Extracted into its own module so tests can import it without
 * dragging in deployService's Tauri / Firebase imports.
 *
 * Phase 1 supports `static-spa` and `composite`. cf-ssr (Next/Nuxt/SvelteKit
 * /Astro-SSR) is detected but Phase 2 isn't wired — surface a precise
 * error pointing at the framework so the user knows it's known-unsupported
 * rather than a generic detector failure. Pure workers-container is rare
 * and pushed to a follow-up.
 */
import type { DeployPlan, StaticSpaPlan, CompositePlan } from './deployPlan'

export function ensureSupported(plan: DeployPlan): StaticSpaPlan | CompositePlan {
  if (plan.kind === 'static-spa' || plan.kind === 'composite') return plan
  if (plan.kind === 'cf-ssr') {
    const friendly: Record<typeof plan.adapter, string> = {
      'next-on-pages': 'Next.js',
      nuxt: 'Nuxt',
      sveltekit: 'SvelteKit',
      astro: 'Astro (SSR mode)',
    }
    const name = friendly[plan.adapter]
    throw new Error(
      `${name} projects can't be published yet — server-rendered framework support is on the roadmap. ` +
        `For now, either switch to static export if your app doesn't need SSR, or wait for the upcoming release.`,
    )
  }
  if (plan.kind === 'workers-container') {
    throw new Error(
      `Backend-only projects can't be published on their own. Add a frontend (a client/ folder with Vite, ` +
        `or React/Vue/Svelte in src/) and ask TM Code to prepare your project for publishing — it will set up ` +
        `the data layer and the build pipeline for you.`,
    )
  }
  throw new Error(`This project shape isn't supported by Publish yet.`)
}
