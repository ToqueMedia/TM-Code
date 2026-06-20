/**
 * Runtime detector — infers a DeployPlan from a project's file layout.
 *
 * The core is a pure function over an FsView (`detectDeployPlan`) so the
 * detection logic is exhaustively testable without hitting Tauri. The
 * `detectFromProjectPath` helper wires it to the real filesystem via
 * `invoke('read_file', ...)`.
 *
 * Signal priority (first match wins):
 *   1. Monorepo workspaces + client/server dirs   → composite
 *   2. next.js in deps + output:'standalone'       → next-standalone (Cloud Run)
 *   3. nuxt in deps                               → cf-ssr nuxt
 *   4. @sveltejs/kit in deps                      → cf-ssr sveltekit
 *   5. astro in deps + config has output:server   → cf-ssr astro
 *   6. astro in deps (default static)             → static-spa
 *   7. @angular/core in deps                      → static-spa (outputDir from angular.json)
 *   8. vite in deps + react/vue/svelte            → static-spa
 *   9. express/fastify/@nestjs/core in deps       → workers-container Node
 *  10. Non-Node runtimes (Python/Go/Rust/Ruby/Java) — out of scope for Phase 1; returns null.
 *
 * Phase 1 deploys only `static-spa` end-to-end. Non-static plans are still
 * returned by the detector so the UI can surface "this template detected,
 * deploy support comes in Phase N".
 */
import type { DeployPlan, StaticSpaPlan, CfSsrPlan, NextStandalonePlan } from './deployPlan'

// ── FsView: minimal interface the detector needs ─────────────
export interface FsView {
  /** True iff a file at this project-relative path exists. */
  exists(relativePath: string): boolean
  /** Parsed JSON file, or null if absent/invalid. */
  readJson<T = unknown>(relativePath: string): T | null
  /** Raw text content, or null if absent. */
  readText(relativePath: string): string | null
}

export interface DetectionResult {
  /** The inferred plan, or null when the detector cannot tell. */
  plan: DeployPlan | null
  /** Human-readable explanation, for UI surfaces and debugging. */
  reason: string
  /** True iff Phase 1 can actually deploy this plan today. */
  phase1Supported: boolean
  /**
   * Non-fatal observations the UI should surface before publishing.
   * Example: a flat fullstack project where the SPA is deployable but a
   * sibling backend won't be — the user should know before clicking Publish.
   */
  warnings: string[]
}

// ── Helpers ──────────────────────────────────────────────────

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

function allDeps(pkg: PackageJson | null): Set<string> {
  if (!pkg) return new Set()
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])
}

function hasWorkspaces(pkg: PackageJson | null): boolean {
  if (!pkg?.workspaces) return false
  return Array.isArray(pkg.workspaces) || Array.isArray(pkg.workspaces.packages)
}

/**
 * Detect a backend living alongside the frontend in a flat project layout.
 *
 * The composite detection at the top of `detectDeployPlan` covers the
 * canonical workspaces+client+server shape. But many user-scaffolded
 * projects keep the frontend at the root and put the backend in a sibling
 * directory without declaring workspaces — e.g. the `react-express-prisma-auth`
 * template's runtime shape, or anything the agent scaffolds when asked for
 * "add auth" on a Vite project. The detector still classifies these as
 * static-spa (frontend deploys fine), but the user should know the backend
 * won't go with it before clicking Publish.
 *
 * Signals checked:
 *  - Backend deps in the root package.json: express / fastify / @nestjs/core
 *    / hono / koa / restify
 *  - Sibling directory `server/` or `backend/` (presence of its
 *    package.json or a TS entry)
 */
function detectHiddenBackend(fs: FsView, deps: Set<string>): string | null {
  const backendDeps = ['express', 'fastify', '@nestjs/core', 'hono', 'koa', 'restify']
  const hasBackendDep = backendDeps.some((d) => deps.has(d))
  const hasServerDir =
    fs.exists('server/package.json') ||
    fs.exists('backend/package.json') ||
    fs.exists('server/index.ts') ||
    fs.exists('server/index.js') ||
    fs.exists('backend/index.ts')
  if (!hasBackendDep && !hasServerDir) return null
  // Reached only on the static-spa fallback path — i.e. the project has a
  // backend but no Dockerfile, so Cloud Build has nothing to package.
  // Backend deploy IS supported (composite flow → Cloud Run); the missing
  // piece is the Dockerfile + the publish-ready data layer. The
  // `#deploy-backend` hashtag scaffolds both — surfacing the exact
  // recovery path is more useful than the previous "support is coming"
  // copy, which read as a feature gap when it was actually a project
  // preparation gap.
  return (
    'Detected a backend (server/ + Express/Fastify/Hono) but no Dockerfile at the project root. ' +
    'Without it, Publish can only ship the static frontend and `/api` calls will fail in production. ' +
    'Ask the agent `#deploy-backend` to scaffold the Dockerfile and switch the data layer to the platform DB — then re-publish.'
  )
}

/** Read one of next.config.{js,mjs,ts,cjs}, returning its raw text. */
function readNextConfig(fs: FsView): string | null {
  for (const ext of ['js', 'mjs', 'ts', 'cjs']) {
    const text = fs.readText(`next.config.${ext}`)
    if (text) return text
  }
  return null
}

/**
 * True when the Next config opts into `output: 'standalone'` — the only
 * mode the container deploy supports (it's what emits `.next/standalone/
 * server.js`). Tolerant of single/double quotes and whitespace. A regex is
 * fine here: next.config is JS we can't safely eval, and the shape is
 * unambiguous enough that an AST parse isn't worth the cost.
 */
function nextHasStandaloneOutput(config: string | null): boolean {
  if (!config) return false
  return /output\s*:\s*['"]standalone['"]/.test(config)
}

/** Read one of astro.config.{ts,mjs,js,cjs}, returning its raw text. */
function readAstroConfig(fs: FsView): string | null {
  for (const ext of ['ts', 'mjs', 'js', 'cjs']) {
    const text = fs.readText(`astro.config.${ext}`)
    if (text) return text
  }
  return null
}

function detectAstroOutputMode(config: string | null): 'static' | 'server' | 'hybrid' {
  if (!config) return 'static'
  // Match `output: 'server'` or `output: "server"` (and 'hybrid'). Tolerant
  // of whitespace + extra commas. Regex over AST is fine for this single
  // shape — the AST cost isn't justified.
  const m = /output\s*:\s*['"]([a-z]+)['"]/.exec(config)
  if (!m) return 'static'
  const mode = m[1] as 'static' | 'server' | 'hybrid'
  return mode === 'server' || mode === 'hybrid' ? mode : 'static'
}

/** Resolve Angular's build outputPath from angular.json, with sane fallback. */
function detectAngularOutputDir(fs: FsView): string {
  const cfg = fs.readJson<{
    projects?: Record<string, {
      architect?: { build?: { options?: { outputPath?: string } } }
      targets?: { build?: { options?: { outputPath?: string } } }
    }>
  }>('angular.json')
  if (!cfg?.projects) return 'dist'
  const firstName = Object.keys(cfg.projects)[0]
  if (!firstName) return 'dist'
  const proj = cfg.projects[firstName]
  const outputPath =
    proj?.architect?.build?.options?.outputPath ??
    proj?.targets?.build?.options?.outputPath
  if (!outputPath) return `dist/${firstName}`
  // Angular 17+ writes to <outputPath>/browser by default; older to <outputPath>.
  // We don't know the version cheaply; both work because the strategy module
  // will look for index.html under the given path and walk one level if not found.
  return outputPath
}

// ── Core detector ────────────────────────────────────────────

export function detectDeployPlan(fs: FsView): DetectionResult {
  const pkg = fs.readJson<PackageJson>('package.json')

  // 1. Composite (monorepo) — workspaces + client/server dirs ─
  if (pkg && hasWorkspaces(pkg) && fs.exists('client/package.json') && fs.exists('server/package.json')) {
    const clientFs = scopedFs(fs, 'client')
    const serverFs = scopedFs(fs, 'server')
    const clientResult = detectDeployPlan(clientFs)
    const serverResult = detectDeployPlan(serverFs)
    if (
      clientResult.plan &&
      (clientResult.plan.kind === 'static-spa' || clientResult.plan.kind === 'cf-ssr') &&
      serverResult.plan?.kind === 'workers-container'
    ) {
      const front = clientResult.plan as StaticSpaPlan | CfSsrPlan
      const adjusted: StaticSpaPlan | CfSsrPlan =
        front.kind === 'static-spa'
          ? { ...front, outputDir: `client/${front.outputDir}` }
          : { ...front, assetsDir: `client/${front.assetsDir}`, workerEntry: `client/${front.workerEntry}` }
      return {
        plan: {
          kind: 'composite',
          frontend: adjusted,
          backend: serverResult.plan,
          apiPrefix: '/api',
        },
        reason: 'Fullstack project detected. Publish support for fullstack projects is coming soon.',
        phase1Supported: false,
        warnings: [],
      }
    }
    // Workspaces exist but parts don't classify cleanly — fall through to
    // single-project signals below.
  }

  const deps = allDeps(pkg)

  // 2. Next.js ─────────────────────────────────────────────────
  // Next deploys as a standalone Node server on a Cloudflare Container
  // (Cloud Run) — `output: 'standalone'` emits `.next/standalone/server.js`,
  // which the container runs and which serves SSR + route handlers + its own
  // static assets. Without that config the build never produces a server to
  // run, so we detect the plan either way but only mark it deployable when
  // standalone output is set, surfacing a precise fix otherwise.
  if (deps.has('next')) {
    const plan: NextStandalonePlan = { kind: 'next-standalone', port: 8080 }
    // `output: 'standalone'` is required (it emits the self-contained server
    // the container runs), but we no longer GATE on it — the deploy flow
    // injects it on publish (see deployService.ensureNextStandaloneConfig),
    // mirroring the auto-generated Dockerfile. So a Next project is always
    // deployable; we just warn when we'll be editing the config.
    const hasStandalone = nextHasStandaloneOutput(readNextConfig(fs))
    return {
      plan,
      reason: hasStandalone
        ? 'Next.js project detected (output: standalone).'
        : "Next.js project detected. Publish will enable `output: 'standalone'` in your next.config.",
      phase1Supported: true,
      warnings: hasStandalone
        ? []
        : [
            "next.config has no `output: 'standalone'` — Publish will add it (required for the container build).",
          ],
    }
  }

  // 3. Nuxt ────────────────────────────────────────────────────
  if (deps.has('nuxt')) {
    return {
      plan: { kind: 'cf-ssr', adapter: 'nuxt', assetsDir: '.output/public', workerEntry: '.output/server/index.mjs' },
      reason: 'Nuxt project detected. Publish support for Nuxt is coming soon.',
      phase1Supported: false,
      warnings: [],
    }
  }

  // 4. SvelteKit ───────────────────────────────────────────────
  if (deps.has('@sveltejs/kit')) {
    return {
      plan: { kind: 'cf-ssr', adapter: 'sveltekit', assetsDir: '.svelte-kit/cloudflare', workerEntry: '.svelte-kit/cloudflare/_worker.js' },
      reason: 'SvelteKit project detected. Publish support for SvelteKit is coming soon.',
      phase1Supported: false,
      warnings: [],
    }
  }

  // 5. Astro ───────────────────────────────────────────────────
  if (deps.has('astro')) {
    const mode = detectAstroOutputMode(readAstroConfig(fs))
    if (mode === 'static') {
      const hiddenBackend = detectHiddenBackend(fs, deps)
      return {
        plan: { kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' },
        reason: 'Astro (static) project detected.',
        phase1Supported: true,
        warnings: hiddenBackend ? [hiddenBackend] : [],
      }
    }
    return {
      plan: { kind: 'cf-ssr', adapter: 'astro', assetsDir: 'dist/client', workerEntry: 'dist/_worker.js' },
      reason: 'Astro project with server-rendered output detected. Publish support is coming soon.',
      phase1Supported: false,
      warnings: [],
    }
  }

  // 6. Angular ─────────────────────────────────────────────────
  if (deps.has('@angular/core')) {
    const hiddenBackend = detectHiddenBackend(fs, deps)
    return {
      plan: { kind: 'static-spa', outputDir: detectAngularOutputDir(fs), spaFallback: 'index.html' },
      reason: 'Angular project detected.',
      phase1Supported: true,
      warnings: hiddenBackend ? [hiddenBackend] : [],
    }
  }

  // 7. Vite SPA ────────────────────────────────────────────────
  if (deps.has('vite') && (deps.has('react') || deps.has('vue') || deps.has('svelte') || deps.has('solid-js') || deps.has('preact'))) {
    const hiddenBackend = detectHiddenBackend(fs, deps)
    // Composite-ready: hidden backend exists AND a Dockerfile is at the
    // project root. The build steps are inlined in the worker
    // (`cloudBuildSubmit.ts` ships `docker build`+`push` directly), so
    // `cloudbuild.yaml` is NOT a deploy prerequisite — only the Dockerfile
    // is. The earlier `&& fs.exists('cloudbuild.yaml')` guard came from an
    // older design where the worker read the YAML server-side; that path
    // was removed but the guard wasn't, demoting valid composite projects
    // to static-spa and surfacing the stale "backend deploy is coming"
    // warning. Dropping the YAML check restores the composite flow.
    if (hiddenBackend && fs.exists('Dockerfile')) {
      return {
        plan: {
          kind: 'composite',
          frontend: { kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' },
          backend: {
            kind: 'workers-container',
            runtime: { lang: 'node', version: '22' },
            port: 8080,
            envVars: [],
          },
          apiPrefix: '/api',
        },
        reason: 'Fullstack project detected (Vite + backend container) — ready for one-click deploy.',
        phase1Supported: true,
        warnings: [],
      }
    }
    return {
      plan: { kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' },
      reason: 'Frontend SPA project detected (Vite).',
      phase1Supported: true,
      warnings: hiddenBackend ? [hiddenBackend] : [],
    }
  }

  // 8. Node backend (Express / Fastify / Nest) ─────────────────
  if (deps.has('express') || deps.has('fastify') || deps.has('@nestjs/core')) {
    return {
      plan: {
        kind: 'workers-container',
        runtime: { lang: 'node', version: '22' },
        port: 3000,
        envVars: [],
      },
      reason: 'Backend project detected (Express / Fastify / NestJS). Publish support for backends is coming soon.',
      phase1Supported: false,
      warnings: [],
    }
  }

  // 9. Non-Node runtimes — Phase 5 territory ───────────────────
  if (fs.exists('pyproject.toml') || fs.exists('requirements.txt')) {
    return {
      plan: { kind: 'workers-container', runtime: { lang: 'python', version: '3.12' }, port: 8000, envVars: [] },
      reason: 'Python project detected. Publish support is coming soon.',
      phase1Supported: false,
      warnings: [],
    }
  }
  if (fs.exists('go.mod')) {
    return {
      plan: { kind: 'workers-container', runtime: { lang: 'go', version: '1.22' }, port: 8080, envVars: [] },
      reason: 'Go project detected. Publish support is coming soon.',
      phase1Supported: false,
      warnings: [],
    }
  }
  if (fs.exists('Cargo.toml')) {
    return {
      plan: { kind: 'workers-container', runtime: { lang: 'rust', edition: '2021' }, port: 8080, envVars: [] },
      reason: 'Rust project detected. Publish support is coming soon.',
      phase1Supported: false,
      warnings: [],
    }
  }

  return {
    plan: null,
    reason: pkg
      ? 'Could not figure out how to publish this project from its package.json. Make sure it uses a supported framework.'
      : 'No package.json or known project manifest found at the project root.',
    phase1Supported: false,
    warnings: [],
  }
}

// ── Scoped fs helper for composite detection ─────────────────
function scopedFs(fs: FsView, prefix: string): FsView {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`
  return {
    exists: (path) => fs.exists(`${p}${path}`),
    readJson: <T>(path: string) => fs.readJson<T>(`${p}${path}`),
    readText: (path) => fs.readText(`${p}${path}`),
  }
}

// ── Tauri-backed FsView + entry helper ───────────────────────

import { invoke } from '@/utils/invokeMetrics'

class TauriFsView implements FsView {
  private cache = new Map<string, string | null>()
  constructor(private readonly projectPath: string) {}

  private read(relativePath: string): string | null {
    if (this.cache.has(relativePath)) return this.cache.get(relativePath)!
    // Tauri's read_file is async; the detector is sync — so the entry helper
    // pre-loads candidate files into the cache before calling detectDeployPlan.
    return null
  }

  async preload(relativePaths: string[]): Promise<void> {
    await Promise.all(
      relativePaths.map(async (rel) => {
        if (this.cache.has(rel)) return
        try {
          const content = await invoke<string>('read_file', { path: `${this.projectPath}/${rel}` })
          this.cache.set(rel, content)
        } catch {
          this.cache.set(rel, null)
        }
      }),
    )
  }

  exists(relativePath: string): boolean {
    return this.read(relativePath) !== null
  }

  readJson<T = unknown>(relativePath: string): T | null {
    const text = this.read(relativePath)
    if (text === null) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  readText(relativePath: string): string | null {
    return this.read(relativePath)
  }
}

/**
 * Async entry point — preloads the small set of files the detector needs,
 * then runs detection. Cheaper than walking the project tree.
 */
export async function detectFromProjectPath(projectPath: string): Promise<DetectionResult> {
  const view = new TauriFsView(projectPath)
  await view.preload([
    'package.json',
    'angular.json',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'next.config.cjs',
    'astro.config.ts',
    'astro.config.mjs',
    'astro.config.js',
    'astro.config.cjs',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
    'Dockerfile',
    'cloudbuild.yaml',
    'client/package.json',
    'server/package.json',
    'client/angular.json',
    'client/astro.config.ts',
    'client/astro.config.mjs',
    // Hidden-backend signals from detectHiddenBackend — exists() checks
    // need the preload to have visited the path at least once.
    'backend/package.json',
    'server/index.ts',
    'server/index.js',
    'backend/index.ts',
  ])
  return detectDeployPlan(view)
}
