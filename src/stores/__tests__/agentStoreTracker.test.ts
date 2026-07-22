import { useAgentStore, type AgentTask } from '../agentStore'

const task = (id: string, status: AgentTask['status'] = 'pending'): AgentTask => ({
  id,
  description: `task ${id}`,
  status,
})

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('agentStore — tracker por-sessão (sem-deus)', () => {
  it('mantém trackers independentes por sessão (uma tarefa não pisa a outra)', () => {
    const s = useAgentStore.getState()
    s.setTasksForSession('sess-A', [task('a1')])
    s.setTasksForSession('sess-B', [task('b1'), task('b2')])

    expect(useAgentStore.getState().getTasksForSession('sess-A').map(t => t.id)).toEqual(['a1'])
    expect(useAgentStore.getState().getTasksForSession('sess-B').map(t => t.id)).toEqual(['b1', 'b2'])
  })

  it('o espelho `tasks` segue a sessão focada', () => {
    const s = useAgentStore.getState()
    s.setTasksForSession('sess-A', [task('a1')])
    s.setTasksForSession('sess-B', [task('b1')])

    s.focusTrackerSession('sess-A')
    expect(useAgentStore.getState().tasks.map(t => t.id)).toEqual(['a1'])

    s.focusTrackerSession('sess-B')
    expect(useAgentStore.getState().tasks.map(t => t.id)).toEqual(['b1'])
  })

  it('escrever numa sessão NÃO focada não mexe no espelho (painel do user fica quieto)', () => {
    const s = useAgentStore.getState()
    s.focusTrackerSession('sess-A')
    s.setTasksForSession('sess-A', [task('a1')])
    expect(useAgentStore.getState().tasks.map(t => t.id)).toEqual(['a1'])

    // Uma tarefa de fundo escreve no SEU balde — o espelho da sessão A não muda.
    s.setTasksForSession('sess-B', [task('b1'), task('b2')])
    expect(useAgentStore.getState().tasks.map(t => t.id)).toEqual(['a1'])
    // ...mas o balde de B ficou registado à mesma.
    expect(useAgentStore.getState().getTasksForSession('sess-B')).toHaveLength(2)
  })

  it('escrever na sessão focada atualiza o espelho', () => {
    const s = useAgentStore.getState()
    s.focusTrackerSession('sess-A')
    s.setTasksForSession('sess-A', [task('a1', 'in_progress')])
    expect(useAgentStore.getState().tasks[0]?.status).toBe('in_progress')

    s.setTasksForSession('sess-A', [task('a1', 'completed')])
    expect(useAgentStore.getState().tasks[0]?.status).toBe('completed')
  })

  it('clearTasksForSession remove só o balde daquela sessão', () => {
    const s = useAgentStore.getState()
    s.setTasksForSession('sess-A', [task('a1')])
    s.setTasksForSession('sess-B', [task('b1')])
    s.focusTrackerSession('sess-A')

    s.clearTasksForSession('sess-A')
    expect(useAgentStore.getState().getTasksForSession('sess-A')).toEqual([])
    expect(useAgentStore.getState().tasks).toEqual([]) // espelho da focada limpou
    expect(useAgentStore.getState().getTasksForSession('sess-B')).toHaveLength(1) // B intacto
  })

  it('setTasks/clearTasks (atalhos) operam na sessão focada', () => {
    const s = useAgentStore.getState()
    s.focusTrackerSession('sess-A')
    s.setTasks([task('a1'), task('a2')])
    expect(useAgentStore.getState().getTasksForSession('sess-A')).toHaveLength(2)
    expect(useAgentStore.getState().tasks).toHaveLength(2)

    s.clearTasks()
    expect(useAgentStore.getState().getTasksForSession('sess-A')).toEqual([])
  })

  it('focar uma sessão sem tracker mostra lista vazia (não vaza a anterior)', () => {
    const s = useAgentStore.getState()
    s.setTasksForSession('sess-A', [task('a1')])
    s.focusTrackerSession('sess-A')
    expect(useAgentStore.getState().tasks).toHaveLength(1)

    s.focusTrackerSession('sess-nova')
    expect(useAgentStore.getState().tasks).toEqual([])
  })
})
