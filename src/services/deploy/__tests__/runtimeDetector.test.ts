/**
 * Runtime detector tests — table-driven over the 12 templates TM Code
 * scaffolds plus the obvious edge cases (missing package.json, ambiguous
 * monorepos, Astro static vs server).
 *
 * The detector is a pure function over an FsView so these tests build a
 * MockFsView from a flat record of path → content. No Tauri.
 */
import { detectDeployPlan, type FsView } from '../runtimeDetector'

function mockFs(files: Record<string, string>): FsView {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readText: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
    readJson: <T = unknown>(p: string): T | null => {
      const text = Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null
      if (text === null) return null
      try {
        return JSON.parse(text) as T
      } catch {
        return null
      }
    },
  }
}

const pkg = (deps: Record<string, string>, extras: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 't', version: '0.0.0', dependencies: deps, ...extras })

describe('runtimeDetector — static-spa templates (Phase 1 supported)', () => {
  it('react-ts-vite → static-spa with dist outputDir', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ react: '^19', vite: '^8' }) }))
    expect(r.plan).toEqual({ kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' })
    expect(r.phase1Supported).toBe(true)
  })

  it('vue-ts-vite → static-spa', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ vue: '^3', vite: '^8' }) }))
    expect(r.plan?.kind).toBe('static-spa')
    expect(r.phase1Supported).toBe(true)
  })

  it('svelte-ts-vite (no @sveltejs/kit) → static-spa', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ svelte: '^5', vite: '^8' }) }))
    expect(r.plan?.kind).toBe('static-spa')
    expect(r.phase1Supported).toBe(true)
  })

  it('astro static (no config) → static-spa', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ astro: '^4' }) }))
    expect(r.plan).toEqual({ kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' })
    expect(r.phase1Supported).toBe(true)
  })

  it('astro static (output: "static" explicit) → static-spa', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': pkg({ astro: '^4' }),
        'astro.config.mjs': `export default defineConfig({ output: 'static' })`,
      }),
    )
    expect(r.plan?.kind).toBe('static-spa')
    expect(r.phase1Supported).toBe(true)
  })

  it('angular-ts → static-spa with outputPath from angular.json', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': pkg({ '@angular/core': '^18' }),
        'angular.json': JSON.stringify({
          projects: { myapp: { architect: { build: { options: { outputPath: 'dist/myapp' } } } } },
        }),
      }),
    )
    expect(r.plan).toEqual({ kind: 'static-spa', outputDir: 'dist/myapp', spaFallback: 'index.html' })
    expect(r.phase1Supported).toBe(true)
  })

  it('angular with no angular.json → static-spa with dist fallback', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ '@angular/core': '^18' }) }))
    expect(r.plan).toEqual({ kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' })
    expect(r.phase1Supported).toBe(true)
  })

  it('angular targets schema (new CLI) → also reads outputPath', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': pkg({ '@angular/core': '^18' }),
        'angular.json': JSON.stringify({
          projects: { app: { targets: { build: { options: { outputPath: 'dist/app/browser' } } } } },
        }),
      }),
    )
    expect((r.plan as { outputDir: string }).outputDir).toBe('dist/app/browser')
  })
})

describe('runtimeDetector — cf-ssr templates (Phase 2)', () => {
  it('next.js → cf-ssr next-on-pages', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ next: '^15', react: '^19' }) }))
    expect(r.plan).toMatchObject({ kind: 'cf-ssr', adapter: 'next-on-pages' })
    expect(r.phase1Supported).toBe(false)
  })

  it('nuxt → cf-ssr nuxt', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ nuxt: '^3', vue: '^3' }) }))
    expect(r.plan).toMatchObject({ kind: 'cf-ssr', adapter: 'nuxt' })
    expect(r.phase1Supported).toBe(false)
  })

  it('sveltekit → cf-ssr sveltekit', () => {
    const r = detectDeployPlan(
      mockFs({ 'package.json': pkg({ '@sveltejs/kit': '^2', svelte: '^5', vite: '^8' }) }),
    )
    expect(r.plan).toMatchObject({ kind: 'cf-ssr', adapter: 'sveltekit' })
    expect(r.phase1Supported).toBe(false)
  })

  it('astro server-mode → cf-ssr astro', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': pkg({ astro: '^4' }),
        'astro.config.ts': `export default defineConfig({ output: "server" })`,
      }),
    )
    expect(r.plan).toMatchObject({ kind: 'cf-ssr', adapter: 'astro' })
    expect(r.phase1Supported).toBe(false)
  })

  it('astro hybrid-mode → cf-ssr astro', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': pkg({ astro: '^4' }),
        'astro.config.mjs': `export default defineConfig({ output: 'hybrid' })`,
      }),
    )
    expect(r.plan).toMatchObject({ kind: 'cf-ssr', adapter: 'astro' })
  })
})

describe('runtimeDetector — workers-container templates (Phase 3)', () => {
  it('express-ts → workers-container Node', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ express: '^5' }) }))
    expect(r.plan).toMatchObject({
      kind: 'workers-container',
      runtime: { lang: 'node', version: '22' },
    })
    expect(r.phase1Supported).toBe(false)
  })

  it('fastify-ts → workers-container Node', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ fastify: '^5' }) }))
    expect(r.plan?.kind).toBe('workers-container')
    expect(r.phase1Supported).toBe(false)
  })

  it('nestjs-ts → workers-container Node', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ '@nestjs/core': '^10' }) }))
    expect(r.plan?.kind).toBe('workers-container')
    expect(r.phase1Supported).toBe(false)
  })
})

describe('runtimeDetector — composite (fullstack monorepo)', () => {
  it('react-express-ts shape → composite plan', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': JSON.stringify({ workspaces: ['client', 'server'] }),
        'client/package.json': pkg({ react: '^19', vite: '^8' }),
        'server/package.json': pkg({ express: '^5' }),
      }),
    )
    expect(r.plan).toMatchObject({
      kind: 'composite',
      apiPrefix: '/api',
      frontend: { kind: 'static-spa', outputDir: 'client/dist' },
      backend: { kind: 'workers-container', runtime: { lang: 'node' } },
    })
    expect(r.phase1Supported).toBe(false) // Phase 4
  })

  it('workspaces with packages object form is also recognised', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': JSON.stringify({ workspaces: { packages: ['client', 'server'] } }),
        'client/package.json': pkg({ react: '^19', vite: '^8' }),
        'server/package.json': pkg({ fastify: '^5' }),
      }),
    )
    expect(r.plan?.kind).toBe('composite')
  })

  it('workspaces but no client/server dirs → falls through to single-project detection', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': JSON.stringify({
          workspaces: ['packages/*'],
          dependencies: { react: '^19', vite: '^8' },
        }),
      }),
    )
    expect(r.plan?.kind).toBe('static-spa')
  })
})

describe('runtimeDetector — non-Node runtimes (Phase 5)', () => {
  it('Python (pyproject.toml) → workers-container Python', () => {
    const r = detectDeployPlan(mockFs({ 'pyproject.toml': '[project]\nname="x"' }))
    expect(r.plan).toMatchObject({ kind: 'workers-container', runtime: { lang: 'python' } })
    expect(r.phase1Supported).toBe(false)
  })

  it('Go (go.mod) → workers-container Go', () => {
    const r = detectDeployPlan(mockFs({ 'go.mod': 'module x' }))
    expect(r.plan).toMatchObject({ kind: 'workers-container', runtime: { lang: 'go' } })
  })

  it('Rust (Cargo.toml) → workers-container Rust', () => {
    const r = detectDeployPlan(mockFs({ 'Cargo.toml': '[package]\nname="x"' }))
    expect(r.plan).toMatchObject({ kind: 'workers-container', runtime: { lang: 'rust' } })
  })
})

describe('runtimeDetector — null / unsupported', () => {
  it('empty filesystem → null plan with helpful reason', () => {
    const r = detectDeployPlan(mockFs({}))
    expect(r.plan).toBeNull()
    expect(r.phase1Supported).toBe(false)
    expect(r.reason).toMatch(/no package\.json/i)
  })

  it('package.json with no known framework → null', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ lodash: '^4' }) }))
    expect(r.plan).toBeNull()
    expect(r.reason).toMatch(/could not figure out|supported framework/i)
  })

  it('vite without a frontend framework → not classified as SPA', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ vite: '^8' }) }))
    expect(r.plan).toBeNull()
  })

  it('malformed package.json → treated as missing', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': '{ not valid json' }))
    expect(r.plan).toBeNull()
  })
})

describe('runtimeDetector — hidden backend warnings', () => {
  it('flat fullstack: Vite SPA + Express in same package.json → static-spa with warning', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': pkg({ react: '^19', vite: '^8', express: '^4', '@prisma/client': '^6' }),
      }),
    )
    expect(r.plan?.kind).toBe('static-spa')
    expect(r.phase1Supported).toBe(true)
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toMatch(/backend/i)
  })

  it('flat fullstack via server/ dir → static-spa with warning', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': pkg({ react: '^19', vite: '^8' }),
        'server/index.ts': 'import express from "express"',
      }),
    )
    expect(r.plan?.kind).toBe('static-spa')
    expect(r.warnings.length).toBe(1)
  })

  it('clean Vite SPA (no backend deps, no server/) → no warning', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ react: '^19', vite: '^8' }) }))
    expect(r.plan?.kind).toBe('static-spa')
    expect(r.warnings).toEqual([])
  })

  it('Astro static with backend deps → static-spa with warning', () => {
    const r = detectDeployPlan(
      mockFs({ 'package.json': pkg({ astro: '^4', fastify: '^5' }) }),
    )
    expect(r.plan?.kind).toBe('static-spa')
    expect(r.warnings.length).toBe(1)
  })
})

describe('runtimeDetector — precedence', () => {
  it('Next.js wins over plain vite when both are declared', () => {
    const r = detectDeployPlan(mockFs({ 'package.json': pkg({ next: '^15', react: '^19', vite: '^8' }) }))
    expect(r.plan).toMatchObject({ kind: 'cf-ssr', adapter: 'next-on-pages' })
  })

  it('Composite wins over the SPA-only signals of its inner client/', () => {
    const r = detectDeployPlan(
      mockFs({
        'package.json': JSON.stringify({
          workspaces: ['client', 'server'],
          dependencies: { vite: '^8', react: '^19' },
        }),
        'client/package.json': pkg({ react: '^19', vite: '^8' }),
        'server/package.json': pkg({ express: '^5' }),
      }),
    )
    expect(r.plan?.kind).toBe('composite')
  })
})
