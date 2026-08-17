import { create } from 'zustand'
import { getCommandPrefix, sanitizeCommandPrefix, matchGrantedPrefix } from '../services/agent/commandPrefix'

/**
 * Per-project trust grants (scopes, tool names, command prefixes, extra dirs,
 * auto-mode). Keyed by projectId so an in-window background run of project A
 * never reads/writes the grants of focused project B.
 *
 * Flat fields on the store remain a VIEW of the *active* (focused) project for
 * UI selectors; mutations always dual-write into `byProject` so a switch away
 * does not lose live grants.
 */
export interface ProjectPermissionGrants {
  projectPath: string
  approvedScopes: Set<'core' | 'mcp'>
  projectToolAllowlist: Set<string>
  projectCommandAllowlist: Set<string>
  additionalDirectories: Set<string>
  autoModePermissions: boolean
}

export function emptyProjectGrants(projectPath = ''): ProjectPermissionGrants {
  return {
    projectPath,
    approvedScopes: new Set(),
    projectToolAllowlist: new Set(),
    projectCommandAllowlist: new Set(),
    additionalDirectories: new Set(),
    autoModePermissions: false,
  }
}

function flatAsGrants(st: {
  projectPath: string | null
  approvedScopes: Set<'core' | 'mcp'>
  projectToolAllowlist: Set<string>
  projectCommandAllowlist: Set<string>
  additionalDirectories: Set<string>
  autoModePermissions: boolean
}): ProjectPermissionGrants {
  return {
    projectPath: st.projectPath ?? '',
    approvedScopes: st.approvedScopes,
    projectToolAllowlist: st.projectToolAllowlist,
    projectCommandAllowlist: st.projectCommandAllowlist,
    additionalDirectories: st.additionalDirectories,
    autoModePermissions: st.autoModePermissions,
  }
}

function mirrorsFrom(g: ProjectPermissionGrants): {
  projectPath: string | null
  approvedScopes: Set<'core' | 'mcp'>
  projectToolAllowlist: Set<string>
  projectCommandAllowlist: Set<string>
  additionalDirectories: Set<string>
  autoModePermissions: boolean
} {
  return {
    projectPath: g.projectPath || null,
    approvedScopes: g.approvedScopes,
    projectToolAllowlist: g.projectToolAllowlist,
    projectCommandAllowlist: g.projectCommandAllowlist,
    additionalDirectories: g.additionalDirectories,
    autoModePermissions: g.autoModePermissions,
  }
}

/**
 * Resolve grants for a projectId.
 *
 * Security rule: when a *specific* non-active projectId is requested and we
 * have no entry, return EMPTY grants (fail-closed → re-prompt) — never fall
 * through to the focused project's grants. That would be the multi-project
 * cross-contamination bug this layer exists to prevent.
 *
 * No projectId (main agent / UI) → active project's grants (flat mirrors or
 * byProject[active]).
 */
export function getProjectGrants(projectId?: string | null): ProjectPermissionGrants {
  const st = usePermissionStore.getState()
  if (projectId) {
    const keyed = st.byProject[projectId]
    if (keyed) return keyed
    // Active project may only live in flat mirrors (tests / pre-hydrate).
    if (projectId === st.activeProjectId) return flatAsGrants(st)
    return emptyProjectGrants()
  }
  if (st.activeProjectId && st.byProject[st.activeProjectId]) {
    return st.byProject[st.activeProjectId]
  }
  return flatAsGrants(st)
}

/** Snapshot flat active-view fields into byProject[active] before switching. */
function snapshotActiveIntoByProject(): Record<string, ProjectPermissionGrants> {
  const st = usePermissionStore.getState()
  const byProject = { ...st.byProject }
  if (st.activeProjectId) {
    byProject[st.activeProjectId] = flatAsGrants(st)
  }
  return byProject
}

/**
 * Write an EPHEMERAL one-line system message to the active chat session
 * whenever the permission modal opens / closes. The line gives the user
 * momentary feedback ("agent asked for X", "you approved") that rises in
 * the chat with the next messages and self-removes after ~8s — it does
 * NOT pollute the persistent transcript. The modal itself is the
 * authoritative interaction surface; this log line is just a breadcrumb.
 *
 * Side-effect-only: failures to load chatStore (very early boot) are
 * swallowed — the permission flow itself must not depend on chat being ready.
 */
async function logPermission(message: string, level: 'info' | 'warn' | 'error' | 'success' = 'info'): Promise<void> {
  try {
    const { useChatStore } = await import('./chatStore')
    useChatStore.getState().addSystemMessage(message, level, { ephemeral: true })
  } catch { /* chatStore not ready — drop the log line silently */ }
}

// ── MODO YOLO (ex-Auto): autonomia total quando ligado ──
// ON  → ZERO envolvimento do user em permissões (dialogs, forcePrompt, path
//       access, Settings "blocked dangerous commands" hard-block, diffs).
//       O risco é do developer ao activar. Sem excepções no path de permissão.
// OFF → fluxo normal (allowlists, scopes, forcePrompt, flagged hard-blocks).
// Não é sandbox isolation nem plan-mode (roles de execução, não "permissão UI").
function isAutoModeEnabled(projectId?: string | null): boolean {
  // POR PROJECTO (decisão do user 2026-07-18): o flag vive NESTE store e
  // persiste em permissions.json com os restantes grants — autonomia no
  // Projeto A não implica autonomia no B; hidrata no open do projecto.
  // Multi-project: resolve pelo projectId do RUN, não pelo projecto em foco.
  return getProjectGrants(projectId).autoModePermissions
}

/** Public: toolExecutor / other layers that hard-block "for the user" check this. */
export function isYoloModeEnabled(projectId?: string | null): boolean {
  return isAutoModeEnabled(projectId)
}

/** YOLO: approve without UI. Diffs also auto-accept via chatStore when this flag is on. */
function yoloApprove(): PermissionDecision {
  return { approved: true, prompted: false, source: 'yolo' }
}

/** Tools cujo grant "always allow" é POR PREFIXO DE COMANDO, não por nome de
 *  tool (porte do claude-vaz — ver commandPrefix.ts). São as que carregam um
 *  `command` string único; agent_shell_* ficam de fora (escrevem teclas, não
 *  um comando atómico prefixável). */
const COMMAND_SCOPED_TOOLS = new Set(['execute_command', 'execute_command_background'])

/** Se um comando de shell bate num prefixo concedido (projeto ∪ global).
 *  `projectId` selects which project's prefix allowlist to consult. */
function matchesGrantedCommandPrefix(
  toolName: string,
  args: Record<string, unknown>,
  projectId?: string | null,
): boolean {
  if (!COMMAND_SCOPED_TOOLS.has(toolName)) return false
  const command = typeof args.command === 'string' ? args.command : ''
  if (!command) return false
  const grants = getProjectGrants(projectId)
  const st = usePermissionStore.getState()
  return (
    matchGrantedPrefix(command, grants.projectCommandAllowlist) != null ||
    matchGrantedPrefix(command, st.globalCommandAllowlist) != null
  )
}

/** Persist/reload autoApproveDiffs from localStorage.
 *  This is a CROSS-PROJECT user preference (the toggle is in chat chrome),
 *  so it stays in localStorage. The per-project `approvedScopes` set is a
 *  trust grant and lives in app-managed per-project state via
 *  `permissionPersistence.ts` — see that file for the rationale. */
const STORAGE_KEY = 'chat_autoApproveDiffs'
function loadAutoApproveDiffs(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === 'true' } catch { return false }
}
function saveAutoApproveDiffs(value: boolean) {
  try { localStorage.setItem(STORAGE_KEY, String(value)) } catch { /* storage unavailable */ }
}

/** Fire-and-forget write of per-project grants to that project's
 *  app-managed state. When `projectId` is omitted, persists the active
 *  (focused) project. Never writes project A's grants into project B's file. */
function persistPermissions(projectId?: string | null): void {
  const st = usePermissionStore.getState()
  const id = projectId ?? st.activeProjectId
  const grants = getProjectGrants(id)
  if (!grants.projectPath) return
  void import('../services/agent/permissionPersistence')
    .then(({ savePermissionsToDisk }) => savePermissionsToDisk(
      grants.projectPath,
      grants.approvedScopes,
      grants.projectToolAllowlist,
      grants.additionalDirectories,
      grants.autoModePermissions,
      grants.projectCommandAllowlist,
    ))
    .catch(() => { /* persistence failure must not break the permission flow */ })
}

/** Fire-and-forget sync of `additionalDirectories` to the Rust side. The
 *  terminal/PTY commands clamp cwd via `clamp_cwd` (container.rs), which
 *  only knows the directories we push here — without this sync, a
 *  user-approved external directory would pass the frontend permission
 *  check and then be silently clamped back to the project root by Rust.
 *  Must be called after EVERY mutation of `additionalDirectories`
 *  (grant, revoke, reset, hydrate). Passes `projectId` so the multi-project
 *  registry updates the RIGHT project's allow-set (not only the focused one). */
function syncAllowedDirectoriesToRust(projectId?: string | null): void {
  const st = usePermissionStore.getState()
  const id = projectId ?? st.activeProjectId
  const grants = getProjectGrants(id)
  const dirs = Array.from(grants.additionalDirectories)
  void import('@/utils/invokeMetrics')
    .then(({ invoke }) => invoke('set_agent_allowed_directories', {
      directories: dirs,
      projectId: id ?? undefined,
    }))
    .catch(() => { /* sync failure must not break the permission flow */ })
}

/**
 * Mutate one project's grants in `byProject`, dual-write flat mirrors when
 * that project is the focused/active one, and optionally persist + sync Rust.
 */
function mutateProjectGrants(
  projectId: string | null | undefined,
  mutator: (g: ProjectPermissionGrants) => ProjectPermissionGrants,
  opts?: { persist?: boolean; syncDirs?: boolean },
): void {
  const st = usePermissionStore.getState()
  const id = projectId ?? st.activeProjectId
  if (!id) {
    // No project id at all (tests / pre-open): mutate flat fields only.
    const next = mutator(flatAsGrants(st))
    usePermissionStore.setState(mirrorsFrom(next))
    if (opts?.syncDirs) syncAllowedDirectoriesToRust(null)
    if (opts?.persist) persistPermissions(null)
    return
  }
  const prev = st.byProject[id] ?? (id === st.activeProjectId ? flatAsGrants(st) : emptyProjectGrants())
  const next = mutator(prev)
  const byProject = { ...st.byProject, [id]: next }
  if (id === st.activeProjectId) {
    usePermissionStore.setState({ byProject, ...mirrorsFrom(next) })
  } else {
    usePermissionStore.setState({ byProject })
  }
  if (opts?.syncDirs) syncAllowedDirectoriesToRust(id)
  if (opts?.persist) persistPermissions(id)
}

/** Global tool allowlist — persisted in localStorage (cross-project). */
const GLOBAL_TOOLS_KEY = 'permission_globalToolAllowlist'
function loadGlobalToolAllowlist(): Set<string> {
  try {
    const raw = localStorage.getItem(GLOBAL_TOOLS_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch { return new Set() }
}
function saveGlobalToolAllowlist(tools: Set<string>): void {
  try { localStorage.setItem(GLOBAL_TOOLS_KEY, JSON.stringify(Array.from(tools))) } catch { /* unavailable */ }
}

/** Global command-prefix allowlist — cross-project shell grants por prefixo,
 *  em localStorage (paridade com o globalToolAllowlist). */
const GLOBAL_CMD_PREFIX_KEY = 'permission_globalCommandAllowlist'
function loadGlobalCommandAllowlist(): Set<string> {
  try {
    const raw = localStorage.getItem(GLOBAL_CMD_PREFIX_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch { return new Set() }
}
function saveGlobalCommandAllowlist(prefixes: Set<string>): void {
  try { localStorage.setItem(GLOBAL_CMD_PREFIX_KEY, JSON.stringify(Array.from(prefixes))) } catch { /* unavailable */ }
}

/** Load grants for a project into `byProject[projectId]` and make that
 *  project the active/focused view (flat mirrors). Used at project-open.
 *
 *  Unlike the old replace-everything hydrate, this **keeps other open
 *  projects' grants in memory** — a background run of project A keeps
 *  using A's allowlists after the developer opens B. Pass `projectId`
 *  whenever available (projectStore always has it); without it we fall
 *  back to path-keyed synthetic id for back-compat.
 *
 *  No persistence write here: this IS the load step. */
export function hydrateApprovedScopes(
  scopes: Set<'core' | 'mcp'>,
  projectPath?: string,
  tools?: Set<string>,
  directories?: Set<string>,
  autoMode?: boolean,
  commandPrefixes?: Set<string>,
  projectId?: string,
): void {
  // Snapshot the currently-focused project's live flat state before we
  // swap the mirrors to the new project (otherwise in-session grants on
  // A would be lost the moment B hydrates).
  const byProject = snapshotActiveIntoByProject()
  const id = projectId || (projectPath ? `path:${projectPath}` : null)
  const grants: ProjectPermissionGrants = {
    projectPath: projectPath ?? '',
    approvedScopes: scopes,
    projectToolAllowlist: tools ?? new Set(),
    projectCommandAllowlist: commandPrefixes ?? new Set(),
    additionalDirectories: directories ?? new Set(),
    // autoMode default FALSE: trocar de projecto nunca herda o Modo Auto do
    // anterior (grant por-projecto, como os scopes).
    autoModePermissions: autoMode === true,
  }
  if (id) byProject[id] = grants
  usePermissionStore.setState({
    byProject,
    activeProjectId: id,
    ...mirrorsFrom(grants),
  })
  syncAllowedDirectoriesToRust(id)
}

const SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob',
  'read_dev_server_logs',
  'read_large_result',
  'check_background_agents',
  'update_tasks',
  // web_fetch is read-only and concurrencySafe (GET through the CORS-free Rust
  // proxy, SSRF-guarded). Prompting per URL was hostile UX for research flows.
  'web_fetch',
  // capture_url_design boots a sandboxed Playwright Chrome profile (not the
  // user's real browser) to screenshot a URL for design-copy. Prompting per
  // paste would kill the "see this URL and copy it" flow; the profile is
  // isolated under ~/.tmcode/browser-profile.
  'capture_url_design',
  // read_skill loads bundled/global/project markdown — pure read, no
  // side effects. Without this, /review and any agent that consults
  // skills mid-session triggers a permission prompt per skill (the agent
  // typically reads several), which is hostile UX.
  'read_skill',
  // Memory persistence tools — confined to validated app/user memory dirs by
  // the Rust layer.
  // Prompting per-call would train the user to click through, which
  // defeats the point of a memory system that exists to reduce friction.
  'save_memory',
  'forget_memory',
  'read_memory',
  // distill_memory is read-only — it analyses the memdir and returns
  // proposals; the actual mutations happen via save_memory / forget_memory
  // which already auto-approve. Prompting per-call would be noise.
  'distill_memory',
])

// Tools that already have their own user approval flow (InlineDiff)
const HAS_OWN_APPROVAL = new Set([
  'write_file',
  'edit_file',
  'create_file',
])

/** Determine the permission scope for a tool name. */
function getToolScope(toolName: string): 'core' | 'mcp' {
  return toolName.startsWith('mcp__') ? 'mcp' : 'core'
}

/** Why this permission requires a forced prompt (bypasses "Accept All") */
export type PromptReason = 'sensitive_file' | 'dangerous_command' | 'browser_action' | 'path_access' | 'generated_file' | 'untracked_file' | 'env_file' | null

/**
 * Outcome of a permission request — enriched so callers can record the path
 * the decision took (used by sessionExport to surface user-approved tool calls
 * in forensics; without it we mis-attribute approved-but-destructive commands
 * as model bugs).
 */
export interface PermissionDecision {
  /** Final verdict: was the tool allowed to run? */
  approved: boolean
  /** True iff a dialog was shown to the user. False when auto-approved
   *  (safe tool, scope-approved, has-own-approval) — distinguishes silent
   *  approval from an active user choice. */
  prompted: boolean
  /** Where the decision came from. ('auto_classifier' era o Modo Auto
   *  pré-YOLO — transcripts antigos ainda o carregam; ninguém ramifica nele.) */
  source: 'safe_tool' | 'has_own_approval' | 'approved_scope' | 'user' | 'yolo'
  /** When source === 'user' and the user denied (or approved with a flagged
   *  prompt kind), this is the reason supplied via `denyWith` / promptReason. */
  denyReason?: string
  /** When the dialog was shown, what kind of prompt drove it. */
  promptKind?: PromptReason
}

export interface PermissionOrigin {
  /** parallelTaskStore run id — task rows match on this to badge "Autorização". */
  taskId: string
  /** Task description shown in the dialog ("Pedido pela tarefa: …"). */
  label: string
  /** Sessão de chat da tarefa — cards interativos (perguntas/credenciais)
   *  são escritos NELA, não na sessão que o user está a ver. */
  sessionId?: string
  /** Project this run belongs to (in-window multi-project). Permission
   *  checks and approve* writes use THIS project's grants, not the
   *  focused project's. */
  projectId?: string
}

interface PendingPermission {
  id: string
  toolName: string
  args: Record<string, unknown>
  /** Set when the request comes from a parallel-task agent (not the main run). */
  origin?: PermissionOrigin
  /** Project whose grants this prompt should read/write. Resolved at
   *  enqueue time from origin.projectId ?? activeProjectId so approve*
   *  never applies to the wrong project if focus changes mid-dialog. */
  projectId?: string | null
  /** Why this prompt was forced — null means normal permission flow */
  promptReason: PromptReason
  /** When promptReason is 'path_access', the directory being requested for access */
  pathAccessTarget?: string
  /** Resolves the pending `requestPermission` promise. */
  resolve: (result: PermissionDecision) => void
}

interface PermissionState {
  /** Focused project id — flat grant fields below mirror `byProject[this]`. */
  activeProjectId: string | null
  /** Grants for every open/hydrated project. Source of truth for checks. */
  byProject: Record<string, ProjectPermissionGrants>
  /** Current (focused) project path — mirror of byProject[active].projectPath. */
  projectPath: string | null
  /** Scopes where user clicked "Accept All" — 'core' and 'mcp' are independent */
  approvedScopes: Set<'core' | 'mcp'>
  /** Per-project tool names the user clicked "Always allow in this project" for. */
  projectToolAllowlist: Set<string>
  /** Global tool names the user clicked "Always allow" for (cross-project). */
  globalToolAllowlist: Set<string>
  /** Per-project command PREFIXES the user clicked "Always allow" for
   *  (e.g. `'gcloud secrets versions add'`). Grant narrow de shell — ver
   *  commandPrefix.ts. Honrado mesmo em Modo Auto. */
  projectCommandAllowlist: Set<string>
  /** Global command prefixes (cross-project), em localStorage. */
  globalCommandAllowlist: Set<string>
  /** Extra directories the user approved for agent file access, beyond the
   *  project root. Persists in app-managed per-project state. */
  additionalDirectories: Set<string>
  /** When true, file diffs (write_file/edit_file/create_file) are auto-accepted without user confirmation */
  autoApproveDiffs: boolean
  /** Modo YOLO — grant POR PROJECTO, persistido em permissions.json. ON = zero dialogs. */
  autoModePermissions: boolean
  /** When true, user clicked "Deny All" — auto-deny all non-dangerous queued permissions */
  autoDenyAll: boolean
  /** Current permission being shown to the user */
  pendingPermission: PendingPermission | null
  /** Queue of permissions waiting to be shown (FIFO) */
  permissionQueue: PendingPermission[]
}

interface PermissionActions {
  requestPermission: (toolName: string, args: Record<string, unknown>, forcePrompt?: boolean | PromptReason, origin?: PermissionOrigin) => Promise<PermissionDecision>
  /** Caminho interno: mostra/enfileira o diálogo humano (fluxo normal,
   *  YOLO OFF). */
  enqueuePermissionDialog: (toolName: string, args: Record<string, unknown>, promptReason: PromptReason, origin?: PermissionOrigin) => Promise<PermissionDecision>
  /** Prompt the user to allow agent access to a directory outside the project root.
   *  If approved, the directory is added to that project's additionalDirectories.
   *  `projectId` (optional) scopes the grant to a background project-run. */
  requestPathAccess: (filePath: string, directoryToAdd: string, projectId?: string | null) => Promise<PermissionDecision>
  /** Add a directory to additionalDirectories. persist=true writes to disk. */
  addDirectory: (path: string, persist: boolean) => void
  /** Remove a directory from additionalDirectories and persist. */
  removeDirectory: (path: string) => void
  approve: () => void
  approveAll: () => void
  /** Approve current + add to per-project allowlist (persisted to disk). For
   *  command-scoped tools, `commandPrefix` (edited in the dialog, else the
   *  extracted prefix) is stored instead of the tool name. */
  approveAlwaysInProject: (commandPrefix?: string) => void
  /** Approve current + add to global allowlist (persisted to localStorage).
   *  `commandPrefix` as above. */
  approveAlwaysGlobal: (commandPrefix?: string) => void
  deny: () => void
  /** Deny the current permission and auto-deny all subsequent queued
   *  non-dangerous permissions in the same session. */
  denyAll: () => void
  /** Deny the current pending permission and feed a user-written reason back
   *  to the agent as part of the tool's result. Useful when the default
   *  "Permission denied" message isn't expressive enough. */
  denyWith: (reason: string) => void
  setAutoApproveDiffs: (value: boolean) => void
  setAutoModePermissions: (enabled: boolean) => void
  resetAutoApprove: () => void
  clearPending: () => void
  /** Cancela (nega) os pedidos pendentes de UMA tarefa paralela parada. */
  cancelByOrigin: (taskId: string) => void
  /** Returns the number of permissions waiting in the queue (excluding the
   *  currently displayed one). Used by UI to show confirmation before
   *  approveAll when there are many pending requests. */
  getQueuedCount: () => number
}

/**
 * Advance to the next queued permission, if any.
 * Called after approve/deny resolves the current pending permission.
 */
function advanceQueue(set: (fn: (state: PermissionState) => Partial<PermissionState>) => void, get: () => PermissionState & PermissionActions): void {
  const { permissionQueue, globalToolAllowlist } = get()
  if (permissionQueue.length === 0) return

  // Find the next permission that isn't already auto-approved.
  // Sensitive/flagged permissions ALWAYS show a dialog — never auto-approved.
  // Each queued entry resolves against ITS OWN project grants (projectId stamped
  // at enqueue) — never the focused project's.
  const remaining = [...permissionQueue]
  while (remaining.length > 0) {
    const next = remaining.shift()!
    const pid = next.projectId
    // YOLO toggled on mid-queue: drain without dialogs.
    if (isAutoModeEnabled(pid)) {
      next.resolve(yoloApprove())
      continue
    }
    if (next.promptReason) {
      // Flagged command or sensitive file — must show dialog every time
      set(() => ({ pendingPermission: next, permissionQueue: remaining }))
      return
    }
    const grants = getProjectGrants(pid)
    // Grant por prefixo de comando — resolve sem prompt.
    if (matchesGrantedCommandPrefix(next.toolName, next.args, pid)) {
      next.resolve({ approved: true, prompted: false, source: 'user' })
      continue
    }
    // Check tool-specific allowlists first (more specific than scopes)
    if (globalToolAllowlist.has(next.toolName) || grants.projectToolAllowlist.has(next.toolName)) {
      next.resolve({ approved: true, prompted: false, source: 'user' })
      continue
    }
    const scope = getToolScope(next.toolName)
    if (grants.approvedScopes.has(scope)) {
      next.resolve({ approved: true, prompted: false, source: 'approved_scope' })
      continue
    }
    // Show this one to the user
    set(() => ({ pendingPermission: next, permissionQueue: remaining }))
    return
  }
  // Queue exhausted
  set(() => ({ permissionQueue: [] }))
}

export const usePermissionStore = create<PermissionState & PermissionActions>()((set, get) => ({
  activeProjectId: null,
  byProject: {},
  projectPath: null,
  approvedScopes: new Set(),
  projectToolAllowlist: new Set(),
  globalToolAllowlist: loadGlobalToolAllowlist(),
  projectCommandAllowlist: new Set(),
  globalCommandAllowlist: loadGlobalCommandAllowlist(),
  additionalDirectories: new Set(),
  autoApproveDiffs: loadAutoApproveDiffs(),
  autoModePermissions: false,
  autoDenyAll: false,
  pendingPermission: null,
  permissionQueue: [],

  requestPermission: (toolName, args, forcePrompt, origin) => {
    // forcePrompt (sensitive files, flagged commands) shows the dialog in
    // NORMAL mode — Accept All / scopes cannot skip it. YOLO mode (below)
    // short-circuits EVERYTHING, including forcePrompt.
    // Accepts boolean (legacy compat) or a PromptReason string.
    const promptReason: PromptReason = typeof forcePrompt === 'string'
      ? forcePrompt
      : forcePrompt === true ? 'sensitive_file' : null

    // Resolve the project THIS request belongs to once. Background project-runs
    // stamp origin.projectId; the main/focused agent falls through to active.
    const projectId = origin?.projectId ?? get().activeProjectId
    const grants = getProjectGrants(projectId)

    // ── MODO YOLO ──
    // ON: zero permission UI for this project (tools, dangerous cmds, secrets,
    // path access via requestPathAccess). Diffs auto-accept in chatStore when
    // autoModePermissions is set. OFF: full normal flow below.
    // SEM excepções (decisão do produto, 2026-08-03): "o YOLO fura tudo; o
    // único travão é o humano" — que o liga e desliga. A válvula do .env
    // ('env_file', F1-9) também é auto-aprovada aqui: em modo normal ela
    // mostra SEMPRE o diálogo; em YOLO, autonomia total significa total.
    if (isAutoModeEnabled(projectId)) {
      return Promise.resolve(yoloApprove())
    }

    if (!forcePrompt) {
      // Grant por PREFIXO DE COMANDO (narrow, consentido) — verificado ANTES
      // de allowlists largos por nome de tool.
      if (matchesGrantedCommandPrefix(toolName, args, projectId)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'user' })
      }

      // Tool-specific allowlists first (more specific than scopes)
      if (get().globalToolAllowlist.has(toolName)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'user' })
      }
      if (grants.projectToolAllowlist.has(toolName)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'user' })
      }

      const scope = getToolScope(toolName)

      // User authorized all tools in this scope (core or mcp) FOR THIS PROJECT
      if (grants.approvedScopes.has(scope)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'approved_scope' })
      }

      // User clicked "Deny All" — auto-deny non-dangerous queued tools
      if (get().autoDenyAll && !promptReason) {
        return Promise.resolve({ approved: false, prompted: false, source: 'user' })
      }

      if (SAFE_TOOLS.has(toolName)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'safe_tool' })
      }
      if (HAS_OWN_APPROVAL.has(toolName)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'has_own_approval' })
      }
    }

    return get().enqueuePermissionDialog(toolName, args, promptReason, origin)
  },

  enqueuePermissionDialog: (toolName, args, promptReason, origin) => {
    return new Promise<PermissionDecision>((resolve) => {
      const projectId = origin?.projectId ?? get().activeProjectId
      const entry: PendingPermission = {
        id: crypto.randomUUID(),
        toolName,
        args,
        promptReason,
        projectId,
        ...(origin ? { origin } : {}),
        resolve,
      }

      const { pendingPermission } = get()
      if (pendingPermission === null) {
        // No active dialog — show immediately
        set({ pendingPermission: entry })
      } else {
        // Dialog already showing — queue this request
        set(state => ({ permissionQueue: [...state.permissionQueue, entry] }))
      }
      // Dialog IS the interaction surface — no chat breadcrumb spam for
      // permission prompts (user 2026-07-24).
    })
  },

  approve: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      const pid = pendingPermission.projectId
      // For path_access prompts, add the directory (session only — no disk write)
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const target = pendingPermission.pathAccessTarget
        mutateProjectGrants(pid, (g) => {
          const dirs = new Set(g.additionalDirectories)
          dirs.add(target)
          return { ...g, additionalDirectories: dirs }
        }, { syncDirs: true })
        set({ pendingPermission: null, autoDenyAll: false })
      } else {
        set({ pendingPermission: null, autoDenyAll: false })
      }
      pendingPermission.resolve({
        approved: true,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      advanceQueue(set, get)
    }
  },

  approveAll: () => {
    const { pendingPermission, permissionQueue } = get()
    if (pendingPermission) {
      const pid = pendingPermission.projectId
      // path_access não tem "scope" de tool para aprovar em massa — conceder a
      // PASTA-MÃE é a aprovação em massa (cobre tudo o que está lá dentro, via
      // isPathWithinRoots startsWith). Sem isto, "Aprovar tudo" devolvia
      // approved:true mas NUNCA adicionava a pasta → o acesso seguinte voltava
      // a pedir (o "aprovar duas vezes"). Espelha approve()/approveAlwaysInProject().
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const target = pendingPermission.pathAccessTarget
        mutateProjectGrants(pid, (g) => {
          const dirs = new Set(g.additionalDirectories)
          dirs.add(target)
          return { ...g, additionalDirectories: dirs }
        }, { persist: true, syncDirs: true })
        set({ pendingPermission: null, autoDenyAll: false })
        pendingPermission.resolve({ approved: true, prompted: true, source: 'user', promptKind: 'path_access' })
        advanceQueue(set, get)
        return
      }
      const scope = getToolScope(pendingPermission.toolName)
      // Auto-approve diffs when core tools are approved (cross-project pref)
      const autoApproveDiffs = scope === 'core' ? true : get().autoApproveDiffs
      if (autoApproveDiffs) saveAutoApproveDiffs(true)

      let scopesAfter = getProjectGrants(pid).approvedScopes
      mutateProjectGrants(pid, (g) => {
        const scopes = new Set(g.approvedScopes)
        scopes.add(scope)
        scopesAfter = scopes
        return { ...g, approvedScopes: scopes }
      }, { persist: true })

      // Auto-approve queued permissions whose PROJECT grants the same scope,
      // but KEEP sensitive/flagged ones — they must always prompt individually.
      // Never approve project-B queue items from a project-A "approve all".
      const remaining: PendingPermission[] = []
      for (const queued of permissionQueue) {
        if (queued.promptReason) {
          remaining.push(queued)
          continue
        }
        // Only auto-resolve items that belong to the same project as the
        // approveAll click (or both have no projectId).
        const sameProject = (queued.projectId ?? null) === (pid ?? null)
        if (sameProject) {
          const qGrants = getProjectGrants(queued.projectId)
          const qScope = getToolScope(queued.toolName)
          if (qGrants.approvedScopes.has(qScope) || scopesAfter.has(qScope)) {
            queued.resolve({ approved: true, prompted: false, source: 'approved_scope' })
            continue
          }
        }
        remaining.push(queued)
      }

      set({ pendingPermission: null, autoApproveDiffs, permissionQueue: remaining })

      pendingPermission.resolve({
        approved: true,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      advanceQueue(set, get)
    }
  },

  approveAlwaysInProject: (commandPrefix?: string) => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      const pid = pendingPermission.projectId
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const target = pendingPermission.pathAccessTarget
        mutateProjectGrants(pid, (g) => {
          const dirs = new Set(g.additionalDirectories)
          dirs.add(target)
          return { ...g, additionalDirectories: dirs }
        }, { persist: true, syncDirs: true })
        set({ pendingPermission: null, autoDenyAll: false })
      } else if (COMMAND_SCOPED_TOOLS.has(pendingPermission.toolName)) {
        // Grant POR PREFIXO, não pelo nome execute_command (senão voltávamos ao
        // grant largo que causou o incidente). Prefixo editado no diálogo tem
        // prioridade; senão o extraído. Sem prefixo (composto/bare/path) →
        // aprova só desta vez, nunca cria um grant largo daqui.
        const cmd = typeof pendingPermission.args.command === 'string' ? pendingPermission.args.command : ''
        const prefix = (commandPrefix ? sanitizeCommandPrefix(commandPrefix) : null) ?? getCommandPrefix(cmd)
        if (prefix) {
          mutateProjectGrants(pid, (g) => {
            const cmdAllowlist = new Set(g.projectCommandAllowlist)
            cmdAllowlist.add(prefix)
            return { ...g, projectCommandAllowlist: cmdAllowlist }
          }, { persist: true })
          set({ pendingPermission: null, autoDenyAll: false })
        } else {
          set({ pendingPermission: null, autoDenyAll: false })
        }
      } else {
        const toolName = pendingPermission.toolName
        mutateProjectGrants(pid, (g) => {
          const toolAllowlist = new Set(g.projectToolAllowlist)
          toolAllowlist.add(toolName)
          return { ...g, projectToolAllowlist: toolAllowlist }
        }, { persist: true })
        set({ pendingPermission: null, autoDenyAll: false })
      }
      pendingPermission.resolve({
        approved: true,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      advanceQueue(set, get)
    }
  },

  approveAlwaysGlobal: (commandPrefix?: string) => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      const pid = pendingPermission.projectId
      // path_access: conceder a pasta-mãe (= "permitir esta pasta e tudo lá
      // dentro"). O globalToolAllowlist é para TOOLS, não para pastas — sem
      // este ramo, escolher "sempre (global)" no prompt de acesso devolvia
      // approved:true mas não concedia a pasta → re-prompt. Persistência
      // verdadeiramente global (cross-project) exigiria um store de dirs
      // próprio; por agora persiste no permissions.json do projeto (igual ao
      // "sempre no projeto"), o que já elimina o duplo pedido.
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const target = pendingPermission.pathAccessTarget
        mutateProjectGrants(pid, (g) => {
          const dirs = new Set(g.additionalDirectories)
          dirs.add(target)
          return { ...g, additionalDirectories: dirs }
        }, { persist: true, syncDirs: true })
        set({ pendingPermission: null, autoDenyAll: false })
        pendingPermission.resolve({ approved: true, prompted: true, source: 'user', promptKind: 'path_access' })
        advanceQueue(set, get)
        return
      }
      if (COMMAND_SCOPED_TOOLS.has(pendingPermission.toolName)) {
        // Grant global POR PREFIXO (localStorage), não pelo nome da tool.
        const cmd = typeof pendingPermission.args.command === 'string' ? pendingPermission.args.command : ''
        const prefix = (commandPrefix ? sanitizeCommandPrefix(commandPrefix) : null) ?? getCommandPrefix(cmd)
        if (prefix) {
          const globalCmd = new Set(get().globalCommandAllowlist)
          globalCmd.add(prefix)
          saveGlobalCommandAllowlist(globalCmd)
          set({ pendingPermission: null, globalCommandAllowlist: globalCmd, autoDenyAll: false })
        } else {
          set({ pendingPermission: null, autoDenyAll: false })
        }
      } else {
        const globalAllowlist = new Set(get().globalToolAllowlist)
        globalAllowlist.add(pendingPermission.toolName)
        saveGlobalToolAllowlist(globalAllowlist)
        set({ pendingPermission: null, globalToolAllowlist: globalAllowlist, autoDenyAll: false })
      }

      pendingPermission.resolve({
        approved: true,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      advanceQueue(set, get)
    }
  },

  deny: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      set({ pendingPermission: null })
      pendingPermission.resolve({
        approved: false,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      void logPermission(`✗ Recusaste \`${pendingPermission.toolName}\``, 'warn')
      advanceQueue(set, get)
    }
  },

  denyAll: () => {
    const { pendingPermission, permissionQueue } = get()
    if (pendingPermission) {
      // Deny all queued non-dangerous permissions; keep dangerous ones for
      // the user to review individually.
      const remaining: PendingPermission[] = []
      for (const queued of permissionQueue) {
        if (queued.promptReason) {
          // Dangerous — must still show dialog
          remaining.push(queued)
        } else {
          queued.resolve({ approved: false, prompted: false, source: 'user' })
        }
      }

      set({ pendingPermission: null, autoDenyAll: true, permissionQueue: remaining })

      pendingPermission.resolve({
        approved: false,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      void logPermission(`✗ Recusaste todos \`${pendingPermission.toolName}\``, 'warn')
      advanceQueue(set, get)
    }
  },

  denyWith: (reason: string) => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      set({ pendingPermission: null })
      pendingPermission.resolve({
        approved: false,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
        denyReason: reason.trim() || undefined,
      })
      const trimmed = reason.trim()
      void logPermission(
        trimmed
          ? `✗ Recusaste \`${pendingPermission.toolName}\`: ${trimmed.slice(0, 140)}`
          : `✗ Recusaste \`${pendingPermission.toolName}\``,
        'warn',
      )
      advanceQueue(set, get)
    }
  },

  setAutoApproveDiffs: (value: boolean) => {
    saveAutoApproveDiffs(value)
    set({ autoApproveDiffs: value })
  },

  setAutoModePermissions: (enabled: boolean) => {
    // Toggle applies to the focused project only (UI chrome is per-view).
    const pid = get().activeProjectId
    mutateProjectGrants(pid, (g) => ({
      ...g,
      autoModePermissions: enabled,
    }), { persist: true })

    // YOLO ON mid-dialog: approve the open request + drain the queue so the
    // agent is not stuck behind a dialog the user just opted out of.
    if (enabled) {
      const { pendingPermission, permissionQueue } = get()
      if (pendingPermission) {
        // Only auto-resolve entries for THIS project (or unscoped / active).
        const pendingPid = pendingPermission.projectId ?? pid
        if (!pid || !pendingPid || pendingPid === pid) {
          set({ pendingPermission: null })
          pendingPermission.resolve(yoloApprove())
        }
      }
      const remaining: typeof permissionQueue = []
      for (const entry of get().permissionQueue) {
        const entryPid = entry.projectId ?? pid
        if (!pid || !entryPid || entryPid === pid) {
          entry.resolve(yoloApprove())
        } else {
          remaining.push(entry)
        }
      }
      set({ permissionQueue: remaining })
      // If we cleared pending but left foreign queue items, surface the next one.
      if (!get().pendingPermission && remaining.length > 0) {
        advanceQueue(set, get)
      }
    }
  },

  resetAutoApprove: () => {
    saveAutoApproveDiffs(false)
    // Reset ONLY the focused project's grants — never wipe a background
    // project's in-memory allowlists (a main-run cancel must not disarm B).
    mutateProjectGrants(get().activeProjectId, (g) => ({
      ...g,
      approvedScopes: new Set(),
      projectToolAllowlist: new Set(),
      additionalDirectories: new Set(),
    }), { persist: true, syncDirs: true })
    set({ autoApproveDiffs: false, autoDenyAll: false })
  },

  addDirectory: (path: string, persist: boolean) => {
    const pid = get().activeProjectId
    const grants = getProjectGrants(pid)
    if (grants.additionalDirectories.has(path)) return
    mutateProjectGrants(pid, (g) => {
      const dirs = new Set(g.additionalDirectories)
      dirs.add(path)
      return { ...g, additionalDirectories: dirs }
    }, { persist, syncDirs: true })
  },

  removeDirectory: (path: string) => {
    const pid = get().activeProjectId
    const grants = getProjectGrants(pid)
    if (!grants.additionalDirectories.has(path)) return
    mutateProjectGrants(pid, (g) => {
      const dirs = new Set(g.additionalDirectories)
      dirs.delete(path)
      return { ...g, additionalDirectories: dirs }
    }, { persist: true, syncDirs: true })
  },

  requestPathAccess: (filePath: string, directoryToAdd: string, projectId?) => {
    const pid = projectId ?? get().activeProjectId
    // Already approved FOR THIS PROJECT — silent pass. Never consult another
    // project's additionalDirectories (cross-contamination).
    if (getProjectGrants(pid).additionalDirectories.has(directoryToAdd)) {
      return Promise.resolve({ approved: true, prompted: false, source: 'user' as const })
    }

    // YOLO: external folder reads/writes never interrupt — auto-grant for
    // this project (persisted) and continue.
    if (isAutoModeEnabled(pid)) {
      mutateProjectGrants(pid, (g) => {
        const dirs = new Set(g.additionalDirectories)
        dirs.add(directoryToAdd)
        return { ...g, additionalDirectories: dirs }
      }, { persist: true, syncDirs: true })
      return Promise.resolve(yoloApprove())
    }

    return new Promise<PermissionDecision>((resolve) => {
      const entry: PendingPermission = {
        id: crypto.randomUUID(),
        toolName: 'path_access',
        args: { file_path: filePath },
        promptReason: 'path_access',
        pathAccessTarget: directoryToAdd,
        projectId: pid,
        resolve,
      }

      const { pendingPermission } = get()
      if (pendingPermission === null) {
        set({ pendingPermission: entry })
      } else {
        set(state => ({ permissionQueue: [...state.permissionQueue, entry] }))
      }
      void logPermission(
        `🔒 O agente pediu acesso a \`${directoryToAdd}\` (fora do projeto)`,
        'warn',
      )
    })
  },

  clearPending: () => {
    // Reject the MAIN run's current + queued permissions. Requests from a live
    // parallel TASK survive — stopping the main run doesn't stop them; theirs
    // clear via cancelByOrigin when the task itself stops. IMPORTANT: the main
    // run's OWN permissions carry a SYNTHETIC `project:{id}` origin (from
    // resolvePermissionOrigin, F2), so "has origin" ≠ "is a task" — a `project:`
    // origin belongs to the main run and MUST be rejected here, else Stop leaves
    // the main run's own permission dialog orphaned on screen.
    const isTaskOrigin = (o?: PermissionOrigin): boolean =>
      !!o && !o.taskId.startsWith('project:')
    const { pendingPermission, permissionQueue } = get()
    const keep: PendingPermission[] = []
    if (pendingPermission) {
      if (isTaskOrigin(pendingPermission.origin)) {
        keep.push(pendingPermission)
      } else {
        pendingPermission.resolve({
          approved: false,
          prompted: true,
          source: 'user',
          promptKind: pendingPermission.promptReason,
          denyReason: 'cancelled',
        })
      }
    }
    for (const queued of permissionQueue) {
      if (isTaskOrigin(queued.origin)) {
        keep.push(queued)
        continue
      }
      queued.resolve({
        approved: false,
        prompted: false,
        source: 'user',
        promptKind: queued.promptReason,
        denyReason: 'cancelled',
      })
    }
    set({ pendingPermission: keep[0] ?? null, permissionQueue: keep.slice(1) })
  },

  cancelByOrigin: (taskId: string) => {
    // Uma tarefa parada leva consigo os SEUS pedidos (e só os seus) — sem
    // isto a promise do requestPermission ficava pendurada para sempre e o
    // diálogo mostrava um pedido de um agente já morto.
    const { pendingPermission, permissionQueue } = get()
    const cancel = (entry: PendingPermission) =>
      entry.resolve({
        approved: false,
        prompted: false,
        source: 'user',
        promptKind: entry.promptReason,
        denyReason: 'task stopped',
      })
    let nextPending = pendingPermission
    if (pendingPermission?.origin?.taskId === taskId) {
      cancel(pendingPermission)
      nextPending = null
    }
    const remaining: PendingPermission[] = []
    for (const queued of permissionQueue) {
      if (queued.origin?.taskId === taskId) cancel(queued)
      else remaining.push(queued)
    }
    set({ pendingPermission: nextPending, permissionQueue: remaining })
    // Promoção via advanceQueue — re-passa pelos allowlists/scopes para não
    // mostrar um diálogo que o user já autorizou "sempre" (era a limitação
    // conhecida #4; promover com shift() saltava a auto-aprovação).
    if (nextPending === null && remaining.length > 0) {
      advanceQueue(set, get)
    }
  },

  getQueuedCount: () => {
    return get().permissionQueue.length
  },
}))
