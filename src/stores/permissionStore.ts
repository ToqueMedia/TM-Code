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
 *  trust grant and lives in `<project>/.toquemedia/permissions.json` via
 *  `permissionPersistence.ts` — see that file for the rationale. */
const STORAGE_KEY = 'chat_autoApproveDiffs'
function loadAutoApproveDiffs(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === 'true' } catch { return false }
}
function saveAutoApproveDiffs(value: boolean) {
  try { localStorage.setItem(STORAGE_KEY, String(value)) } catch { /* storage unavailable */ }
}

/** Fire-and-forget write of `approvedScopes` to the current project's
 *  `.toquemedia/permissions.json`. Resolves the project path lazily so
 *  this module doesn't pull the project store into its module graph at
 *  load time. */
function persistApprovedScopes(scopes: Set<'core' | 'mcp'>): void {
  void Promise.all([
    import('./projectStore'),
    import('../services/agent/permissionPersistence'),
  ]).then(([{ useProjectStore }, { savePermissionsToDisk }]) => {
    const path = useProjectStore.getState().currentProject?.path
    if (path) void savePermissionsToDisk(path, scopes)
  }).catch(() => { /* persistence failure must not break the permission flow */ })
}

/** Replace the live `approvedScopes` set — used at project-open time to
 *  hydrate from disk. Exposed as a module function rather than a store
 *  action so the projectStore hook can call it without round-tripping
 *  through React's update queue. */
export function hydrateApprovedScopes(scopes: Set<'core' | 'mcp'>): void {
  // Set directly — no persistence write here: this IS the load step. The
  // disk file is already canonical; writing back would be a no-op.
  usePermissionStore.setState({ approvedScopes: scopes })
}

const SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob',
  'get_diagnostics',
  'read_dev_server_logs',
  'read_large_result',
  'check_background_agents',
  'update_tasks',
  // read_skill loads bundled/global/project markdown — pure read, no
  // side effects. Without this, /review and any agent that consults
  // skills mid-session triggers a permission prompt per skill (the agent
  // typically reads several), which is hostile UX.
  'read_skill',
  // Memory persistence tools — confined to the validated `.toquemedia/memory/`
  // and `~/.toquemedia-studio/memory/` directories by the Rust layer.
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
export type PromptReason = 'sensitive_file' | 'dangerous_command' | 'browser_action' | null

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
  /** Resolves the pending `requestPermission` promise. */
  resolve: (result: PermissionDecision) => void
}

interface PermissionState {
  /** Scopes where user clicked "Accept All" — 'core' and 'mcp' are independent */
  approvedScopes: Set<'core' | 'mcp'>
  /** When true, file diffs (write_file/edit_file/create_file) are auto-accepted without user confirmation */
  autoApproveDiffs: boolean
  /** Current permission being shown to the user */
  pendingPermission: PendingPermission | null
  /** Queue of permissions waiting to be shown (FIFO) */
  permissionQueue: PendingPermission[]
}

interface PermissionActions {
  requestPermission: (toolName: string, args: Record<string, unknown>, forcePrompt?: boolean | PromptReason) => Promise<PermissionDecision>
  approve: () => void
  approveAll: () => void
  deny: () => void
  /** Deny the current pending permission and feed a user-written reason back
   *  to the agent as part of the tool's result. Useful when the default
   *  "Permission denied" message isn't expressive enough. */
  denyWith: (reason: string) => void
  setAutoApproveDiffs: (value: boolean) => void
  resetAutoApprove: () => void
  clearPending: () => void
}

/**
 * Advance to the next queued permission, if any.
 * Called after approve/deny resolves the current pending permission.
 */
function advanceQueue(set: (fn: (state: PermissionState) => Partial<PermissionState>) => void, get: () => PermissionState & PermissionActions): void {
  const { permissionQueue, approvedScopes } = get()
  if (permissionQueue.length === 0) return

  // Find the next permission that isn't already auto-approved by scope.
  // Sensitive/flagged permissions ALWAYS show a dialog — never auto-approved.
  const remaining = [...permissionQueue]
  while (remaining.length > 0) {
    const next = remaining.shift()!
    if (next.promptReason) {
      // Flagged command or sensitive file — must show dialog every time
      set(() => ({ pendingPermission: next, permissionQueue: remaining }))
      return
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
  approvedScopes: new Set(),
  autoApproveDiffs: loadAutoApproveDiffs(),
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
      const scope = getToolScope(toolName)

      // User authorized all tools in this scope (core or mcp)
      if (get().approvedScopes.has(scope)) {
        return Promise.resolve({ approved: true, prompted: false, source: 'approved_scope' })
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
      pendingPermission.resolve({
        approved: true,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      void logPermission(`✓ Autorizaste \`${pendingPermission.toolName}\``, 'success')
      set({ pendingPermission: null })
      advanceQueue(set, get)
    }
  },

  approveAll: () => {
    const { pendingPermission, permissionQueue } = get()
    if (pendingPermission) {
      pendingPermission.resolve({
        approved: true,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      const scope = getToolScope(pendingPermission.toolName)
      void logPermission(
        `✓ Autorizaste \`${pendingPermission.toolName}\` e todas as ferramentas ${scope === 'core' ? 'internas' : 'MCP'} para esta sessão`,
        'success',
      )
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
      persistApprovedScopes(scopes)
      advanceQueue(set, get)
    }
  },

  deny: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve({
        approved: false,
        prompted: true,
        source: 'user',
        promptKind: pendingPermission.promptReason,
      })
      void logPermission(`✗ Recusaste \`${pendingPermission.toolName}\``, 'warn')
      set({ pendingPermission: null })
      advanceQueue(set, get)
    }
  },

  denyWith: (reason: string) => {
    const { pendingPermission } = get()
    if (pendingPermission) {
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
      set({ pendingPermission: null })
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
    set({ approvedScopes: empty, autoApproveDiffs: false })
    persistApprovedScopes(empty)
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
}))
