/**
 * Project runtime detector — infers a project's runtime shape (static SPA,
 * SSR framework, backend container, fullstack composite) from its file
 * layout.
 *
 * History: this lived in `src/services/deploy/runtimeDetector.ts` as the
 * front-end of the managed Publish pipeline. The pipeline was removed with
 * the dev-only-IDE pivot (v1.0.0 — the managed product lives in TM Code
 * Web), but the DETECTION itself is generic project-shape analysis that the
 * collab Live Preview tunnel still depends on: it decides between running a
 * dev server (backend/SSR present) and serving a static build, and where a
 * static build's output directory is. The module moved here with the
 * Publish-specific response fields (`phase1Supported`, publish warnings,
 * `.toquemedia-deploy.json` persistence) stripped.
 *
 * The core is a pure function over an FsView (`detectRuntimePlan`) so the
 * detection logic is exhaustively testable without hitting Tauri. The
 * `detectFromProjectPath` helper wires it to the real filesystem via
 * `invoke('read_file', ...)`.
 *
 * Signal priority (first match wins):
 *   1. Monorepo workspaces + client/server dirs   → composite
 *   2. next.js in deps                            → next-standalone (Node server)
 *   3. nuxt in deps                               → cf-ssr nuxt
 *   4. @sveltejs/kit in deps                      → cf-ssr sveltekit
 *   5. astro in deps + config has output:server   → cf-ssr astro
 *   6. astro in deps (default static)             → static-spa
 *   7. @angular/core in deps                      → static-spa (outputDir from angular.json)
 *   8. vite in deps + react/vue/svelte            → static-spa (composite when a
 *      co-located backend + Dockerfile are present)
 *   9. express/fastify/@nestjs/core in deps       → node-backend container shape
 *  10. Non-Node runtimes (Python/Go/Rust)         → backend container shape
 */
import { invoke } from '@/utils/invokeMetrics'

// ── Plan shapes ──────────────────────────────────────────────
// (Formerly `deploy/deployPlan.ts` — trimmed to the shapes the detector
// emits; consumers only branch on `kind` and read static output dirs.)

export type SsrAdapter = 'sveltekit' | 'nuxt' | 'astro'

export type ContainerRuntime =
  | { lang: 'node'; version: '20' | '22' }
  | { lang: 'python'; version: '3.12' }
  | { lang: 'go'; version: '1.22' }
  | { lang: 'rust'; edition: '2021' }
  | { lang: 'ruby' | 'java'; version: string }

/** Pure static SPA — Vite/Angular/Astro-static builds to a flat output dir. */
export interface StaticSpaPlan {
  kind: 'static-spa'
  /** Path relative to project root, e.g. 'dist' or 'dist/my-app/browser'. */
  outputDir: string
  /** File served for unmatched routes (SPA routing). Default 'index.html'. */
  spaFallback?: string
}

/** Framework-SSR build (framework emits static assets + a server entry). */
export interface CfSsrPlan {
  kind: 'cf-ssr'
  adapter: SsrAdapter
  /** Static assets dir (rendered HTML, hashed JS/CSS). */
  assetsDir: string
  /** Path to the framework-emitted server/worker entry. */
  workerEntry: string
}

/** User-owned backend server (Express/Fastify/Nest, or non-Node runtimes). */
export interface WorkersContainerPlan {
  kind: 'workers-container'
  runtime: ContainerRuntime
  /** Port the user's server listens on. */
  port: number
  /** Names of env vars the server expects at runtime. */
  envVars: string[]
}

/** Next.js — one standalone Node server serves SSR + routes + assets. */
export interface NextStandalonePlan {
  kind: 'next-standalone'
  /** Port the standalone server listens on (server.js honours PORT). */
  port: number
}

/** Frontend + backend side by side; /api goes to the backend. */
export interface CompositePlan {
  kind: 'composite'
  frontend: StaticSpaPlan | CfSsrPlan
  backend: WorkersContainerPlan
  /** URL prefix routed to the backend. Default '/api'. */
  apiPrefix: string
}

export type RuntimePlan =
  | StaticSpaPlan
  | CfSsrPlan
  | WorkersContainerPlan
  | CompositePlan
  | NextStandalonePlan

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
  plan: RuntimePlan | null
  /** Human-readable explanation, for debugging. */
  reason: string
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
 * The composite detection at the top of `detectRuntimePlan` covers the
 * canonical workspaces+client+server shape. But many user-scaffolded
 * projects keep the frontend at the root and put the backend in a sibling
 * directory without declaring workspaces. The detector still classifies
 * these as static-spa when no Dockerfile is present, so consumers that need
 * a LIVE backend (Live Preview) must check for the sibling dir themselves —
 * this helper flags the shape.
 *
 * Signals checked:
 *  - Backend deps in the root package.json: express / fastify / @nestjs/core
 *    / hono / koa / restify
 *  - Sibling directory `server/` or `backend/` (presence of its
 *    package.json or a TS entry)
 */
function detectHiddenBackend(fs: FsView, deps: Set<string>): boolean {
  const backendDeps = ['express', 'fastify', '@nestjs/core', 'hono', 'koa', 'restify']
  const hasBackendDep = backendDeps.some((d) => deps.has(d))
  const hasServerDir =
    fs.exists('server/package.json') ||
    fs.exists('backend/package.json') ||
    fs.exists('server/index.ts') ||
    fs.exists('server/index.js') ||
    fs.exists('backend/index.ts')
  return hasBackendDep || hasServerDir
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
  // Both work because consumers look for index.html under the given path and
  // walk one level if not found.
  return outputPath
}

// ── Core detector ────────────────────────────────────────────

export function detectRuntimePlan(fs: FsView): DetectionResult {
  const pkg = fs.readJson<PackageJson>('package.json')

  // 1. Composite (monorepo) — workspaces + client/server dirs ─
  if (pkg && hasWorkspaces(pkg) && fs.exists('client/package.json') && fs.exists('server/package.json')) {
    const clientFs = scopedFs(fs, 'client')
    const serverFs = scopedFs(fs, 'server')
    const clientResult = detectRuntimePlan(clientFs)
    const serverResult = detectRuntimePlan(serverFs)
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
        reason: 'Fullstack monorepo detected (client + server workspaces).',
      }
    }
    // Workspaces exist but parts don't classify cleanly — fall through to
    // single-project signals below.
  }

  const deps = allDeps(pkg)

  // 2. Next.js ─────────────────────────────────────────────────
  if (deps.has('next')) {
    const plan: NextStandalonePlan = { kind: 'next-standalone', port: 8080 }
    return { plan, reason: 'Next.js project detected.' }
  }

  // 3. Nuxt ────────────────────────────────────────────────────
  if (deps.has('nuxt')) {
    return {
      plan: { kind: 'cf-ssr', adapter: 'nuxt', assetsDir: '.output/public', workerEntry: '.output/server/index.mjs' },
      reason: 'Nuxt project detected.',
    }
  }

  // 4. SvelteKit ───────────────────────────────────────────────
  if (deps.has('@sveltejs/kit')) {
    return {
      plan: { kind: 'cf-ssr', adapter: 'sveltekit', assetsDir: '.svelte-kit/cloudflare', workerEntry: '.svelte-kit/cloudflare/_worker.js' },
      reason: 'SvelteKit project detected.',
    }
  }

  // 5. Astro ───────────────────────────────────────────────────
  if (deps.has('astro')) {
    const mode = detectAstroOutputMode(readAstroConfig(fs))
    if (mode === 'static') {
      return {
        plan: { kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' },
        reason: 'Astro (static) project detected.',
      }
    }
    return {
      plan: { kind: 'cf-ssr', adapter: 'astro', assetsDir: 'dist/client', workerEntry: 'dist/_worker.js' },
      reason: 'Astro project with server-rendered output detected.',
    }
  }

  // 6. Angular ─────────────────────────────────────────────────
  if (deps.has('@angular/core')) {
    return {
      plan: { kind: 'static-spa', outputDir: detectAngularOutputDir(fs), spaFallback: 'index.html' },
      reason: 'Angular project detected.',
    }
  }

  // 7. Vite SPA ────────────────────────────────────────────────
  if (deps.has('vite') && (deps.has('react') || deps.has('vue') || deps.has('svelte') || deps.has('solid-js') || deps.has('preact'))) {
    const hiddenBackend = detectHiddenBackend(fs, deps)
    // Fullstack flat layout: frontend at the root + co-located backend with
    // a Dockerfile. Classified composite so consumers know a backend rides
    // along with the static frontend.
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
        reason: 'Fullstack project detected (Vite frontend + backend container).',
      }
    }
    return {
      plan: { kind: 'static-spa', outputDir: 'dist', spaFallback: 'index.html' },
      reason: 'Frontend SPA project detected (Vite).',
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
      reason: 'Backend project detected (Express / Fastify / NestJS).',
    }
  }

  // 9. Non-Node runtimes ───────────────────────────────────────
  if (fs.exists('pyproject.toml') || fs.exists('requirements.txt')) {
    return {
      plan: { kind: 'workers-container', runtime: { lang: 'python', version: '3.12' }, port: 8000, envVars: [] },
      reason: 'Python project detected.',
    }
  }
  if (fs.exists('go.mod')) {
    return {
      plan: { kind: 'workers-container', runtime: { lang: 'go', version: '1.22' }, port: 8080, envVars: [] },
      reason: 'Go project detected.',
    }
  }
  if (fs.exists('Cargo.toml')) {
    return {
      plan: { kind: 'workers-container', runtime: { lang: 'rust', edition: '2021' }, port: 8080, envVars: [] },
      reason: 'Rust project detected.',
    }
  }

  return {
    plan: null,
    reason: pkg
      ? 'Could not classify this project from its package.json.'
      : 'No package.json or known project manifest found at the project root.',
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

class TauriFsView implements FsView {
  private cache = new Map<string, string | null>()
  constructor(private readonly projectPath: string) {}

  private read(relativePath: string): string | null {
    if (this.cache.has(relativePath)) return this.cache.get(relativePath)!
    // Tauri's read_file is async; the detector is sync — so the entry helper
    // pre-loads candidate files into the cache before calling detectRuntimePlan.
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
    'astro.config.ts',
    'astro.config.mjs',
    'astro.config.js',
    'astro.config.cjs',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
    'Dockerfile',
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
  return detectRuntimePlan(view)
}
