/**
 * Single source of truth for dev-environment backend URLs.
 *
 * **The problem this solves**: `.env` declares `VITE_WORKER_URL` and
 * `VITE_OLLAMA_URL` pointing to the UTM Linux-VM gateway (`192.168.64.1`)
 * because Windows+UTM users need that address to reach the Linux host daemons.
 * Vite bakes those values into the bundle at build time — on **every** OS —
 * so a Mac developer also ends up with network requests to 192.168.64.1 even
 * though their daemons are on localhost.
 *
 * The resolvers below honour the env value everywhere EXCEPT in dev on
 * non-Windows, where they substitute localhost for the 192.168.64.1 host
 * segment while preserving the port + path. Net result:
 *
 *   Mac / Linux dev:    192.168.64.1 → localhost (auto-fixed)
 *   Windows dev:        192.168.64.1 stays (correct for UTM)
 *   Production build:   env value used verbatim (remote HTTPS endpoint)
 *   No env value:       hard-coded localhost fallback
 *
 * The pure `resolveUrl()` function takes all inputs as arguments so it's
 * testable without needing to mock platform/viteEnv modules (which Jest's
 * moduleNameMapper short-circuits to static stubs). The convenience wrappers
 * `resolveWorkerUrl()` / `resolveOllamaUrl()` call the pure helper with the
 * real runtime values.
 */
import { IS_WINDOWS } from '@/utils/platform'
import {
  IS_VITE_DEV,
  VITE_OLLAMA_URL,
  VITE_WORKER_URL,
  VITE_DEPLOY_URL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_WORKER_URL,
  PRODUCTION_DEPLOY_URL,
} from '@/utils/viteEnv'

export interface ResolveUrlInput {
  /** Value of the env var (VITE_WORKER_URL / VITE_OLLAMA_URL) — may be undefined. */
  envValue: string | undefined
  /** Fallback when envValue is undefined (e.g., 'http://localhost:8787'). */
  fallback: string
  /** True when running under a Vite dev server. */
  isViteDev: boolean
  /** True when navigator.platform indicates a Windows host. */
  isWindows: boolean
}

/** Replace `192.168.64.1` in a URL with `localhost`, preserving port + path. */
function remapGatewayHost(url: string): string {
  return url.replace(/(^https?:\/\/)192\.168\.64\.1(:\d+)?(\/.*)?$/i, (_m, scheme, port, path) => {
    return `${scheme}localhost${port || ''}${path || ''}`
  })
}

/**
 * Pure resolver — takes deps as arguments, returns the URL the current host
 * should use. No side effects, no module-level reads. Fully unit-testable.
 */
export function resolveUrl(input: ResolveUrlInput): string {
  const { envValue, fallback, isViteDev, isWindows } = input
  if (!envValue) return fallback
  if (isViteDev && !isWindows) return remapGatewayHost(envValue)
  return envValue
}

// ─── Convenience wrappers: call the pure resolver with real runtime values ──

// Log the resolved Worker URL once on first call in dev so DevTools shows
// where requests are going (helps debug "is the IDE hitting prod or local?").
let _workerUrlLogged = false

export function resolveWorkerUrl(): string {
  const url = resolveUrl({
    envValue: VITE_WORKER_URL,
    fallback: DEFAULT_WORKER_URL,
    isViteDev: IS_VITE_DEV,
    isWindows: IS_WINDOWS,
  })
  if (IS_VITE_DEV && !_workerUrlLogged) {
    _workerUrlLogged = true
    console.info(`[devUrls] Worker URL: ${url} (env=${VITE_WORKER_URL ?? '<unset>'}, mac/linux remap=${!IS_WINDOWS ? 'on' : 'off'})`)
  }
  return url
}

export function resolveOllamaUrl(): string {
  return resolveUrl({
    envValue: VITE_OLLAMA_URL,
    fallback: DEFAULT_OLLAMA_URL,
    isViteDev: IS_VITE_DEV,
    isWindows: IS_WINDOWS,
  })
}

/**
 * Deploy URL — follows the same dev/prod split as `resolveWorkerUrl`:
 *
 *   - VITE_DEPLOY_URL set: use it verbatim (explicit override — staging
 *     workers, custom proxies, etc.).
 *   - IDE running under Vite dev: use the same dev worker as everything
 *     else (`resolveWorkerUrl()` — typically `localhost:8787` from
 *     `wrangler dev`). The dev worker's `authenticateRequest` bypasses
 *     strict token verification in `isDev(env)` mode, which is why we
 *     get clean 401s when dev tokens hit the production worker — the
 *     audience mismatch + App Check enforcement combo causes silent
 *     refresh failures, and the prod worker won't accept stale tokens.
 *   - Production build: use the production deploy URL.
 *
 * Side-effect caveat: a dev worker forwards container/build + Cloud Run
 * calls to real GCP using the same service-account secrets as production.
 * R2 + KV writes go to local wrangler state. If you want a fully
 * sandboxed dev deploy, point `VITE_DEPLOY_URL` at a dedicated staging
 * Worker — or just skip Publish in dev.
 */
export function resolveDeployUrl(): string {
  if (VITE_DEPLOY_URL) return VITE_DEPLOY_URL
  if (IS_VITE_DEV) return resolveWorkerUrl()
  return PRODUCTION_DEPLOY_URL
}

/** Exposed for the settingsStore self-heal check — URLs that we may have
 *  auto-selected in a prior run and are therefore safe to re-resolve on
 *  rehydration. User-chosen URLs outside this set stay verbatim. */
export function getAutoSelectedOllamaUrls(): ReadonlySet<string> {
  const set = new Set<string>([DEFAULT_OLLAMA_URL, 'http://192.168.64.1:11434'])
  if (VITE_OLLAMA_URL) set.add(VITE_OLLAMA_URL)
  return set
}
