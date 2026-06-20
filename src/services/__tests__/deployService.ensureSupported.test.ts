/**
 * ensureSupported regression tests — pins the error messages users see
 * when their detected DeployPlan isn't yet wired through the deploy flow.
 *
 * Phase 1 supports `static-spa`, `composite`, and `next-standalone`. cf-ssr
 * (Nuxt/SvelteKit/Astro-SSR) is detected but Phase 2 isn't implemented; pure
 * workers-container is rare and pushed to a follow-up. Each rejection produces
 * a precise message naming the framework so the user knows it's
 * known-unsupported, not a detector bug.
 */
import type { DeployPlan } from '../deploy/deployPlan'
import { ensureSupported } from '../deploy/planNarrow'

describe('ensureSupported', () => {
  it('accepts static-spa unchanged', () => {
    const plan: DeployPlan = { kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' }
    expect(ensureSupported(plan)).toBe(plan)
  })

  it('accepts composite unchanged', () => {
    const plan: DeployPlan = {
      kind: 'composite',
      frontend: { kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' },
      backend: { kind: 'workers-container', runtime: { lang: 'node', version: '22' }, port: 8080, envVars: [] },
      apiPrefix: '/api',
    }
    expect(ensureSupported(plan)).toBe(plan)
  })

  it('accepts next-standalone unchanged', () => {
    const plan: DeployPlan = { kind: 'next-standalone', port: 8080 }
    expect(ensureSupported(plan)).toBe(plan)
  })

  describe('cf-ssr — server-rendered frameworks not yet supported', () => {
    it('Nuxt → friendly name in error', () => {
      const plan: DeployPlan = {
        kind: 'cf-ssr',
        adapter: 'nuxt',
        assetsDir: '.output/public',
        workerEntry: '.output/server/index.mjs',
      }
      expect(() => ensureSupported(plan)).toThrow(/Nuxt projects can't be published yet/i)
    })

    it('SvelteKit → friendly name in error', () => {
      const plan: DeployPlan = {
        kind: 'cf-ssr',
        adapter: 'sveltekit',
        assetsDir: '.svelte-kit/cloudflare',
        workerEntry: '.svelte-kit/cloudflare/_worker.js',
      }
      expect(() => ensureSupported(plan)).toThrow(/SvelteKit projects can't be published yet/i)
    })

    it('Astro SSR → friendly name in error', () => {
      const plan: DeployPlan = {
        kind: 'cf-ssr',
        adapter: 'astro',
        assetsDir: 'dist/client',
        workerEntry: 'dist/_worker.js',
      }
      expect(() => ensureSupported(plan)).toThrow(/Astro \(SSR mode\) projects can't be published yet/i)
    })
  })

  describe('workers-container alone — not supported in Phase 1', () => {
    it('Node backend without frontend points user at composite path', () => {
      const plan: DeployPlan = {
        kind: 'workers-container',
        runtime: { lang: 'node', version: '22' },
        port: 8080,
        envVars: [],
      }
      expect(() => ensureSupported(plan)).toThrow(/Backend-only projects can't be published on their own/i)
    })

    it('Python backend without frontend → same error path', () => {
      const plan: DeployPlan = {
        kind: 'workers-container',
        runtime: { lang: 'python', version: '3.12' },
        port: 8000,
        envVars: [],
      }
      expect(() => ensureSupported(plan)).toThrow(/Backend-only projects can't be published on their own/i)
    })
  })
})
