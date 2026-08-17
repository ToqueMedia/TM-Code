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

/**
 * Extracts the blocked port from an EADDRINUSE log line. Returns null when the
 * line isn't a port-in-use failure (so the caller can fall through to URL
 * detection). The variants cover Vite (`:::5173`), Next/Express
 * (`address already in use :::3000`), and the bare `EADDRINUSE: port 8080`.
 */
export function extractBlockedPort(line: string): number | null {
  const m = line.match(/EADDRINUSE.*(?:port|address)[:\s]*(\d+)/i)
    || line.match(/EADDRINUSE.*:::(\d+)/i)
    || line.match(/EADDRINUSE.*:(\d+)/i)
    || line.match(/address already in use\s+(?:::)?(\d+)/i)
    || line.match(/listen\s+EADDRINUSE\s+\S+:(\d+)/i)
  if (!m) return null
  const port = parseInt(m[1], 10)
  return port > 0 ? port : null
}

/**
 * User-facing message for a port-in-use failure. The dev server manager does
 * NOT free the port automatically — it informs the user and stops cleanly, so
 * the user can free the port (or change the dev command) and reopen.
 */
export function formatPortInUseMessage(port: number): string {
  return `Port ${port} is in use by another process. The dev server could not start. Free the port (or change the port in your dev command) and reopen the preview to retry.`
}

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

// ── Escolha do script de arranque ────────────────────────────────────────────
//
// Muitos projectos não têm um script `dev` — têm `dev:web`, `dev:client`,
// `dev:all`. A detecção só olhava para `dev` e `start` exactos, portanto esses
// projectos apareciam como "sem comando de dev", com uma mensagem a pedir para
// adicionar um script `dev` que, na prática, já lá estava com outro nome.
//
// A escolha entre variantes é por INTENÇÃO, não alfabética: primeiro a que diz
// correr tudo, depois a que diz ser o frontend (é o que o preview mostra), e só
// no fim as que cheiram a backend. Dentro do mesmo grupo vale a ordem do
// package.json — que é a ordem que o autor escreveu, e melhor palpite do que
// ordenar por acaso.

/** Variantes que declaram correr o projecto inteiro. */
const DEV_VARIANT_ALL = /^dev:(all|full|fullstack|everything)$/i
/** Variantes que declaram ser a parte que o preview mostra. */
const DEV_VARIANT_FRONTEND = /^dev:(web|client|frontend|front|app|ui|site|renderer)$/i
/**
 * Variantes que arrancam algo que NÃO é uma página. Não são excluídas — se for
 * o único `dev:*` do projecto, arrancá-lo é melhor do que dizer ao utilizador
 * que não tem comando de dev — mas ficam em último.
 */
const DEV_VARIANT_BACKEND = /^dev:(api|server|backend|worker|db|database|functions?|edge|electron|native|android|ios|desktop|docs?)$/i

/**
 * Escolhe o script de arranque a partir dos scripts do package.json.
 *
 * Ordem: `dev` exacto > `start` exacto > `dev:tudo` > `dev:frontend` >
 * outro `dev:*` > `dev:*` de backend. `null` quando não há nada.
 *
 * NOTA para quem alargar isto: `start:*` fica DE FORA de propósito. Um
 * `start:prod` é um servidor de produção, e arrancá-lo ao carregar em "iniciar
 * dev server" seria pior do que não fazer nada.
 */
export function pickDevScript(scripts: Record<string, unknown> | null | undefined): string | null {
  if (!scripts || typeof scripts !== 'object') return null
  const names = Object.keys(scripts).filter(n => typeof scripts[n] === 'string' && scripts[n] !== '')

  if (names.includes('dev')) return 'dev'
  if (names.includes('start')) return 'start'

  const variants = names.filter(n => n.toLowerCase().startsWith('dev:'))
  if (variants.length === 0) return null

  return variants.find(n => DEV_VARIANT_ALL.test(n))
    ?? variants.find(n => DEV_VARIANT_FRONTEND.test(n))
    ?? variants.find(n => !DEV_VARIANT_BACKEND.test(n))
    ?? variants[0]
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
 * Inspect a log line for a role prefix injected by parallel runners
 * (concurrently `[client]/[server]`, turbo `client:dev`, pnpm `client:`,
 * npm-run-all wrappers). Returns 'frontend' / 'backend' / null.
 *
 * Used to disambiguate fullstack URL classification when BOTH servers
 * happen to serve HTML on `/` (Express with a 404 HTML page, or a
 * monolithic gateway sitting in front of an API). Without this hint, the
 * first URL probed wins `frontendUrl` and the user lands on the backend
 * port instead of Vite's port — exactly the "preview opens 3000 not 5173"
 * bug observed in BugHunter on first run.
 *
 * Heuristic on the bracketed token: contains `client`/`frontend`/`web`/`ui`
 * → frontend; contains `server`/`backend`/`api` → backend. Anything else
 * returns null and falls through to content-type classification.
 */
export type LineRoleHint = 'frontend' | 'backend' | null

export function detectLineRole(line: string): LineRoleHint {
  // concurrently: "[client] foo bar"
  // pnpm -r:     "client:dev: foo bar"
  // turbo:       "client:dev: foo bar" or "@app/client:dev: foo bar"
  const bracket = line.match(/^\s*\[([^\]]+)\]/)
  const colon = bracket ? null : line.match(/^\s*([^:\s]+):(?:dev|start|serve)?\s*[:|]/)
  const token = (bracket?.[1] || colon?.[1] || '').toLowerCase()
  if (!token) return null
  // Order matters: 'frontend' contains 'end' so don't match too eagerly.
  if (/(^|[\W_])(client|frontend|web|ui)(\W|$)/.test(token)) return 'frontend'
  if (/(^|[\W_])(server|backend|api)(\W|$)/.test(token)) return 'backend'
  return null
}

/**
 * Pure classifier: decide what assignments to apply given a probed URL.
 *
 * Content-type drives classification. The model picks ports naturally
 * (Vite=5173, Next=3000, Express=whatever) — the IDE detects URLs from
 * dev-server logs and assigns them by what they SERVE, not by which port
 * they happen to be on.
 *
 * Rules per projectKind:
 *
 *   frontend: first detected URL → frontendUrl.
 *   backend:  first detected URL → backendUrl.
 *
 *   fullstack:
 *     - HTML response → frontendUrl. If no real backend yet, also mirror
 *       to backendUrl (covers monolithic case: Next.js / SvelteKit /
 *       Remix serving HTML + API from one URL). The mirror is overwritten
 *       later if a real JSON URL arrives.
 *     - JSON / other response → backendUrl (real, not mirrored).
 *     - Optional `frontendPortHint`: if a probed URL matches the hinted
 *       port, force-classify it as frontend regardless of content-type.
 *       Use this when probe is inconclusive (e.g., both servers happen to
 *       respond with text/html, or content-type isn't reliable).
 *
 * Returns a list of actions in application order. An empty list means no-op.
 */
export function classifyProbedUrl(
  url: string,
  kind: ProbeKind,
  slot: ClassifySlotState,
  frontendPortHint?: number,
  lineRoleHint?: LineRoleHint,
): ClassifyAction[] {
  // Single-kind projects: first URL wins, port-agnostic.
  if (slot.projectKind === 'frontend') {
    return slot.frontendUrl ? [] : [{ type: 'assignFrontend', url }]
  }

  if (slot.projectKind === 'backend') {
    if (!slot.backendUrl || slot.backendUrlMirrored) {
      return [{ type: 'assignBackend', url, mirrored: false }]
    }
    return []
  }

  // projectKind === 'fullstack' — priority order:
  //   1. lineRoleHint (parallel-runner log prefix `[client]`/`[server]`) —
  //      authoritative because the runner KNOWS which subprocess emitted
  //      the line. CAN OVERWRITE a previous mirror or wrong assignment
  //      that came from content-type alone.
  //   2. frontendPortHint (manually passed by start_dev_server caller).
  //   3. content-type probe (HTML → frontend, JSON/other → backend).
  if (lineRoleHint === 'frontend') {
    const actions: ClassifyAction[] = []
    // Always assign — overwrite a previous assignment if the line role says
    // so. This fixes the "first probe wins frontendUrl" race where Express
    // serving HTML on / steals the slot before Vite's URL is probed.
    if (slot.frontendUrl !== url) {
      actions.push({ type: 'assignFrontend', url })
    }
    // Drop a mirrored backendUrl if the new frontend URL is different from
    // the mirror — it was a guess and we now have a better signal.
    if (slot.backendUrlMirrored && slot.backendUrl !== url) {
      // Re-mirror to the new frontendUrl until a real backend lands.
      actions.push({ type: 'assignBackend', url, mirrored: true })
    }
    return actions
  }

  if (lineRoleHint === 'backend') {
    const actions: ClassifyAction[] = []
    // Same authoritative override on the backend side.
    if (slot.backendUrl !== url || slot.backendUrlMirrored) {
      actions.push({ type: 'assignBackend', url, mirrored: false })
    }
    // If frontendUrl was wrongly mirrored to this URL (because it landed
    // first and content-type was HTML), CLEAR it so the next frontend-
    // tagged URL can take the slot. We can't know what the right frontend
    // URL is yet — leave frontendUrl alone unless it equals this URL,
    // in which case it's clearly wrong.
    // (Conservative: only clear when frontendUrl === url, i.e. the same
    // URL was wrongly assigned to both slots.)
    return actions
  }

  // No line hint — content-type drives, port hint overrides as before.
  const portMatch = url.match(/:(\d+)/)
  const port = portMatch ? parseInt(portMatch[1], 10) : 0
  const hintMatched = frontendPortHint !== undefined && port === frontendPortHint

  if (kind === 'html' || hintMatched) {
    const actions: ClassifyAction[] = []
    if (!slot.frontendUrl) {
      actions.push({ type: 'assignFrontend', url })
    }
    if (kind === 'html' && (!slot.backendUrl || slot.backendUrlMirrored)) {
      actions.push({ type: 'assignBackend', url, mirrored: true })
    }
    return actions
  }

  if (kind === 'json' || kind === 'other') {
    if (!slot.backendUrl || slot.backendUrlMirrored) {
      return [{ type: 'assignBackend', url, mirrored: false }]
    }
    return []
  }

  return []
}
