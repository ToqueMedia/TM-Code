import { create } from 'zustand'
import { invoke } from '@/utils/invokeMetrics'

export interface CredentialField {
  id: string
  label: string
  type: 'text' | 'password'
  required: boolean
  helperText?: string
}

interface PendingCredentialRequest {
  id: string
  serviceName: string
  fields: CredentialField[]
  resolve: (result: { submitted: boolean; keys?: string[] }) => void
}

interface CredentialRequestState {
  pending: Map<string, PendingCredentialRequest>
}

interface CredentialRequestActions {
  /**
   * Open a secure credential form in the chat. Returns the synchronously-generated
   * request id and a promise that resolves when the user submits or cancels.
   *
   * On submit: writes the values into `<projectPath>/.env` via the
   * `write_env_vars` Tauri command (single legitimate write path) and
   * resolves with `{ submitted: true, keys: [...] }`. Values never enter
   * the chat history — only the key names.
   *
   * On cancel: resolves with `{ submitted: false }`.
   */
  request: (input: {
    serviceName: string
    fields: CredentialField[]
  }) => { id: string; promise: Promise<{ submitted: boolean; keys?: string[] }> }
  submit: (id: string, projectPath: string, values: Record<string, string>) => Promise<void>
  cancel: (id: string) => void
  /** Reject any in-flight requests — called when the agent loop is cancelled. */
  clearAll: () => void
}

let counter = 0
function generateRequestId(): string {
  counter++
  return `cred-${Date.now()}-${counter}`
}

export const useCredentialRequestStore = create<
  CredentialRequestState & CredentialRequestActions
>((set, get) => ({
  pending: new Map(),

  request: ({ serviceName, fields }) => {
    const id = generateRequestId()
    let resolveFn: (r: { submitted: boolean; keys?: string[] }) => void = () => {}
    const promise = new Promise<{ submitted: boolean; keys?: string[] }>((resolve) => {
      resolveFn = resolve
    })
    const entry: PendingCredentialRequest = {
      id,
      serviceName,
      fields,
      resolve: resolveFn,
    }
    set((state) => {
      const next = new Map(state.pending)
      next.set(id, entry)
      return { pending: next }
    })
    return { id, promise }
  },

  submit: async (id, projectPath, values) => {
    const entry = get().pending.get(id)
    if (!entry) return

    const vars = entry.fields
      .filter((f) => values[f.id] !== undefined && values[f.id] !== '')
      .map((f) => ({ key: f.id, value: values[f.id] }))

    if (vars.length > 0) {
      await invoke('write_env_vars', { projectPath, vars })
    }

    set((state) => {
      const next = new Map(state.pending)
      next.delete(id)
      return { pending: next }
    })
    entry.resolve({ submitted: true, keys: vars.map((v) => v.key) })
  },

  cancel: (id) => {
    const entry = get().pending.get(id)
    if (!entry) return
    set((state) => {
      const next = new Map(state.pending)
      next.delete(id)
      return { pending: next }
    })
    entry.resolve({ submitted: false })
  },

  clearAll: () => {
    const { pending } = get()
    for (const entry of pending.values()) {
      entry.resolve({ submitted: false })
    }
    set({ pending: new Map() })
  },
}))
