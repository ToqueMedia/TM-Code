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
  /** Tarefa paralela que pediu (badge "Credenciais" nas task rows). */
  origin?: { taskId: string; label: string }
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
    origin?: { taskId: string; label: string }
  }) => { id: string; promise: Promise<{ submitted: boolean; keys?: string[] }> }
  submit: (id: string, projectPath: string, values: Record<string, string>) => Promise<void>
  cancel: (id: string) => void
  /** Reject the MAIN run's in-flight requests (task-owned survive). */
  clearAll: () => void
  /** Cancela os pedidos pendentes de UMA tarefa paralela parada. */
  cancelByOrigin: (taskId: string) => void
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

  request: ({ serviceName, fields, origin }) => {
    const id = generateRequestId()
    let resolveFn: (r: { submitted: boolean; keys?: string[] }) => void = () => {}
    const promise = new Promise<{ submitted: boolean; keys?: string[] }>((resolve) => {
      resolveFn = resolve
    })
    const entry: PendingCredentialRequest = {
      id,
      serviceName,
      fields,
      ...(origin ? { origin } : {}),
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
    // Só os pedidos do RUN PRINCIPAL — os de tarefas paralelas (origin)
    // sobrevivem ao stop do main e caem via cancelByOrigin.
    const { pending } = get()
    const keep = new Map<string, PendingCredentialRequest>()
    for (const [id, entry] of pending) {
      if (entry.origin) keep.set(id, entry)
      else entry.resolve({ submitted: false })
    }
    set({ pending: keep })
  },

  cancelByOrigin: (taskId) => {
    const { pending } = get()
    const keep = new Map<string, PendingCredentialRequest>()
    for (const [id, entry] of pending) {
      if (entry.origin?.taskId === taskId) entry.resolve({ submitted: false })
      else keep.set(id, entry)
    }
    set({ pending: keep })
  },
}))
