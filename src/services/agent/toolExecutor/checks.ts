/**
 * Pure validation helpers for `ToolExecutor` — command pattern matchers,
 * path utilities, and dangerous-command lists.
 *
 * Moved here from the original `toolExecutor.ts` (May 2026 slice) so the
 * orchestrator class can stay focused on tool dispatch + state. These are
 * pure functions (no I/O, no `this.*`).
 *
 * The managed-platform policing gates that used to live here (forbidden
 * firebase/auth imports, ITK v2 paths, service-account-key imports,
 * data-layer dep blocks, the platform-managed-credential gate for
 * request_credentials, and the Cloud Run Dockerfile-shape check) were
 * removed in the dev-only-IDE pivot (2026-07): a dev tool must not forbid
 * the developer's own stack or infrastructure choices. What remains is
 * genuine safety tooling.
 */


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

/** Convenções de TEMPLATE de env — documentação, não segredos. Isenção
 *  PARTILHADA por isEnvFile e isSensitiveFile: estavam dessincronizadas
 *  (isEnvFile isentava .env.example; o padrão de sensíveis não) e um
 *  read_file de .env.example caía em forcePrompt='sensitive_file' — que
 *  salta o Modo Auto POR DESENHO. Resultado: diálogo humano para um
 *  ficheiro de exemplo, com auto mode ligado (report do user 2026-07-18). */
export const ENV_TEMPLATE_FILES: ReadonlySet<string> = new Set([
  '.env.example', '.env.sample', '.env.template', '.env.dist',
])

export function isEnvFile(filePath: string): boolean {
  if (!filePath) return false
  const filename = filePath.replace(/\\/g, '/').split('/').pop() || ''
  if (!filename.startsWith('.env')) return false
  return !ENV_TEMPLATE_FILES.has(filename)
}

/** `.env` / `.env.<suffix>` as a WHOLE token — `.environment` must not match. */
const ENV_TOKEN_RE = /\.env(\.[A-Za-z0-9_-]+)?(?![A-Za-z0-9_-])/g

/** Flags that HAND the file to another program instead of printing it. */
const ENV_PASSTHROUGH_FLAG_RE = /--env[-_]?file(=|\s+)$/i

/**
 * True when a shell command would read a sealed `.env`.
 *
 * The path-based seal (`isEnvFile`) only inspects tools that take a file path,
 * so every shell surface walked straight past it (auditoria 2026-07-28):
 * `execute_command("cat .env")`, `agent_shell_write("head .env")`, a background
 * `xxd .env`. Enumerating the printing utilities (cat/head/xxd/strings/base64/
 * `node -e`/`python -c`/…) is unwinnable, so the token itself is the trigger.
 *
 * `--env-file .env` is exempt: docker/compose PASS the file to another process
 * rather than echoing it into the transcript, and blocking that would cost a
 * real capability for no secrecy gain.
 */
export function commandReferencesSealedEnv(command: string): boolean {
  if (!command) return false
  ENV_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ENV_TOKEN_RE.exec(command)) !== null) {
    if (!isEnvFile(match[0])) continue
    if (ENV_PASSTHROUGH_FLAG_RE.test(command.slice(0, match.index))) continue
    return true
  }
  return false
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

export function isSensitiveFile(filePath: string | undefined): boolean {
  // Guarda igual à do isEnvFile logo acima. A assimetria entre as duas era o
  // bug: `read_around({ path })` — a tool aceita `path` OU `file_path` — fazia
  // chegar `undefined` aqui e rebentava com "undefined is not an object
  // (evaluating 'filePath.replace')", falhando a leitura inteira.
  if (!filePath) return false
  const filename = filePath.replace(/\\/g, '/').split('/').pop() || ''
  // Templates de env são documentação — nunca sensíveis (ver ENV_TEMPLATE_FILES).
  if (ENV_TEMPLATE_FILES.has(filename)) return false
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
  /\bwget\s+/,        // wget downloads files
  /\bgit\s+(add|commit|push|checkout|reset|merge|rebase|stash|tag\s+-d)\b/, // git write ops
]

// ═══════════════════════════════════════════════════════════════════════
// Dockerfile shape check (uses package.json scripts cache)
// ═══════════════════════════════════════════════════════════════════════

// The Dockerfile-shape gate (Cloud Run container contract: frontend-build-
// in-container, node-runs-.ts, --env-file on an ignored .env) was removed
// with the managed Publish flow in the dev-only pivot — those conventions
// belong to TM Code Web's deploy pipeline, and a developer writing their own
// Dockerfile for their own infrastructure must not be policed against them.
