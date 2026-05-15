/**
 * Scaffolding detector — filesystem-based source of truth for which one-shot
 * provisioning flows have already been applied to a project.
 *
 * Why filesystem-based vs a separate manifest file:
 *   - Cannot desync (the .env / package.json / source files ARE the truth)
 *   - No git-commit / .gitignore decision to make
 *   - Works on imported projects (TM Code didn't write a manifest there)
 *   - No schema migration when markers evolve
 *
 * Targets — only commands that PROVISION (one-shot) external resources or
 * inject a self-contained scaffold:
 *
 *   auth.email-password   #auth-email-password
 *   auth.google           #auth-google
 *   payments.momenu       /payments
 *
 * Other commands (`/init`, `/plan`, `/debug`, `/te2e`, `/review`, `#design`)
 * are NOT in this detector — they are idempotent or per-invocation and don't
 * need the "already applied" guard.
 */
import { invoke } from '@tauri-apps/api/core'

export type ScaffoldKey = 'auth.email-password' | 'auth.google' | 'payments.momenu'

export interface ScaffoldingState {
  /** All scaffolding keys detected as applied in this project. */
  applied: ScaffoldKey[]
  /**
   * Per-key list of evidence strings that triggered detection — file paths,
   * env-var names, or dep names. Surfaced in the UI tooltip and the system
   * prompt so the agent can read the right files instead of re-scaffolding.
   */
  evidence: Partial<Record<ScaffoldKey, string[]>>
}

interface DetectionContext {
  envText: string | null
  packageJson: { dependencies: string[]; devDependencies: string[] } | null
  fileMatches: Map<string, boolean>
}

/**
 * Files we probe via `path_exists` (single stat call each) during detection.
 * We don't grep contents — presence of a uniquely-named artefact is enough.
 * Add to this list when a scaffold introduces a new marker file.
 */
const MARKER_FILES = [
  // auth-proxy backend (any of these means the proxy was scaffolded)
  'backend/src/routes/auth-proxy.ts',
  'backend/src/routes/auth-proxy.js',
  'server/src/routes/auth-proxy.ts',
  'server/src/routes/auth-proxy.js',
  'src/routes/auth-proxy.ts',
  'src/routes/auth-proxy.js',
  // frontend auth helpers
  'client/src/lib/authClient.ts',
  'src/lib/authClient.ts',
  'src/lib/authClient.js',
  // Google sign-in hook
  'client/src/hooks/useGoogleSignIn.ts',
  'src/hooks/useGoogleSignIn.ts',
  'src/hooks/useGoogleSignIn.tsx',
] as const

/**
 * .env keys whose presence implies a particular scaffolding ran. We only
 * look at the KEY existence — values are irrelevant (and the detector must
 * not surface them anywhere).
 */
const ENV_KEYS = {
  'auth.email-password': ['VITE_FIREBASE_API_KEY', 'VITE_GIP_TENANT_ID'],
  'auth.google': ['VITE_GOOGLE_CLIENT_ID'],
  // MoMenu payments writes its own keys; detection is conservative —
  // require both the key and a dep / file to avoid false positives from
  // hand-edited .env entries.
  'payments.momenu': ['MOM_FACTURA_API_KEY'],
} as const

/**
 * package.json dependency names that signal a scaffold. Only signals from
 * scaffolds that produce uniquely-named imports. Generic deps (`stripe`,
 * `firebase`) are NOT used — too easy to install for unrelated reasons.
 */
const PACKAGE_DEPS = {
  'payments.momenu': ['mom-factura', 'mcx-express', '@momenu/factura'],
} as const

async function safeRead(path: string): Promise<string | null> {
  try {
    return await invoke<string>('read_file', { path })
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  // Single stat() via Rust — does NOT read the file content. Marker probes
  // were previously full reads of files like index.html (~30KB each) just
  // to confirm presence. path_exists is ~5-10x faster overall on a typical
  // 12-marker scan.
  try {
    return await invoke<boolean>('path_exists', { path })
  } catch {
    return false
  }
}

function envHasKey(envText: string | null, key: string): boolean {
  if (!envText) return false
  // Env-var names contain only [A-Z0-9_], no regex-special chars — interpolate
  // directly. Match KEY=... at line start (with optional leading whitespace),
  // tolerating empty values (`KEY=`) and quoted values (`KEY="..."`). The
  // anchor on non-`#` start excludes commented-out lines.
  const re = new RegExp(`^[ \\t]*${key}=`, 'm')
  return re.test(envText)
}

async function buildContext(projectPath: string): Promise<DetectionContext> {
  // Parallel: .env + package.json + all marker file probes
  const [envText, pkgRaw, ...markerResults] = await Promise.all([
    safeRead(`${projectPath}/.env`),
    safeRead(`${projectPath}/package.json`),
    ...MARKER_FILES.map(rel => fileExists(`${projectPath}/${rel}`)),
  ])

  let packageJson: DetectionContext['packageJson'] = null
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      packageJson = {
        dependencies: Object.keys(pkg.dependencies || {}),
        devDependencies: Object.keys(pkg.devDependencies || {}),
      }
    } catch {
      // malformed package.json — treat as absent
    }
  }

  const fileMatches = new Map<string, boolean>()
  MARKER_FILES.forEach((rel, i) => {
    fileMatches.set(rel, markerResults[i] === true)
  })

  return { envText, packageJson, fileMatches }
}

function detectAuthEmailPassword(ctx: DetectionContext): string[] | null {
  const evidence: string[] = []
  for (const key of ENV_KEYS['auth.email-password']) {
    if (envHasKey(ctx.envText, key)) evidence.push(`.env:${key}`)
  }
  for (const [path, exists] of ctx.fileMatches) {
    if (!exists) continue
    if (path.endsWith('auth-proxy.ts') || path.endsWith('auth-proxy.js')) {
      evidence.push(path)
    }
    if (path.endsWith('authClient.ts') || path.endsWith('authClient.js')) {
      evidence.push(path)
    }
  }
  // Require BOTH .env credentials AND at least one marker file. The .env
  // alone might come from a fresh provision_auth that the user aborted
  // before scaffolding the proxy/frontend; the marker file alone might be
  // a hand-written stub. Conjunction avoids both false-positive shapes.
  const hasEnv = evidence.some(e => e.startsWith('.env:'))
  const hasFile = evidence.some(e => !e.startsWith('.env:'))
  return hasEnv && hasFile ? evidence : null
}

function detectAuthGoogle(ctx: DetectionContext): string[] | null {
  const evidence: string[] = []
  for (const key of ENV_KEYS['auth.google']) {
    if (envHasKey(ctx.envText, key)) evidence.push(`.env:${key}`)
  }
  for (const [path, exists] of ctx.fileMatches) {
    if (!exists) continue
    if (path.includes('useGoogleSignIn')) evidence.push(path)
  }
  // Require .env (VITE_GOOGLE_CLIENT_ID is the platform-managed signal that
  // Google sign-in was provisioned) OR the hook file. Either alone is
  // strong enough — the hook file is unique to this scaffold and the
  // .env key is platform-written.
  return evidence.length > 0 ? evidence : null
}

function detectPaymentsMomenu(ctx: DetectionContext): string[] | null {
  const evidence: string[] = []
  for (const key of ENV_KEYS['payments.momenu']) {
    if (envHasKey(ctx.envText, key)) evidence.push(`.env:${key}`)
  }
  if (ctx.packageJson) {
    const all = [...ctx.packageJson.dependencies, ...ctx.packageJson.devDependencies]
    for (const dep of PACKAGE_DEPS['payments.momenu']) {
      if (all.includes(dep)) evidence.push(`package.json:${dep}`)
    }
  }
  // Require at least one signal. Conservative: dep alone is enough since
  // mom-factura packages are uniquely named.
  return evidence.length > 0 ? evidence : null
}

// ── Cache ──────────────────────────────────────────────────────────────
//
// Cached per project path with a short TTL. Invalidation in practice
// happens via TTL expiry — file watchers calling invalidatePromptCache
// would also refresh us if we hooked them, but the TTL is short enough
// (3s) that detection drift is negligible while the developer iterates.

const CACHE_TTL_MS = 3000
const cache = new Map<string, { state: ScaffoldingState; at: number }>()

/**
 * Detect which one-shot scaffoldings have been applied to the project.
 * Returns `{ applied, evidence }`. Cached per `projectPath` for `CACHE_TTL_MS`.
 *
 * Idempotent — safe to call from the parallel-gather phase of the system
 * prompt builder, the hashtag handler, and the provision_auth tool guard.
 */
export async function detectScaffolding(projectPath: string): Promise<ScaffoldingState> {
  const cached = cache.get(projectPath)
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.state

  const ctx = await buildContext(projectPath)

  const applied: ScaffoldKey[] = []
  const evidence: Partial<Record<ScaffoldKey, string[]>> = {}

  const ep = detectAuthEmailPassword(ctx)
  if (ep) { applied.push('auth.email-password'); evidence['auth.email-password'] = ep }

  const g = detectAuthGoogle(ctx)
  if (g) { applied.push('auth.google'); evidence['auth.google'] = g }

  const p = detectPaymentsMomenu(ctx)
  if (p) { applied.push('payments.momenu'); evidence['payments.momenu'] = p }

  const state: ScaffoldingState = { applied, evidence }
  cache.set(projectPath, { state, at: now })
  return state
}

/**
 * Drop the cached state for a project. Call when you know a write has just
 * landed (`provision_auth` completion, `/payments` finish, file watcher
 * fires on .env / package.json / src/hooks/useGoogleSignIn.ts). Tests use
 * `clearAllScaffoldingCache` to reset between cases.
 */
export function invalidateScaffoldingCache(projectPath: string): void {
  cache.delete(projectPath)
}

export function clearAllScaffoldingCache(): void {
  cache.clear()
}

/** Human-readable label for a scaffold key. UI + system prompt use this. */
export function scaffoldKeyLabel(key: ScaffoldKey): string {
  switch (key) {
    case 'auth.email-password': return 'Email + password sign-in'
    case 'auth.google':         return 'Google sign-in'
    case 'payments.momenu':     return 'MoMenu Payments'
  }
}

/**
 * UI trigger token for a scaffold key — the literal hashtag or slash command
 * the user would type to invoke the scaffolding flow. Used by the prompt-bar
 * to build the `appliedHints` map keyed by trigger so menus can render the
 * "já aplicado" badge against the right item.
 */
export function scaffoldUITrigger(key: ScaffoldKey): string {
  switch (key) {
    case 'auth.email-password': return '#auth-email-password'
    case 'auth.google':         return '#auth-google'
    case 'payments.momenu':     return '/payments'
  }
}

/**
 * One-line tooltip text recommending the natural-language fix phrasing for
 * a given applied scaffold. Used by HashtagMenu / SlashCommandMenu when
 * the option is greyed. Resolved through the i18n layer so the prompt
 * follows the developer's chosen IDE language.
 */
export function scaffoldFixHint(key: ScaffoldKey): string {
  // Lazy import to avoid a hard dep on i18n from this leaf service (the
  // detector is also called from places that don't otherwise touch i18n).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { t } = require('../i18n') as typeof import('../i18n')
  switch (key) {
    case 'auth.email-password': return t('scaffold.fixHint.authEmailPassword')
    case 'auth.google':         return t('scaffold.fixHint.authGoogle')
    case 'payments.momenu':     return t('scaffold.fixHint.paymentsMomenu')
  }
}
