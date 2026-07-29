import { create } from 'zustand'

export type BackgroundCommandStatus = 'running' | 'completed' | 'error' | 'cancelled'

export interface BackgroundCommand {
  id: string
  command: string
  /** Which run spawned it: 'main' or the parallel-task runId. Lets the main
   *  run's cancel/restart kill ONLY its own background processes, never another
   *  project's live task's (F2 MDI — see agentService.cancelLoop). */
  owner: string
  status: BackgroundCommandStatus
  pid: number
  exitCode: number | null
  output: string
  startedAt: number
  completedAt: number | null
}

interface BackgroundCommandState {
  commands: Map<string, BackgroundCommand>
}

interface BackgroundCommandActions {
  addCommand: (cmd: BackgroundCommand) => void
  appendOutput: (id: string, data: string) => void
  completeCommand: (id: string, exitCode: number) => void
  failCommand: (id: string, error: string) => void
  cancelCommand: (id: string) => void
  cancelAll: () => void
  removeCompleted: () => void
  getRunningCount: () => number
  getAll: () => BackgroundCommand[]
  getById: (id: string) => BackgroundCommand | undefined
}

export const useBackgroundCommandStore = create<BackgroundCommandState & BackgroundCommandActions>()((set, get) => ({
  commands: new Map(),

  addCommand: (cmd) => {
    set(state => {
      const next = new Map(state.commands)
      next.set(cmd.id, cmd)
      return { commands: next }
    })
  },

  appendOutput: (id, data) => {
    set(state => {
      const cmd = state.commands.get(id)
      if (!cmd || cmd.status !== 'running') return state
      const next = new Map(state.commands)
      // Cap do buffer (auditoria 2026-07-28): era ilimitado — um build/watch
      // tagarela crescia sem tecto na memória do renderer. Mesmo teto do
      // agent shell (200k), a cortar pela CABEÇA: num comando de background o
      // que interessa preservar é a cauda (erros, exit).
      const MAX_BUFFER = 200_000
      let output = cmd.output + data
      if (output.length > MAX_BUFFER) {
        output = `[...earlier output dropped (buffer cap ${MAX_BUFFER} chars)...]\n` + output.slice(-MAX_BUFFER)
      }
      next.set(id, { ...cmd, output })
      return { commands: next }
    })
  },

  completeCommand: (id, exitCode) => {
    set(state => {
      const cmd = state.commands.get(id)
      // Só transita a partir de 'running': um cancel do user (UI/Stop) mata o
      // processo, e o cmd-exit que se segue NÃO pode reescrever 'cancelled'
      // para completed/error — o estado final pertence a quem terminou primeiro.
      if (!cmd || cmd.status !== 'running') return state
      const next = new Map(state.commands)
      next.set(id, { ...cmd, status: 'completed', exitCode, completedAt: Date.now() })
      return { commands: next }
    })
  },

  failCommand: (id, error) => {
    set(state => {
      const cmd = state.commands.get(id)
      // Mesma guarda do completeCommand: 'cancelled' é terminal.
      if (!cmd || cmd.status !== 'running') return state
      const next = new Map(state.commands)
      next.set(id, { ...cmd, status: 'error', output: cmd.output + '\n' + error, completedAt: Date.now() })
      return { commands: next }
    })
  },

  cancelCommand: (id) => {
    set(state => {
      const cmd = state.commands.get(id)
      if (!cmd || cmd.status !== 'running') return state
      const next = new Map(state.commands)
      next.set(id, { ...cmd, status: 'cancelled', completedAt: Date.now() })
      return { commands: next }
    })
  },

  cancelAll: () => {
    set(state => {
      const next = new Map(state.commands)
      next.forEach((cmd, id) => {
        if (cmd.status === 'running') {
          next.set(id, { ...cmd, status: 'cancelled', completedAt: Date.now() })
        }
      })
      return { commands: next }
    })
  },

  removeCompleted: () => {
    set(state => {
      const next = new Map(state.commands)
      // Collect completed entries (sorted newest first) and keep the last 5
      const completed: BackgroundCommand[] = []
      next.forEach(cmd => { if (cmd.status !== 'running') completed.push(cmd) })
      completed.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      for (let i = 5; i < completed.length; i++) {
        next.delete(completed[i].id)
      }
      return { commands: next }
    })
  },

  getRunningCount: () => {
    let count = 0
    get().commands.forEach(c => { if (c.status === 'running') count++ })
    return count
  },

  getAll: () => Array.from(get().commands.values()),

  getById: (id) => get().commands.get(id),
}))
