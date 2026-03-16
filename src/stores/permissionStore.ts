import { create } from 'zustand'

const SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob',
])

// Tools that already have their own user approval flow (e.g. DiffPreview)
const HAS_OWN_APPROVAL = new Set([
  'write_file',
  'edit_file',
])

interface PendingPermission {
  id: string
  toolName: string
  args: Record<string, unknown>
  resolve: (approved: boolean) => void
}

interface PermissionState {
  autoApproveAll: boolean
  pendingPermission: PendingPermission | null
}

interface PermissionActions {
  requestPermission: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  approve: () => void
  approveAll: () => void
  deny: () => void
  resetAutoApprove: () => void
  clearPending: () => void
}

export const usePermissionStore = create<PermissionState & PermissionActions>()((set, get) => ({
  autoApproveAll: false,
  pendingPermission: null,

  requestPermission: (toolName, args) => {
    if (SAFE_TOOLS.has(toolName)) return Promise.resolve(true)
    if (HAS_OWN_APPROVAL.has(toolName)) return Promise.resolve(true)
    if (get().autoApproveAll) return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      set({
        pendingPermission: {
          id: crypto.randomUUID(),
          toolName,
          args,
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
      set({ pendingPermission: null, autoApproveAll: true })
    }
  },

  deny: () => {
    const { pendingPermission } = get()
    if (pendingPermission) {
      pendingPermission.resolve(false)
      set({ pendingPermission: null })
    }
  },

  resetAutoApprove: () => {
    set({ autoApproveAll: false })
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
