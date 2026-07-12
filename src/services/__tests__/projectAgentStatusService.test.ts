/**
 * Writer-side contract of the cross-window agent badge (see
 * projectAgentStatusService.ts). Each scenario re-requires the module —
 * the writer keeps module-level run state (runningPath/heartbeat), so
 * isolation needs a fresh module registry, not just cleared mocks.
 */

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn().mockResolvedValue({}),
}))

jest.mock('@/stores/projectStore', () => {
  const { create } = require('zustand')
  return {
    useProjectStore: create(() => ({
      currentProject: null as { path: string; name: string } | null,
    })),
  }
})

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      getActiveSession: () => ({
        messages: [
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: '  Corrige   o bug do login  ' },
        ],
      }),
    }),
  },
}))

jest.mock('@/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

type AgentStoreModule = typeof import('@/stores/agentStore')
type ProjectStoreModule = typeof import('@/stores/projectStore')
type ServiceModule = typeof import('../projectAgentStatusService')

function setup() {
  jest.resetModules()
  const { invoke } = require('@/utils/invokeMetrics') as { invoke: jest.Mock }
  const { useAgentStore } = require('@/stores/agentStore') as AgentStoreModule
  const { useProjectStore } = require('@/stores/projectStore') as ProjectStoreModule
  const service = require('../projectAgentStatusService') as ServiceModule
  service.initProjectAgentStatusWriter()
  return { invoke, useAgentStore, useProjectStore, service }
}

/** Only the set_project_agent_status payloads, in call order. */
function statusWrites(invoke: jest.Mock): Array<Record<string, unknown>> {
  return invoke.mock.calls
    .filter(call => call[0] === 'set_project_agent_status')
    .map(call => call[1])
}

afterEach(() => {
  jest.useRealTimers()
})

describe('projectAgentStatusService (writer)', () => {
  it('writes running (with task label) when a run starts, once per run', () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })

    useAgentStore.getState().setStatus('awaiting_response')
    // busy → busy transitions must NOT rewrite (heartbeat owns refreshes)
    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('applying')

    const writes = statusWrites(invoke)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      projectPath: '/p/a',
      state: 'running',
      label: 'Corrige o bug do login',
    })
  })

  it('writes done when the run completes', () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })

    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('idle')

    const writes = statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'done',
    })
  })

  it('writes idle (no badge) when the user cancels', () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })

    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('cancelled')

    const writes = statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'idle',
    })
  })

  it('writes error when the run fails', () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })

    useAgentStore.getState().setStatus('reasoning')
    useAgentStore.getState().setStatus('error')

    const writes = statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'error',
    })
  })

  it('heartbeats running so readers can detect a crashed writer', () => {
    jest.useFakeTimers()
    const { invoke, useAgentStore, useProjectStore, service } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })

    useAgentStore.getState().setStatus('generating')
    jest.advanceTimersByTime(service.PROJECT_AGENT_STATUS_HEARTBEAT_MS * 2 + 50)

    const running = statusWrites(invoke).filter(w => w.state === 'running')
    expect(running.length).toBeGreaterThanOrEqual(3) // initial + 2 heartbeats

    // Run ends → heartbeat must stop refreshing `running`.
    useAgentStore.getState().setStatus('idle')
    const countAfterEnd = statusWrites(invoke).length
    jest.advanceTimersByTime(service.PROJECT_AGENT_STATUS_HEARTBEAT_MS * 3)
    const late = statusWrites(invoke).slice(countAfterEnd)
    expect(late.filter(w => w.state === 'running')).toHaveLength(0)
  })

  it('marks the previous project idle on switch', () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })
    useAgentStore.getState().setStatus('generating')

    // projectStore's guard cancels the run, then the switch lands:
    useAgentStore.getState().setStatus('cancelled')
    useProjectStore.setState({ currentProject: { path: '/p/b', name: 'b' } })

    const writes = statusWrites(invoke)
    const forA = writes.filter(w => w.projectPath === '/p/a')
    expect(forA[forA.length - 1]).toMatchObject({ state: 'idle' })
    // And nothing was ever written for the new project as a side effect of
    // the old one's run (clearStaleStatusOnOpen only READS here — the mocked
    // get_project_agent_statuses returns {}).
    expect(writes.filter(w => w.projectPath === '/p/b')).toHaveLength(0)
  })

  it('never writes when no project is open', () => {
    const { invoke, useAgentStore } = setup()
    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('idle')
    expect(statusWrites(invoke)).toHaveLength(0)
  })

  it('badges a budget stop as error with the budget label (any terminal status)', () => {
    const { invoke, useAgentStore, useProjectStore, service } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })

    useAgentStore.getState().setStatus('generating')
    service.markNextStopAsBudgetStop('Consumo esgotado — tarefas interrompidas')
    // O abort do budget-stop pode aterrar como cancelled/idle/error — a
    // marca tem de vencer o mapeamento normal (cancelled→idle).
    useAgentStore.getState().setStatus('cancelled')

    const writes = statusWrites(invoke)
    expect(writes[writes.length - 1]).toEqual({
      projectPath: '/p/a',
      state: 'error',
      label: 'Consumo esgotado — tarefas interrompidas',
    })
  })

  it('a new run clears a stale budget-stop mark', () => {
    const { invoke, useAgentStore, useProjectStore, service } = setup()
    useProjectStore.setState({ currentProject: { path: '/p/a', name: 'a' } })

    service.markNextStopAsBudgetStop('stale')
    useAgentStore.getState().setStatus('generating') // run start consome/limpa a marca
    useAgentStore.getState().setStatus('cancelled')

    const writes = statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'idle',
    })
  })
})
