import { create } from 'zustand'

/**
 * Best-effort summary of tool args for the chat transcript log line. The full
 * args may be huge (read_file with 200K context); we want the user to see at a
 * glance which file/command was being requested. Truncate at 120 chars and
 * single-line so the system message bullet stays readable.
 */
function summarizeArgs(args: Record<string, unknown>): string {
  const interesting = ['path', 'file_path', 'command', 'url', 'name', 'pattern']
  for (const key of interesting) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) {
      const oneLine = v.replace(/\s+/g, ' ').slice(0, 120)
      return oneLine.length === 120 ? `${oneLine}…` : oneLine
    }
  }
  // Fallback: keys list — gives at least some signal about what was queried.
  const keys = Object.keys(args).join(', ')
  return keys ? `(${keys})` : ''
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

/** Fire-and-forget write of `approvedScopes` + `projectToolAllowlist` to
 *  the current project's app-managed state. Uses the store's own
 *  `projectPath` so it works in both Chat Mode (set by
 *  projectStore.openProject) and Terminal Mode (set by TerminalView)
 *  without depending on projectStore. */
function persistPermissions(): void {
  const { projectPath, approvedScopes, projectToolAllowlist, additionalDirectories } = usePermissionStore.getState()
  if (!projectPath) return
  void import('../services/agent/permissionPersistence')
    .then(({ savePermissionsToDisk }) => savePermissionsToDisk(projectPath, approvedScopes, projectToolAllowlist, additionalDirectories))
    .catch(() => { /* persistence failure must not break the permission flow */ })
}

/** Fire-and-forget sync of `additionalDirectories` to the Rust side. The
 *  terminal/PTY commands clamp cwd via `clamp_to_allowed` (container.rs),
 *  which only knows the directories we push here — without this sync, a
 *  user-approved external directory would pass the frontend permission
 *  check and then be silently clamped back to the project root by Rust.
 *  Must be called after EVERY mutation of `additionalDirectories`
 *  (grant, revoke, reset, hydrate). */
function syncAllowedDirectoriesToRust(): void {
  const dirs = Array.from(usePermissionStore.getState().additionalDirectories)
  void import('@/utils/invokeMetrics')
    .then(({ invoke }) => invoke('set_agent_allowed_directories', { directories: dirs }))
    .catch(() => { /* sync failure must not break the permission flow */ })
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

/** Replace the live `approvedScopes` and `projectToolAllowlist` sets —
 *  used at project-open time to hydrate from disk. Exposed as a module
 *  function rather than a store action so the projectStore hook can call
 *  it without round-tripping through React's update queue.
 *  Also sets `projectPath` so `persistPermissions` writes to the
 *  correct project in both Chat Mode and Terminal Mode. */
export function hydrateApprovedScopes(
  scopes: Set<'core' | 'mcp'>,
  projectPath?: string,
  tools?: Set<string>,
  directories?: Set<string>,
): void {
  // Set directly — no persistence write here: this IS the load step. The
  // disk file is already canonical; writing back would be a no-op.
  const patch: Partial<PermissionState> = { approvedScopes: scopes }
  if (tools) patch.projectToolAllowlist = tools
  if (directories) patch.additionalDirectories = directories
  if (projectPath != null) patch.projectPath = projectPath
  usePermissionStore.setState(patch)
  syncAllowedDirectoriesToRust()
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
export type PromptReason = 'sensitive_file' | 'dangerous_command' | 'browser_action' | 'path_access' | null

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
  /** Where the decision came from. */
  source: 'safe_tool' | 'has_own_approval' | 'approved_scope' | 'user'
  /** When source === 'user' and the user denied (or approved with a flagged
   *  prompt kind), this is the reason supplied via `denyWith` / promptReason. */
  denyReason?: string
  /** When the dialog was shown, what kind of prompt drove it. */
  promptKind?: PromptReason
}

interface PendingPermission {
  id: string
  toolName: string
  args: Record<string, unknown>
  /** Why this prompt was forced — null means normal permission flow */
  promptReason: PromptReason
  /** When promptReason is 'path_access', the directory being requested for access */
  pathAccessTarget?: string
  /** Resolves the pending `requestPermission` promise. */
  resolve: (result: PermissionDecision) => void
}

interface PermissionState {
  /** Current project path — set by whoever opens a project (projectStore
   *  in Chat Mode, TerminalView in CMD Mode) so persistPermissions
   *  writes to the correct project without depending on projectStore. */
  projectPath: string | null
  /** Scopes where user clicked "Accept All" — 'core' and 'mcp' are independent */
  approvedScopes: Set<'core' | 'mcp'>
  /** Per-project tool names the user clicked "Always allow in this project" for. */
  projectToolAllowlist: Set<string>
  /** Global tool names the user clicked "Always allow" for (cross-project). */
  globalToolAllowlist: Set<string>
  /** Extra directories the user approved for agent file access, beyond the
   *  project root. Persists in app-managed per-project state. */
  additionalDirectories: Set<string>
  /** When true, file diffs (write_file/edit_file/create_file) are auto-accepted without user confirmation */
  autoApproveDiffs: boolean
  /** When true, user clicked "Deny All" — auto-deny all non-dangerous queued permissions */
  autoDenyAll: boolean
  /** Current permission being shown to the user */
  pendingPermission: PendingPermission | null
  /** Queue of permissions waiting to be shown (FIFO) */
  permissionQueue: PendingPermission[]
}

interface PermissionActions {
  requestPermission: (toolName: string, args: Record<string, unknown>, forcePrompt?: boolean | PromptReason) => Promise<PermissionDecision>
  /** Prompt the user to allow agent access to a directory outside the project root.
   *  If approved, the directory is added to additionalDirectories. */
  requestPathAccess: (filePath: string, directoryToAdd: string) => Promise<PermissionDecision>
  /** Add a directory to additionalDirectories. persist=true writes to disk. */
  addDirectory: (path: string, persist: boolean) => void
  /** Remove a directory from additionalDirectories and persist. */
  removeDirectory: (path: string) => void
  approve: () => void
  approveAll: () => void
  /** Approve current + add tool to per-project allowlist (persisted to disk). */
  approveAlwaysInProject: () => void
  /** Approve current + add tool to global allowlist (persisted to localStorage). */
  approveAlwaysGlobal: () => void
  deny: () => void
  /** Deny the current permission and auto-deny all subsequent queued
   *  non-dangerous permissions in the same session. */
  denyAll: () => void
  /** Deny the current pending permission and feed a user-written reason back
   *  to the agent as part of the tool's result. Useful when the default
   *  "Permission denied" message isn't expressive enough. */
  denyWith: (reason: string) => void
  setAutoApproveDiffs: (value: boolean) => void
  resetAutoApprove: () => void
  clearPending: () => void
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
  const { permissionQueue, approvedScopes, projectToolAllowlist, globalToolAllowlist } = get()
  if (permissionQueue.length === 0) return

  // Find the next permission that isn't already auto-approved.
  // Sensitive/flagged permissions ALWAYS show a dialog — never auto-approved.
  const remaining = [...permissionQueue]
  while (remaining.length > 0) {
    const next = remaining.shift()!
    if (next.promptReason) {
      // Flagged command or sensitive file — must show dialog every time
      set(() => ({ pendingPermission: next, permissionQueue: remaining }))
      return
    }
    // Check tool-specific allowlists first (more specific than scopes)
    if (globalToolAllowlist.has(next.toolName) || projectToolAllowlist.has(next.toolName)) {
      next.resolve({ approved: true, prompted: false, source: 'user' })
      continue
    }
    const scope = getToolScope(next.toolName)
    if (approvedScopes.has(scope)) {
      // Auto-approve this one and continue to the next
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
  projectPath: null,
  approvedScopes: new Set(),
  projectToolAllowlist: new Set(),
  globalToolAllowlist: loadGlobalToolAllowlist(),
  additionalDirectories: new Set(),
  autoApproveDiffs: loadAutoApproveDiffs(),
  autoDenyAll: false,
  pendingPermission: null,
  permissionQueue: [],

  requestPermission: (toolName, args, forcePrompt) => {
    // forcePrompt (sensitive files, flagged commands) ALWAYS shows the dialog.
    // It bypasses scope auto-approval — the user must approve every time.
    // Accepts boolean (legacy compat) or a PromptReason string.
    const promptReason: PromptReason = typeof forcePrompt === 'string'
      ? forcePrompt
      : forcePrompt === true ? 'sensitive_file' : null

    if (!forcePrompt) {
      // Tool-specific allowlists first (more specific than scopes)
      if (get().globalToolAllowlist.has(toolName)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'user' })
      }
      if (get().projectToolAllowlist.has(toolName)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'user' })
      }

      const scope = getToolScope(toolName)

      // User authorized all tools in this scope (core or mcp)
      if (get().approvedScopes.has(scope)) {
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

    return new Promise<PermissionDecision>((resolve) => {
      const entry: PendingPermission = {
        id: crypto.randomUUID(),
        toolName,
        args,
        promptReason,
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
      // Persist a transcript record. Done AFTER the state set so the chat
      // bullet appears at the same time the modal opens, not seconds later.
      const summary = summarizeArgs(args)
      const reasonTag =
        promptReason === 'sensitive_file' ? ' · ficheiro sensível' :
        promptReason === 'dangerous_command' ? ' · comando potencialmente destrutivo' :
        promptReason === 'browser_action' ? ' · ação no browser' :
        ''
      void logPermission(
        `🔒 O agente pediu autorização para usar \`${toolName}\`${summary ? `: ${summary}` : ''}${reasonTag}`,
        promptReason ? 'warn' : 'info',
      )
    })
  },

  approve: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      // For path_access prompts, add the directory (session only)
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const dirs = new Set(get().additionalDirectories)
        dirs.add(pendingPermission.pathAccessTarget)
        set({ pendingPermission: null, autoDenyAll: false, additionalDirectories: dirs })
        syncAllowedDirectoriesToRust()
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
      // path_access não tem "scope" de tool para aprovar em massa — conceder a
      // PASTA-MÃE é a aprovação em massa (cobre tudo o que está lá dentro, via
      // isPathWithinRoots startsWith). Sem isto, "Aprovar tudo" devolvia
      // approved:true mas NUNCA adicionava a pasta → o acesso seguinte voltava
      // a pedir (o "aprovar duas vezes"). Espelha approve()/approveAlwaysInProject().
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const dirs = new Set(get().additionalDirectories)
        dirs.add(pendingPermission.pathAccessTarget)
        set({ pendingPermission: null, additionalDirectories: dirs, autoDenyAll: false })
        syncAllowedDirectoriesToRust()
        pendingPermission.resolve({ approved: true, prompted: true, source: 'user', promptKind: 'path_access' })
        persistPermissions()
        advanceQueue(set, get)
        return
      }
      const scope = getToolScope(pendingPermission.toolName)
      const scopes = new Set(get().approvedScopes)
      scopes.add(scope)
      // Auto-approve diffs when core tools are approved
      const autoApproveDiffs = scope === 'core' ? true : get().autoApproveDiffs
      if (autoApproveDiffs) saveAutoApproveDiffs(true)

      // Auto-approve all queued permissions in the same scope,
      // but KEEP sensitive/flagged ones — they must always prompt individually.
      const remaining: PendingPermission[] = []
      for (const queued of permissionQueue) {
        if (queued.promptReason) {
          // Flagged command or sensitive file — never auto-approve
          remaining.push(queued)
        } else {
          const qScope = getToolScope(queued.toolName)
          if (scopes.has(qScope)) {
            queued.resolve({ approved: true, prompted: false, source: 'approved_scope' })
          } else {
            remaining.push(queued)
          }
        }
      }

      set({ pendingPermission: null, approvedScopes: scopes, autoApproveDiffs, permissionQueue: remaining })

      pendingPermission.resolve({
        approved: true,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      persistPermissions()
      advanceQueue(set, get)
    }
  },

  approveAlwaysInProject: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const dirs = new Set(get().additionalDirectories)
        dirs.add(pendingPermission.pathAccessTarget)
        set({ pendingPermission: null, additionalDirectories: dirs, autoDenyAll: false })
        syncAllowedDirectoriesToRust()
        pendingPermission.resolve({
          approved: true,
          prompted: true,
          source: 'user',
          promptKind: pendingPermission.promptReason,
        })
      } else {
        const toolAllowlist = new Set(get().projectToolAllowlist)
        toolAllowlist.add(pendingPermission.toolName)
        set({ pendingPermission: null, projectToolAllowlist: toolAllowlist, autoDenyAll: false })
        pendingPermission.resolve({
          approved: true,
          prompted: true,
          source: 'user',
          promptKind: pendingPermission.promptReason,
        })
      }
      persistPermissions()
      advanceQueue(set, get)
    }
  },

  approveAlwaysGlobal: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      // path_access: conceder a pasta-mãe (= "permitir esta pasta e tudo lá
      // dentro"). O globalToolAllowlist é para TOOLS, não para pastas — sem
      // este ramo, escolher "sempre (global)" no prompt de acesso devolvia
      // approved:true mas não concedia a pasta → re-prompt. Persistência
      // verdadeiramente global (cross-project) exigiria um store de dirs
      // próprio; por agora persiste no permissions.json do projeto (igual ao
      // "sempre no projeto"), o que já elimina o duplo pedido.
      if (pendingPermission.promptReason === 'path_access' && pendingPermission.pathAccessTarget) {
        const dirs = new Set(get().additionalDirectories)
        dirs.add(pendingPermission.pathAccessTarget)
        set({ pendingPermission: null, additionalDirectories: dirs, autoDenyAll: false })
        syncAllowedDirectoriesToRust()
        pendingPermission.resolve({ approved: true, prompted: true, source: 'user', promptKind: 'path_access' })
        persistPermissions()
        advanceQueue(set, get)
        return
      }
      const globalAllowlist = new Set(get().globalToolAllowlist)
      globalAllowlist.add(pendingPermission.toolName)
      saveGlobalToolAllowlist(globalAllowlist)
      set({ pendingPermission: null, globalToolAllowlist: globalAllowlist, autoDenyAll: false })

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

  resetAutoApprove: () => {
    saveAutoApproveDiffs(false)
    const empty = new Set<'core' | 'mcp'>()
    set({ approvedScopes: empty, projectToolAllowlist: new Set(), additionalDirectories: new Set(), autoApproveDiffs: false, autoDenyAll: false })
    syncAllowedDirectoriesToRust()
    persistPermissions()
  },

  addDirectory: (path: string, persist: boolean) => {
    const dirs = new Set(get().additionalDirectories)
    if (dirs.has(path)) return
    dirs.add(path)
    set({ additionalDirectories: dirs })
    syncAllowedDirectoriesToRust()
    if (persist) persistPermissions()
  },

  removeDirectory: (path: string) => {
    const dirs = new Set(get().additionalDirectories)
    if (!dirs.delete(path)) return
    set({ additionalDirectories: dirs })
    syncAllowedDirectoriesToRust()
    persistPermissions()
  },

  requestPathAccess: (filePath: string, directoryToAdd: string) => {
    // Already approved — silent pass
    if (get().additionalDirectories.has(directoryToAdd)) {
      return Promise.resolve({ approved: true, prompted: false, source: 'user' as const })
    }

    return new Promise<PermissionDecision>((resolve) => {
      const entry: PendingPermission = {
        id: crypto.randomUUID(),
        toolName: 'path_access',
        args: { file_path: filePath },
        promptReason: 'path_access',
        pathAccessTarget: directoryToAdd,
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
    // Reject current + all queued permissions
    const { pendingPermission, permissionQueue } = get()
    if (pendingPermission) {
      pendingPermission.resolve({
        approved: false,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
        denyReason: 'cancelled',
      })
    }
    for (const queued of permissionQueue) {
      queued.resolve({
        approved: false,
        prompted: false,
        source: 'user',
        promptKind: queued.promptReason,
        denyReason: 'cancelled',
      })
    }
    set({ pendingPermission: null, permissionQueue: [] })
  },

  getQueuedCount: () => {
    return get().permissionQueue.length
  },
}))
