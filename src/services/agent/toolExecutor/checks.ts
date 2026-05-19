/**
 * Pure validation helpers for `ToolExecutor` — forbidden-pattern checks,
 * command pattern matchers, path utilities, dangerous-command lists, and
 * platform-managed-credential gate.
 *
 * Moved here from the original `toolExecutor.ts` (May 2026 slice) so the
 * orchestrator class can stay focused on tool dispatch + state. Behaviour
 * preserved verbatim — these are pure functions (or near-pure: they may
 * read package.json via Tauri's `invoke`, but never `this.*`).
 *
 * Each function's call site in `ToolExecutor` was previously a private
 * method; the class now imports and delegates.
 */

import { invoke } from '@/utils/invokeMetrics'
import {
  FORBIDDEN_FIREBASE_AUTH_NAMES,
  FORBIDDEN_DATA_LAYER_DEPS,
  FORBIDDEN_ITK_V2_PATH,
  FORBIDDEN_SERVICE_ACCOUNT_KEY,
  FRONTEND_BUILD_SCRIPT_PATTERNS,
  DOCKERFILE_ANTI_PATTERNS,
  DOCKERFILE_PATH,
  REJECTION_REASONS,
} from '../forbiddenPatterns'

// ═══════════════════════════════════════════════════════════════════════
// Platform-managed credential gate
// ═══════════════════════════════════════════════════════════════════════

/**
 * `request_credentials` rejects fields whose IDs match any of these names —
 * those credentials live ONLY on the TM Code worker / are written by
 * provision_auth / provision_deploy. Asking the developer for them shows a
 * dialog they cannot satisfy. The auth-proxy skill (hard rule #2) and the
 * publish-backend skill both forbid this in prose; this is the mechanical
 * enforcement after a real session (sess_1778931389233_p1v9ao, 2026-05-16)
 * where the model fell back to request_credentials after provision_auth
 * returned a soft-failure string. Lists current TM_* names + every legacy
 * name still written by provision_auth for backward-compat.
 */
export const PLATFORM_MANAGED_FIELD_IDS = new Set<string>([
  // Canonical TM_* names (written by provision_auth)
  'TM_AUTH_KEY', 'VITE_TM_AUTH_KEY',
  'TM_AUTH_DOMAIN', 'VITE_TM_AUTH_DOMAIN',
  'TM_PROJECT_ID', 'VITE_TM_PROJECT_ID',
  'TM_TENANT_ID', 'VITE_TM_TENANT_ID',
  'VITE_TM_GOOGLE_CLIENT_ID',
  // Legacy mirrors (dual-written by provision_auth for old projects)
  'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID', 'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MEASUREMENT_ID',
  'VITE_GIP_TENANT_ID', 'VITE_GOOGLE_CLIENT_ID',
  'GIP_FIREBASE_API_KEY', 'GIP_TENANT_ID', 'GIP_PROJECT_ID', 'GCP_PROJECT_ID',
  // Deploy / data layer (written by provision_deploy or never user-supplied)
  'APP_ID', 'FIREBASE_PROJECT_ID', 'FIREBASE_APP_ID',
  'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  // Database — the platform DB is reached via runtime IAM, no URL/key
  'DATABASE_URL', 'FIRESTORE_EMULATOR_HOST',
])

export function describePlatformManagedField(id: string): string | null {
  if (!PLATFORM_MANAGED_FIELD_IDS.has(id)) return null
  return (
    `Blocked: "${id}" is a PLATFORM-MANAGED credential — never request it via this form. ` +
    `It is written automatically by provision_auth (auth/GIP credentials) or provision_deploy (deploy/DB credentials), ` +
    `not collected from the developer.\n\n` +
    `If you reached for request_credentials because provision_auth FAILED, that is the wrong recovery path. ` +
    `provision_auth failure means the platform tenant could not be created — the credential simply doesn't exist yet. ` +
    `Asking the developer to type it in cannot succeed; the developer has no way to obtain it themselves.\n\n` +
    `Correct recovery:\n` +
    `  1. Stop the auth implementation.\n` +
    `  2. Tell the developer in chat that provision_auth failed and report the exact error message it returned.\n` +
    `  3. Ask the developer whether to retry provision_auth or skip the auth feature entirely.\n` +
    `Do NOT continue scaffolding auth code that depends on these credentials.`
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Path normalization and classification
// ═══════════════════════════════════════════════════════════════════════

export function normalizePath(p: string): string {
  // Normalize separators: convert all backslashes to forward slashes (cross-platform).
  // This allows consistent comparison on Windows where paths may use \ or mixed separators.
  const unified = p.replace(/\\/g, '/')

  // Detect Windows drive letter (e.g., "C:/Users/...")
  const driveMatch = unified.match(/^([A-Za-z]):\//)
  const prefix = driveMatch ? driveMatch[1].toUpperCase() + ':/' : '/'
  const pathAfterPrefix = driveMatch ? unified.slice(3) : unified

  // Resolve '..' and '.' segments
  const parts = pathAfterPrefix.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') {
      resolved.pop()
    } else if (part !== '.' && part !== '') {
      resolved.push(part)
    }
  }
  return prefix + resolved.join('/')
}

export function isEnvFile(filePath: string): boolean {
  if (!filePath) return false
  const filename = filePath.replace(/\\/g, '/').split('/').pop() || ''
  // Block all .env files EXCEPT exactly ".env.example"
  if (!filename.startsWith('.env')) return false
  return filename !== '.env.example'
}

/**
 * Files that may contain secrets — require explicit user authorization.
 */
export const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
  /^\.npmrc$/,
  /\.pem$/,
  /\.key$/,
  /credentials\.json$/,
  /_secret/,
]

export function isSensitiveFile(filePath: string): boolean {
  const filename = filePath.replace(/\\/g, '/').split('/').pop() || ''
  return SENSITIVE_FILE_PATTERNS.some(p => p.test(filename))
}

// ═══════════════════════════════════════════════════════════════════════
// Hashing
// ═══════════════════════════════════════════════════════════════════════

/** Fast non-cryptographic hash for concurrent modification detection. */
export function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

// ═══════════════════════════════════════════════════════════════════════
// Dangerous and state-mutating command detection
// ═══════════════════════════════════════════════════════════════════════

/**
 * All commands that always require explicit Yes/No approval.
 * The Settings UI imports this list directly — no separate list to maintain.
 * User can block individual commands in Settings > Sandbox > Dangerous Commands.
 *
 * IMPORTANT: this list is "needs approval", NOT "mutates state". Some entries
 * here are safe when read-only (`sudo cat`, `docker ps`, `kill -0`, `systemctl status`).
 * For state-mutation detection (used by mid-flight cancellation warnings to decide
 * whether the model should avoid auto-retrying), use STATE_MUTATING_COMMANDS below.
 */
export const DANGEROUS_COMMANDS: readonly string[] = [
  // Filesystem — destructive
  'rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'ln',
  // Filesystem — system-level
  'mkfs', 'dd', 'shutdown', 'reboot',
  // Git — risky operations
  'git push', 'git reset', 'git checkout', 'git merge', 'git rebase',
  'git stash', 'git clean', 'git commit',
  // Package managers — remove
  'npm uninstall', 'yarn remove', 'pnpm remove',
  // Process management
  'kill', 'pkill', 'killall',
  // Privilege escalation
  'sudo', 'su', 'doas', 'pkexec',
  // Network
  'wget',
  // System services
  'launchctl', 'systemctl',
]

/**
 * Strict subset of DANGEROUS_COMMANDS that ACTUALLY mutate state. Used by
 * mid-flight cancellation (execute_command) to decide whether to emit the
 * strong "DO NOT auto-retry — partial side effects may exist" warning.
 *
 * Exclusions from DANGEROUS_COMMANDS (these are read-safe and require
 * approval for other reasons like privilege or network):
 *   - `sudo`, `su`, `doas`, `pkexec` — privilege wrappers; mutation depends on the wrapped command
 *   - `docker`, `docker-compose` — `docker ps`/`docker logs` are read-only
 *   - `kill`, `pkill`, `killall` — `kill -0 $PID` is a signal existence check, read-only
 *   - `wget` — downloads content but with abort mid-flight, file is incomplete not mutated
 *   - `launchctl`, `systemctl` — `list`/`status` subcommands are read-only
 *
 * WRITE_COMMAND_PATTERNS (below) covers the filesystem-mutation shell
 * patterns (redirects, sed -i, tee, etc.) that aren't caught by the
 * single-word list.
 */
export const STATE_MUTATING_COMMANDS: readonly string[] = [
  // Filesystem — unambiguously destructive
  'rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'ln',
  'mkfs', 'dd', 'shutdown', 'reboot',
  // Git — all mutate working tree or remote state
  'git push', 'git reset', 'git checkout', 'git merge', 'git rebase',
  'git stash', 'git clean', 'git commit',
  // Package managers — remove (install is handled via executeInstallStreaming with PID kill)
  'npm uninstall', 'yarn remove', 'pnpm remove',
]

/** Internal: word-boundary match against a list of command tokens. */
export function matchAnyInList(command: string, list: readonly string[]): string | null {
  if (!command) return null
  const cmdLower = command.toLowerCase()
  for (const token of list) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?:^|[;&|\\s(\`$])${escaped}(?:\\s|$|[;&|)\`])`, 'i')
    if (pattern.test(` ${cmdLower} `)) return token
  }
  return null
}

/**
 * Check if a command contains any dangerous command from the list.
 * Returns the matched command name, or null if not dangerous.
 */
export function matchDangerousCommand(command: string): string | null {
  return matchAnyInList(command, DANGEROUS_COMMANDS)
}

/**
 * Check if a command contains any STATE-MUTATING command (a strict subset
 * of DANGEROUS_COMMANDS — excludes sudo/docker/kill/wget/launchctl/systemctl
 * which may be read-only depending on the subcommand). Used by mid-flight
 * cancellation to decide whether the model should be warned against
 * auto-retry.
 */
export function matchStateMutatingCommand(command: string): string | null {
  return matchAnyInList(command, STATE_MUTATING_COMMANDS)
}

/**
 * Patterns that indicate file-writing operations via shell.
 * Used to enforce read-only mode for verification agents.
 */
export const WRITE_COMMAND_PATTERNS: readonly RegExp[] = [
  />\s*(?!\/dev\/null|&)\S/,  // redirect to file (allow > /dev/null and >&)
  />>\s*(?!\/dev\/null)\S/,   // append redirect (allow >> /dev/null)
  /\bsed\s+(-[a-zA-Z]*i|--in-place)\b/, // sed in-place edit
  /\bperl\s+(-[a-zA-Z]*i)\b/,           // perl in-place edit
  /\bmv\s+/,          // move/rename files
  /\bcp\s+/,          // copy files
  /\brm\s+/,          // remove files
  /\bmkdir\s+/,       // create directories
  /\btouch\s+/,       // create/update files
  /\btee\s+/,         // write to files via tee
  /\bchmod\s+/,       // change permissions
  /\bchown\s+/,       // change ownership
  /\bln\s+/,          // create links
  /\bcurl\s+.*-[a-zA-Z]*o\b/, // curl -o writes to file
  /\bwget\s+/,        // wget downloads files
  /\bgit\s+(add|commit|push|checkout|reset|merge|rebase|stash|tag\s+-d)\b/, // git write ops
]

// ═══════════════════════════════════════════════════════════════════════
// Forbidden source-code patterns (auth, ITK v2, service-account, data layer)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Returns a block message if the given content imports/calls forbidden
 * Firebase auth methods, or null if it's clean. Scoped to TS/TSX/JS/JSX
 * files — markdown, JSON, and config files are unaffected.
 *
 * Path-scoped to avoid false positives in the auth-proxy itself (which
 * legitimately calls Identity Toolkit REST endpoints whose response
 * payloads mention "GoogleAuthProvider" etc. in comments).
 */
export function checkForbiddenAuthImports(path: string, content: string): string | null {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return null
  // Skip backend auth-proxy files — they legitimately hit Identity Toolkit.
  // The forbidden pattern targets CLIENT-side firebase/auth imports.
  if (/\/(server|backend|api)\/.*auth.*\.(ts|js)$/i.test(path)) return null

  const importsFromFirebaseAuth = /(?:^|\n)\s*import[\s\S]+?from\s+['"]firebase\/auth['"]\s*;?/m.test(content)
  if (!importsFromFirebaseAuth) return null

  const match = content.match(FORBIDDEN_FIREBASE_AUTH_NAMES)
  if (!match) return null

  return REJECTION_REASONS.firebaseAuthImport(path, match[1])
}

/**
 * Reject writes that hit `identitytoolkit.googleapis.com/v2/accounts:*`.
 * Defense-in-depth alongside the auth-proxy SKILL's `/v1` rule —
 * documented for ages but still violated under generation pressure
 * (the model has both /v1 and /v2 in training and silently picks /v2
 * ~30% of the time per the SKILL note). The runtime block forces a
 * fix before the file lands.
 *
 * Scoped to TS/JS only — README.md and prompt notes legitimately
 * mention the wrong URL when documenting the rule itself.
 */
export function checkForbiddenItkV2(path: string, content: string): string | null {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt)$/i.test(path)) return null
  if (!FORBIDDEN_ITK_V2_PATH.test(content)) return null
  return REJECTION_REASONS.itkV2Path(path)
}

/**
 * Reject writes that import a `serviceAccountKey.json`. The platform
 * runtime authenticates via the metadata server — there's no JSON key
 * to ship, and the file doesn't exist in the project. Catching this
 * at write time stops the agent from generating a code path that's
 * irreparable without manual intervention.
 */
export function checkForbiddenServiceAccountImport(path: string, content: string): string | null {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return null
  if (!FORBIDDEN_SERVICE_ACCOUNT_KEY.test(content)) return null
  return REJECTION_REASONS.serviceAccountKey(path)
}

/**
 * Reject writes to package.json that add forbidden SQL data-layer deps.
 * Triggers on create_file / write_file / edit_file when the target is
 * any package.json under the project root. Only fires when the NEW
 * content contains a forbidden dep that's NOT in the OLD content — i.e.
 * we don't block legitimate edits to existing legacy projects, only the
 * act of scaffolding the wrong shape into a fresh project.
 *
 * Returns the block message (string) when the write should be rejected,
 * null when it's allowed.
 */
export function checkForbiddenDataLayerDeps(path: string, newContent: string, oldContent: string = ''): string | null {
  if (!/(?:^|\/)package\.json$/.test(path)) return null

  let newPkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    newPkg = JSON.parse(newContent)
  } catch {
    return null // not valid JSON yet — let the user fix that issue first
  }
  let oldDeps = new Set<string>()
  if (oldContent) {
    try {
      const oldPkg = JSON.parse(oldContent) as typeof newPkg
      oldDeps = new Set([
        ...Object.keys(oldPkg.dependencies ?? {}),
        ...Object.keys(oldPkg.devDependencies ?? {}),
      ])
    } catch { /* old content malformed — treat as empty */ }
  }
  const newDeps = new Set([
    ...Object.keys(newPkg.dependencies ?? {}),
    ...Object.keys(newPkg.devDependencies ?? {}),
  ])
  const newlyAdded = FORBIDDEN_DATA_LAYER_DEPS.filter(
    (dep) => newDeps.has(dep) && !oldDeps.has(dep),
  )
  if (newlyAdded.length === 0) return null
  return REJECTION_REASONS.dataLayerDeps(path, newlyAdded)
}

// ═══════════════════════════════════════════════════════════════════════
// Dockerfile shape check (uses package.json scripts cache)
// ═══════════════════════════════════════════════════════════════════════

/** Per-projectRoot cache of the parsed `scripts` block. The Dockerfile
 *  checker is called on every write; without this it would re-invoke
 *  `read_file` on the same package.json several times in a row during a
 *  scaffold turn (write Dockerfile → write .dockerignore → edit
 *  Dockerfile). 60s TTL is short enough that the agent's own edits to
 *  package.json invalidate naturally on the next sweep. */
const packageJsonCache: Map<string, { scripts: Record<string, string> | null; expiresAt: number }> = new Map()

async function getCachedPackageScripts(pkgPath: string): Promise<Record<string, string> | null> {
  const now = Date.now()
  const cached = packageJsonCache.get(pkgPath)
  if (cached && cached.expiresAt > now) return cached.scripts
  let raw: string
  try {
    raw = await invoke<string>('read_file', { path: pkgPath })
  } catch {
    return null
  }
  let scripts: Record<string, string> | null = null
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    scripts = parsed?.scripts ?? null
  } catch {
    scripts = null
  }
  packageJsonCache.set(pkgPath, { scripts, expiresAt: now + 60_000 })
  return scripts
}

/** Walk parent dirs from `startPath` looking for a `package.json`.
 *  Returns the absolute path or null. Bounded to 6 levels — the project
 *  root is always close to a Dockerfile in practice. */
async function findNearestPackageJson(startPath: string): Promise<string | null> {
  let dir = startPath.slice(0, startPath.lastIndexOf('/'))
  for (let i = 0; i < 6; i++) {
    if (!dir) return null
    try {
      const candidate = `${dir}/package.json`
      await invoke<string>('read_file', { path: candidate })
      return candidate
    } catch {
      const parent = dir.slice(0, dir.lastIndexOf('/'))
      if (parent === dir) return null
      dir = parent
    }
  }
  return null
}

/** Fire-and-forget telemetry for Dockerfile rejections. Lets us answer
 *  "is the harness catching this anti-pattern in production?" — without
 *  the event we'd have no signal whether the rule is firing 5×/day
 *  (systemic) or 0×/day (resolved). Path is hashed-prefix only to keep
 *  PII out of analytics. */
function emitDockerfileRejection(
  kind: 'nodeRunsTs' | 'envFileInCmd' | 'frontendBuild',
  path: string,
  hasFrontendBuild: boolean,
): void {
  import('../../analytics').then(({ trackEvent }) => {
    void trackEvent('dockerfile_rejected', {
      kind,
      has_frontend_build: hasFrontendBuild,
      // Last 32 chars of the path — enough to distinguish project layouts
      // (`/Dockerfile` vs `/server/Dockerfile`) without leaking the user's
      // home dir or full project name.
      path_suffix: path.slice(-32),
    })
  }).catch(() => { /* analytics never blocks writes */ })
}

/**
 * Reject Dockerfile writes that pair badly with the Cloud Run container
 * contract. The skill's §8 anti-patterns enumerate the specific failures
 * (frontend build script in the container, node running .ts, env-file
 * pointing at .env). Each match cites the publish-backend SKILL recovery
 * path — defense-in-depth so a Dockerfile that violates the SKILL never
 * reaches Cloud Build, where the failure mode is opaque
 * ("vite: not found", non-zero exit at step 6).
 *
 * The frontend-build-script check needs the project's package.json to
 * resolve `npm run X` → script body (X) → "is X a frontend build?".
 * We accept the project root via toolExecutor.cmdModeCwd or by walking
 * up from the Dockerfile path until package.json is found.
 */
export async function checkForbiddenDockerfileShape(path: string, content: string): Promise<string | null> {
  if (!DOCKERFILE_PATH.test(path)) return null

  // 1. Cheap pattern checks first — no I/O.
  for (const { pattern, kind } of DOCKERFILE_ANTI_PATTERNS) {
    if (!pattern.test(content)) continue
    if (kind === 'nodeRunsTs') {
      emitDockerfileRejection('nodeRunsTs', path, false)
      return REJECTION_REASONS.dockerfileNodeRunsTs(path)
    }
    if (kind === 'envFileInCmd') {
      emitDockerfileRejection('envFileInCmd', path, false)
      return REJECTION_REASONS.dockerfileEnvFileInCmd(path)
    }
  }

  // 2. The frontend-build check: needs to resolve `RUN npm run <script>`
  //    against the project's package.json to know what <script> actually
  //    runs. Skip when no `RUN npm run …` (or yarn/pnpm equivalent) is
  //    present — most Dockerfiles don't reach this branch.
  const npmRunMatch = content.match(/RUN\s+(?:npm\s+run|yarn\s+(?!run\s)|pnpm\s+run)\s+([a-z0-9:_-]+)/i)
  if (!npmRunMatch) return null
  const scriptName = npmRunMatch[1]

  // Walk up from the Dockerfile to find package.json (handles both flat
  // layout and `Dockerfile` colocated with `server/package.json`).
  const pkgPath = await findNearestPackageJson(path)
  if (!pkgPath) return null
  const scripts = await getCachedPackageScripts(pkgPath)
  if (!scripts) return null
  const scriptBody = scripts[scriptName]
  if (!scriptBody) return null

  const isFrontendBuild = FRONTEND_BUILD_SCRIPT_PATTERNS.some((p) => p.test(scriptBody))
  if (!isFrontendBuild) return null
  emitDockerfileRejection('frontendBuild', path, true)
  return REJECTION_REASONS.dockerfileFrontendBuild(path, scriptName, scriptBody)
}
