import { create } from 'zustand'

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

interface PendingPermission {
  id: string
  toolName: string
  args: Record<string, unknown>
  /** File contains secrets — show warning in permission dialog */
  sensitive?: boolean
  resolve: (approved: boolean) => void
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
  requestPermission: (toolName: string, args: Record<string, unknown>, forcePrompt?: boolean) => Promise<boolean>
  approve: () => void
  approveAll: () => void
  deny: () => void
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

  // Find the next permission that isn't already auto-approved by scope
  const remaining = [...permissionQueue]
  while (remaining.length > 0) {
    const next = remaining.shift()!
    const scope = getToolScope(next.toolName)
    if (approvedScopes.has(scope)) {
      // Auto-approve this one and continue to the next
      next.resolve(true)
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
  autoApproveDiffs: false,
  pendingPermission: null,
  permissionQueue: [],

  requestPermission: (toolName, args, forcePrompt) => {
    const scope = getToolScope(toolName)

    // User authorized all tools in this scope (core or mcp)
    if (get().approvedScopes.has(scope)) return Promise.resolve(true)

    if (!forcePrompt) {
      if (SAFE_TOOLS.has(toolName)) return Promise.resolve(true)
      if (HAS_OWN_APPROVAL.has(toolName)) return Promise.resolve(true)
    }

    return new Promise<boolean>((resolve) => {
      const entry: PendingPermission = {
        id: crypto.randomUUID(),
        toolName,
        args,
        sensitive: !!forcePrompt,
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
    })
  },

  approve: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve(true)
      set({ pendingPermission: null })
      advanceQueue(set, get)
    }
  },

  approveAll: () => {
    const { pendingPermission, permissionQueue } = get()
    if (pendingPermission) {
      pendingPermission.resolve(true)
      const scope = getToolScope(pendingPermission.toolName)
      const scopes = new Set(get().approvedScopes)
      scopes.add(scope)
      // Auto-approve diffs when core tools are approved
      const autoApproveDiffs = scope === 'core' ? true : get().autoApproveDiffs

      // Auto-approve all queued permissions in the same scope
      const remaining: PendingPermission[] = []
      for (const queued of permissionQueue) {
        const qScope = getToolScope(queued.toolName)
        if (scopes.has(qScope)) {
          queued.resolve(true)
        } else {
          remaining.push(queued)
        }
      }

      set({ pendingPermission: null, approvedScopes: scopes, autoApproveDiffs, permissionQueue: remaining })
      advanceQueue(set, get)
    }
  },

  deny: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve(false)
      set({ pendingPermission: null })
      advanceQueue(set, get)
    }
  },

  setAutoApproveDiffs: (value: boolean) => {
    set({ autoApproveDiffs: value })
  },

  resetAutoApprove: () => {
    set({ approvedScopes: new Set(), autoApproveDiffs: false })
  },

  clearPending: () => {
    // Reject current + all queued permissions
    const { pendingPermission, permissionQueue } = get()
    if (pendingPermission) {
      pendingPermission.resolve(false)
    }
    for (const queued of permissionQueue) {
      queued.resolve(false)
    }
    set({ pendingPermission: null, permissionQueue: [] })
  },
}))
