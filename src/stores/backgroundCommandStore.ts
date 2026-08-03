import { create } from 'zustand'
import {
  processRegistry,
  type BackgroundCommand,
  type BackgroundCommandStatus,
} from '@/services/agent/processRegistry'

export type { BackgroundCommand, BackgroundCommandStatus }

/**
 * Fachada-espelho da UI (P3.1, 2026-08-03): a fonte de verdade mudou-se para
 * o `processRegistry` do motor — o ciclo de vida de processos de background
 * é estado de runtime do agente, não de UI (portão duro nº8 do inventário
 * headless). Esta store existe para a REACTIVIDADE dos componentes
 * (BackgroundCommandsBar/AgentStatusBar subscrevem-na) e delega TODA a
 * mutação no registry; o espelho é unidireccional (registry → store), pelo
 * que o estado local nunca é mutado directamente aqui.
 */
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

export const useBackgroundCommandStore = create<BackgroundCommandState & BackgroundCommandActions>()((set) => {
  // Espelho: cada mudança no registry re-materializa o Map (referência nova
  // para os selectors de zustand dispararem, como o set() antigo fazia).
  processRegistry.subscribe((cmds) => {
    set({ commands: new Map(cmds) })
  })

  return {
    commands: new Map(processRegistry.getAll().map(c => [c.id, c])),

    addCommand: (cmd) => processRegistry.addCommand(cmd),
    appendOutput: (id, data) => processRegistry.appendOutput(id, data),
    completeCommand: (id, exitCode) => processRegistry.completeCommand(id, exitCode),
    failCommand: (id, error) => processRegistry.failCommand(id, error),
    cancelCommand: (id) => processRegistry.cancelCommand(id),
    cancelAll: () => processRegistry.cancelAll(),
    removeCompleted: () => processRegistry.removeCompleted(),
    getRunningCount: () => processRegistry.getRunningCount(),
    getAll: () => processRegistry.getAll(),
    getById: (id) => processRegistry.getById(id),
  }
})
