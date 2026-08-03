/**
 * `isAgentBusyNow()` é a leitura IMPERATIVA usada pelos handlers fora do
 * React (atalho Cmd+Shift+E) para bloquear as MESMAS ações que o composer
 * mostra desativadas (effort + "Código-fonte"). O que interessa testar é a
 * composição: QueryGuard OU project-run vivo — se divergir do que o
 * `PromptActions` recebe (`isAgentBusy || anyLiveTask`), fica um botão
 * cinzento com um atalho que continua a funcionar.
 */
import { isAgentBusyNow } from '../agentBusy'
import { getQueryGuard, __resetQueryGuard } from '../../services/agent/queryGuard'
import { useParallelTaskStore } from '../../stores/parallelTaskStore'

function setRuns(statuses: Array<'running' | 'queued' | 'done' | 'error'>) {
  const runs = new Map()
  statuses.forEach((status, i) => {
    runs.set(`run-${i}`, { id: `run-${i}`, status })
  })
  useParallelTaskStore.setState({ runs } as never)
}

describe('isAgentBusyNow', () => {
  beforeEach(() => {
    __resetQueryGuard()
    setRuns([])
  })

  it('idle sem tarefas → false', () => {
    expect(isAgentBusyNow()).toBe(false)
  })

  it('QueryGuard a despachar já conta como ocupado (não só o streaming)', () => {
    // reserve() = idle → dispatching: a preparação do run (token, system
    // prompt, planner) demora segundos e é exatamente a janela em que o
    // utilizador clicava no editor.
    expect(getQueryGuard().reserve()).toBe(true)
    expect(isAgentBusyNow()).toBe(true)
  })

  it('QueryGuard a correr → true; forceEnd volta a libertar', () => {
    getQueryGuard().tryStart()
    expect(isAgentBusyNow()).toBe(true)
    getQueryGuard().forceEnd()
    expect(isAgentBusyNow()).toBe(false)
  })

  it('project-run running/queued conta mesmo com o guard idle', () => {
    setRuns(['running'])
    expect(isAgentBusyNow()).toBe(true)
    setRuns(['queued'])
    expect(isAgentBusyNow()).toBe(true)
  })

  it('project-runs terminados não contam', () => {
    setRuns(['done', 'error'])
    expect(isAgentBusyNow()).toBe(false)
  })
})
