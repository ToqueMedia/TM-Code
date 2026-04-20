/**
 * Pure detection helpers for the dev server manager — zero dependencies on
 * stores or platform APIs so they're trivially testable under ts-jest.
 */

/** URL patterns emitted by common dev servers (including IPv6 variants). */
export const URL_REGEX_GLOBAL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[0:0:0:0:0:0:0:1\]):\d+\/?/g

/**
 * Fallback port pattern for servers that don't print a full URL. Only matches
 * POSITIVE readiness phrases — never bare "port N" which would misfire on
 * error lines like "port 7773 already in use".
 */
export const PORT_REGEX = /(?:listening on (?:port )?|running (?:on|at) (?:port )?|started on (?:port )?|server (?:at|on) (?:port )?|app listening on port )(\d{4,5})\b/i

/** Log lines that signal port failure — we skip URL detection entirely. */
export const PORT_FAILURE_REGEX = /EADDRINUSE|address already in use|already in use|port (?:in use|is (?:busy|taken|occupied)|unavailable)|retrying on port|trying port \d+/i

const WRAPPER_KEYWORDS = [
  'concurrently',
  'npm-run-all',
  'run-p ',
  'turbo run',
  'turbo dev',
  'nx run-many',
]

/** Does this literal command string look like a fullstack wrapper? */
export function commandLooksLikeWrapper(cmd: string): boolean {
  const c = cmd.toLowerCase()
  if (WRAPPER_KEYWORDS.some(k => c.includes(k))) return true
  if (c.includes('pnpm') && c.includes(' -r')) return true
  if (/npm run \w+ --workspaces\b/.test(c)) return true
  return false
}

/** Extract the script name from an `npm/pnpm/yarn/bun run <script>` command.
 *  Returns null if the command isn't a script invocation. */
export function extractScriptName(cmd: string): string | null {
  const m = cmd.match(/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-zA-Z0-9_:-]+)/)
  return m ? m[1] : null
}

/**
 * Recursively resolve whether a command (possibly a script reference) ends up
 * invoking a fullstack wrapper. Accepts a `lookupScript` callback so the pure
 * logic stays testable — the caller injects package.json reading.
 *
 * `maxDepth` guards against circular scripts. Default 3 hops catches the
 * common `dev → start → concurrently` chain without risking runaway recursion.
 */
export function resolveIsWrapper(
  command: string,
  lookupScript: (name: string) => string | null,
  maxDepth: number = 3,
): boolean {
  const visited = new Set<string>()
  let current = command
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (commandLooksLikeWrapper(current)) return true
    const scriptName = extractScriptName(current)
    if (!scriptName || visited.has(scriptName)) return false
    visited.add(scriptName)
    const next = lookupScript(scriptName)
    if (!next) return false
    current = next
  }
  return false
}

// ── URL classification ─────────────────────────────────────────────────

export type ProjectKind = 'frontend' | 'backend' | 'fullstack'
export type ProbeKind = 'html' | 'json' | 'other' | null

export interface ClassifySlotState {
  projectKind: ProjectKind
  frontendUrl: string | null
  backendUrl: string | null
  /** True when backendUrl was set by mirroring frontendUrl (monolithic guess). */
  backendUrlMirrored: boolean
}

export type ClassifyAction =
  | { type: 'none' }
  | { type: 'assignFrontend'; url: string }
  | { type: 'assignBackend'; url: string; mirrored: boolean }

/**
 * Pure classifier: decide what assignments to apply given a probed URL.
 *
 * TM Code's port convention is AUTHORITATIVE for fullstack projects:
 *   7773 = frontend (iframe preview)
 *   7777 = backend (HTTP Client)
 *
 * Content-Type is informational, used as a tiebreaker for monolithic
 * fullstack detection (a single URL on 7773 that serves HTML + API routes:
 * Next.js, SvelteKit, Remix).
 *
 * Rules per projectKind:
 *
 *   fullstack:
 *     - url on frontend port: → frontendUrl. If content-type is 'html',
 *       also mirror to backendUrl (covers monolithic case). The mirror is
 *       overwritten later if a real URL on the backend port arrives.
 *     - url on backend port: → backendUrl (real, not mirrored). Even if
 *       it serves HTML (Express fallback, Vite build, etc.) — port wins
 *       over content-type. NEVER classify a 7777 URL as frontend.
 *     - url on any other port: ignored. TM Code's reserved ports are the
 *       only valid surfaces for fullstack.
 *
 *   frontend: first detected URL → frontendUrl (port-agnostic).
 *   backend:  first detected URL → backendUrl (port-agnostic).
 *
 * Returns a list of actions in application order. An empty list means no-op.
 */
export function classifyProbedUrl(
  url: string,
  kind: ProbeKind,
  slot: ClassifySlotState,
  backendPort: number,
  frontendPort: number = 7773,
): ClassifyAction[] {
  const portMatch = url.match(/:(\d+)/)
  const port = portMatch ? parseInt(portMatch[1], 10) : 0

  if (slot.projectKind === 'frontend') {
    if (!slot.frontendUrl) {
      return [{ type: 'assignFrontend', url }]
    }
    return []
  }

  if (slot.projectKind === 'backend') {
    if (!slot.backendUrl || slot.backendUrlMirrored) {
      return [{ type: 'assignBackend', url, mirrored: false }]
    }
    return []
  }

  // projectKind === 'fullstack' — port is authoritative
  if (port === frontendPort) {
    const actions: ClassifyAction[] = []
    if (!slot.frontendUrl) {
      actions.push({ type: 'assignFrontend', url })
    }
    // Monolithic hint: if HTML, mirror to backend (unless a real backend is set).
    if (kind === 'html' && (!slot.backendUrl || slot.backendUrlMirrored)) {
      actions.push({ type: 'assignBackend', url, mirrored: true })
    }
    return actions
  }

  if (port === backendPort) {
    // Port wins over content-type. Even if Express serves HTML here, it's
    // the BACKEND by convention.
    if (!slot.backendUrl || slot.backendUrlMirrored) {
      return [{ type: 'assignBackend', url, mirrored: false }]
    }
    return []
  }

  // Unknown port in fullstack — ignore.
  return []
}
