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
 *   No env value:       hard-coded localhost fallback, except AI data plane
 *                       which must be configured explicitly
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
  VITE_AI_WORKER_URL,
  VITE_DEPLOY_URL,
  DEFAULT_AI_WORKER_URL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_WORKER_URL,
  PRODUCTION_AI_WORKER_URL,
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
let _aiWorkerUrlLogged = false

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

export function resolveAIWorkerUrl(): string {
  const url = resolveUrl({
    envValue: VITE_AI_WORKER_URL,
    fallback: IS_VITE_DEV ? DEFAULT_AI_WORKER_URL : PRODUCTION_AI_WORKER_URL,
    isViteDev: IS_VITE_DEV,
    isWindows: IS_WINDOWS,
  })
  if (IS_VITE_DEV && !_aiWorkerUrlLogged) {
    _aiWorkerUrlLogged = true
    console.info(`[devUrls] AI Worker URL: ${url} (env=${VITE_AI_WORKER_URL ?? '<unset>'}, fallback=${IS_VITE_DEV ? DEFAULT_AI_WORKER_URL : PRODUCTION_AI_WORKER_URL}, mac/linux remap=${!IS_WINDOWS ? 'on' : 'off'})`)
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
 * Deploy URL.
 *
 * - VITE_DEPLOY_URL set: explicit override (staging Worker, etc.).
 * - IDE in Vite dev: uses the dev Worker (`resolveWorkerUrl()`). The dev
 *   Worker's `isDev(env)` bypass relaxes token verification so dev Firebase
 *   tokens pass. R2 uploads go through the Cloudflare REST API directly
 *   (not the miniflare binding) so files land in the real `tm-studio-sites`
 *   bucket that `*.toquemedia.net` serves from. Requires
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the Worker's `.dev.vars`.
 * - Production build: uses the production deploy URL.
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
