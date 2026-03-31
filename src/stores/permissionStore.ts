import { create } from 'zustand'

const SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob',
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
  pendingPermission: PendingPermission | null
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

export const usePermissionStore = create<PermissionState & PermissionActions>()((set, get) => ({
  approvedScopes: new Set(),
  autoApproveDiffs: false,
  pendingPermission: null,

  requestPermission: (toolName, args, forcePrompt) => {
    const scope = getToolScope(toolName)

    // User authorized all tools in this scope (core or mcp)
    if (get().approvedScopes.has(scope)) return Promise.resolve(true)

    if (!forcePrompt) {
      if (SAFE_TOOLS.has(toolName)) return Promise.resolve(true)
      if (HAS_OWN_APPROVAL.has(toolName)) return Promise.resolve(true)
    }

    return new Promise<boolean>((resolve) => {
      set({
        pendingPermission: {
          id: crypto.randomUUID(),
          toolName,
          args,
          sensitive: !!forcePrompt,
          resolve,
        },
      })
    })
  },

  approve: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve(true)
      set({ pendingPermission: null })
    }
  },

  approveAll: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve(true)
      const scope = getToolScope(pendingPermission.toolName)
      const scopes = new Set(get().approvedScopes)
      scopes.add(scope)
      // Auto-approve diffs when core tools are approved
      const autoApproveDiffs = scope === 'core' ? true : get().autoApproveDiffs
      set({ pendingPermission: null, approvedScopes: scopes, autoApproveDiffs })
    }
  },

  deny: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve(false)
      set({ pendingPermission: null })
    }
  },

  setAutoApproveDiffs: (value: boolean) => {
    set({ autoApproveDiffs: value })
  },

  resetAutoApprove: () => {
    set({ approvedScopes: new Set(), autoApproveDiffs: false })
  },

  /** Force-clear any pending permission (e.g. when agent is cancelled). */
  clearPending: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve(false)
      set({ pendingPermission: null })
    }
  },
}))
