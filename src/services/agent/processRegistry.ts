/**
 * ProcessRegistry — o registo de processos de background do MOTOR (P3.1,
 * portão duro nº8 do inventário headless; docs/DESIGN-HEADLESS-RUNNER.md).
 *
 * O ciclo de vida de um processo de background (pid, buffer de output,
 * estado, dono) é estado de RUNTIME do agente — vivia "vestido de store"
 * no backgroundCommandStore, e qualquer hospedeiro sem React ficava sem
 * registry nenhum. Este módulo é a fonte de verdade; a store zustand passou
 * a fachada-espelho para a UI (subscreve aqui e delega para aqui — espelho
 * unidireccional registry → store).
 *
 * As guardas do original mudaram-se INTACTAS (auditorias de 2026-07-28):
 *  - estados terminais nunca são reescritos — um cancel do user vence o
 *    cmd-exit que se segue ao kill (o estado final pertence a quem terminou
 *    primeiro);
 *  - o buffer corta pela CABEÇA com teto de 200k (num comando de background
 *    o que interessa preservar é a cauda: erros, exit);
 *  - removeCompleted preserva os 5 terminados mais recentes.
 *
 * Zero dependências — importável de qualquer hospedeiro.
 */

export type BackgroundCommandStatus = 'running' | 'completed' | 'error' | 'cancelled'

export interface BackgroundCommand {
  id: string
  command: string
  /** Which run spawned it: 'main' or the parallel-task runId. Lets the main
   *  run's cancel/restart kill ONLY its own background processes, never
   *  another project's live task's (F2 MDI — see agentService.cancelLoop). */
  owner: string
  status: BackgroundCommandStatus
  pid: number
  exitCode: number | null
  output: string
  startedAt: number
  completedAt: number | null
}

type RegistryListener = (commands: ReadonlyMap<string, BackgroundCommand>) => void

const commands = new Map<string, BackgroundCommand>()
const listeners = new Set<RegistryListener>()

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(commands)
    } catch {
      /* um espelho partido nunca trava o motor */
    }
  }
}

export const processRegistry = {
  /** Subscreve mudanças (a store-fachada da UI usa isto). Devolve unsubscribe. */
  subscribe(listener: RegistryListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  addCommand(cmd: BackgroundCommand): void {
    commands.set(cmd.id, cmd)
    notify()
  },

  appendOutput(id: string, data: string): void {
    const cmd = commands.get(id)
    if (!cmd || cmd.status !== 'running') return
    const MAX_BUFFER = 200_000
    let output = cmd.output + data
    if (output.length > MAX_BUFFER) {
      output = `[...earlier output dropped (buffer cap ${MAX_BUFFER} chars)...]\n` + output.slice(-MAX_BUFFER)
    }
    commands.set(id, { ...cmd, output })
    notify()
  },

  completeCommand(id: string, exitCode: number): void {
    const cmd = commands.get(id)
    // Só transita a partir de 'running': um cancel do user (UI/Stop) mata o
    // processo, e o cmd-exit que se segue NÃO pode reescrever 'cancelled'.
    if (!cmd || cmd.status !== 'running') return
    commands.set(id, { ...cmd, status: 'completed', exitCode, completedAt: Date.now() })
    notify()
  },

  failCommand(id: string, error: string): void {
    const cmd = commands.get(id)
    // Mesma guarda do completeCommand: 'cancelled' é terminal.
    if (!cmd || cmd.status !== 'running') return
    commands.set(id, { ...cmd, status: 'error', output: cmd.output + '\n' + error, completedAt: Date.now() })
    notify()
  },

  cancelCommand(id: string): void {
    const cmd = commands.get(id)
    if (!cmd || cmd.status !== 'running') return
    commands.set(id, { ...cmd, status: 'cancelled', completedAt: Date.now() })
    notify()
  },

  cancelAll(): void {
    commands.forEach((cmd, id) => {
      if (cmd.status === 'running') {
        commands.set(id, { ...cmd, status: 'cancelled', completedAt: Date.now() })
      }
    })
    notify()
  },

  removeCompleted(): void {
    // Collect completed entries (sorted newest first) and keep the last 5.
    const completed: BackgroundCommand[] = []
    commands.forEach(cmd => {
      if (cmd.status !== 'running') completed.push(cmd)
    })
    completed.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    for (let i = 5; i < completed.length; i++) {
      commands.delete(completed[i].id)
    }
    notify()
  },

  getRunningCount(): number {
    let count = 0
    commands.forEach(c => {
      if (c.status === 'running') count++
    })
    return count
  },

  getAll(): BackgroundCommand[] {
    return Array.from(commands.values())
  },

  getById(id: string): BackgroundCommand | undefined {
    return commands.get(id)
  },
}
