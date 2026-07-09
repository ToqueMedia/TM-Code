// Dedicated team Live Preview server on port 7773 — strategy chosen per project:
//
//  • Pure static SPA (no backend) → run the BUILD and serve the static output
//    through an in-process Rust static server. No /@fs, no source, no dev
//    endpoints — the fully-secure path.
//
//  • Fullstack / SSR / has a local backend → run the DEV server forced to 7773.
//    A static build would drop the backend, so API calls (e.g. /api/login) would
//    404 — which is exactly the "login stopped working" report. Running the dev
//    server keeps the backend + DB reachable through the tunnel. (Secret/VCS/key
//    paths are still refused by previewPathGuard at the tunnel hop.)
//
// Both run on 7773, coexist with the Chat preview, and are killed on stop / on
// app exit. No imports from collabSessionService (keeps the graph acyclic).

import { invoke } from '@/utils/invokeMetrics'
import { listen } from '@tauri-apps/api/event'
import { detectDevCommand } from '@/services/previewActivation'
import { detectFromProjectPath } from '@/services/projectRuntimeDetector'
import { detectProjectPackageManager } from '@/services/packageManagerDetector'

/** Dedicated, fixed port for the team Live Preview server. */
export const LIVE_PREVIEW_PORT = 7773

const READY_TIMEOUT_MS = 45_000
const READY_POLL_MS = 500
const BUILD_TIMEOUT_SECS = 300

/** PID of a dev-server strategy run (null otherwise). */
let serverPid: number | null = null
/** True while a static-server strategy is serving. */
let serving = false

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
  timedOut: boolean
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const BACKEND_DEPS = ['express', 'fastify', '@nestjs/core', 'hono', 'koa', 'restify']

async function pathExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>('path_exists', { path })
  } catch {
    return false
  }
}

async function readPackageJson(projectPath: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await invoke<string>('read_file', { path: `${projectPath}/package.json` })) as PackageJson
  } catch {
    return null
  }
}

/** Poll until something answers on 127.0.0.1:7773, or the timeout elapses. */
async function probeReady(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const r = await invoke<{ ok: boolean }>('probe_server', {
        url: `http://127.0.0.1:${LIVE_PREVIEW_PORT}`,
      })
      if (r?.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS))
  }
  return false
}

export function isLivePreviewServerRunning(): boolean {
  return serving || serverPid !== null
}

// ── Strategy decision ────────────────────────────────────────────────────────

/**
 * True when the project needs a LIVE server (backend / SSR) for the preview to
 * actually work — in which case we run the dev server instead of serving a
 * static build (which would have no backend).
 */
async function needsLiveServer(projectPath: string): Promise<boolean> {
  let plan = null
  try {
    plan = (await detectFromProjectPath(projectPath)).plan
  } catch {
    plan = null
  }
  // Anything that isn't a pure static SPA needs a running server.
  if (!plan) return true
  if (plan.kind !== 'static-spa') return true

  // static-spa, but check for a co-located backend (flat fullstack apps are
  // classified static-spa with only a warning).
  if (await pathExists(`${projectPath}/server/package.json`)) return true
  if (await pathExists(`${projectPath}/backend/package.json`)) return true
  const pkg = await readPackageJson(projectPath)
  const deps = new Set([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ])
  if (BACKEND_DEPS.some((d) => deps.has(d))) return true

  return false
}

// ── Strategy A: dev server (fullstack / SSR / backend) ───────────────────────

/** Extract a port from a localhost-ish URL, normalised. */
function portOf(url: string): number | null {
  try {
    const p = parseInt(new URL(url).port, 10)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/gi

/**
 * Detect the FRONTEND port from the dev server's output. A fullstack dev runs
 * several processes (vite + express + …); we must tunnel the one that serves
 * HTML (the frontend, which proxies /api to the backend) — NOT the backend
 * (which, in many setups, only serves the built client in prod → ENOENT in dev).
 * Re-probes every announced URL until one answers as a usable frontend.
 */
async function detectFrontendPort(pid: number): Promise<number | null> {
  const seen = new Set<string>()
  const unlisten = await listen<{ pid: number; data: string }>('dev-server-output', (e) => {
    if (e.payload?.pid !== pid) return
    const matches = e.payload.data.match(URL_IN_LOG)
    if (matches) for (const m of matches) seen.add(m)
  })
  const deadline = Date.now() + READY_TIMEOUT_MS
  try {
    while (Date.now() < deadline) {
      for (const url of seen) {
        const norm = url
          .replace('://localhost', '://127.0.0.1')
          .replace('://0.0.0.0', '://127.0.0.1')
          .replace('://[::1]', '://127.0.0.1')
        try {
          const r = await invoke<{ ok: boolean; usable_as_frontend?: boolean }>('probe_server', {
            url: norm,
          })
          if (r?.ok && r.usable_as_frontend) return portOf(norm)
        } catch {
          /* not ready */
        }
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
  } finally {
    unlisten()
  }
  return null
}

async function startDevServerStrategy(projectPath: string): Promise<number> {
  const cmd = await detectDevCommand(projectPath)
  if (!cmd) throw new Error('no-dev-command')
  // Do NOT force a port: setting PORT/--port on a multi-process dev (frontend +
  // backend) hijacks the BACKEND onto our port, so the tunnel ends up serving
  // the API server which can't find the unbuilt client/dist (the ENOENT bug).
  // Run the dev server as-is and tunnel the detected FRONTEND port instead.
  serverPid = await invoke<number>('start_dev_server', {
    command: cmd,
    cwd: projectPath,
    port: 0,
    skipPortEnv: true,
  })
  const port = await detectFrontendPort(serverPid)
  if (port == null) {
    await stopLivePreviewServer()
    throw new Error('timeout')
  }
  return port
}

// ── Strategy B: static build (pure SPA) ──────────────────────────────────────

function buildCommandFor(pm: PackageManager): string {
  return pm === 'yarn' || pm === 'pnpm' ? `${pm} build` : `${pm} run build`
}

/** Resolve the static build output directory (absolute), or null if none. */
async function resolveOutputDir(projectPath: string): Promise<string | null> {
  try {
    const { plan } = await detectFromProjectPath(projectPath)
    if (plan?.kind === 'static-spa') return `${projectPath}/${plan.outputDir}`
    if (plan?.kind === 'composite' && plan.frontend.kind === 'static-spa') {
      return `${projectPath}/${plan.frontend.outputDir}`
    }
  } catch {
    /* fall through to probing */
  }
  for (const d of ['dist', 'build', 'out', 'dist/client', '.output/public']) {
    if (await pathExists(`${projectPath}/${d}/index.html`)) return `${projectPath}/${d}`
  }
  return null
}

async function startStaticStrategy(projectPath: string): Promise<number> {
  const pkg = await readPackageJson(projectPath)
  if (!pkg?.scripts?.build?.trim()) throw new Error('no-build-command')

  const pm = await detectProjectPackageManager(projectPath)
  const result = await invoke<CommandResult>('execute_command', {
    command: buildCommandFor(pm),
    cwd: projectPath,
    timeoutSecs: BUILD_TIMEOUT_SECS,
  })
  if (!result?.success) throw new Error('build-failed')

  const dir = await resolveOutputDir(projectPath)
  if (!dir) throw new Error('no-build-output')

  await invoke('live_preview_serve_static', { dir, port: LIVE_PREVIEW_PORT })
  serving = true
  if (!(await probeReady())) {
    await stopLivePreviewServer()
    throw new Error('timeout')
  }
  return LIVE_PREVIEW_PORT
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the Live Preview server on 7773, choosing the strategy automatically.
 * Throws an Error with a code the caller maps to a message:
 *   'no-dev-command' | 'no-build-command' | 'build-failed' | 'no-build-output' |
 *   'timeout'.
 */
export async function startLivePreviewServer(projectPath: string): Promise<number> {
  await stopLivePreviewServer()
  if (await needsLiveServer(projectPath)) {
    return startDevServerStrategy(projectPath)
  }
  return startStaticStrategy(projectPath)
}

/** Stop whichever strategy is running (idempotent) + free the port. */
export async function stopLivePreviewServer(): Promise<void> {
  serving = false
  const pid = serverPid
  serverPid = null
  try {
    await invoke('live_preview_stop_static')
  } catch {
    /* nothing serving */
  }
  if (pid != null) {
    try {
      await invoke('kill_process', { pid })
    } catch {
      /* already dead / not in map */
    }
  }
  try {
    await invoke('kill_port', { port: LIVE_PREVIEW_PORT })
  } catch {
    /* best effort */
  }
}
