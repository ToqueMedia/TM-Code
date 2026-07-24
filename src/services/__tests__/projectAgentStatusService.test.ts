/**
 * Writer-side contract of the cross-window agent badge (see
 * projectAgentStatusService.ts). Each scenario re-requires the module —
 * the writer keeps module-level run state (runningPath/heartbeat), so
 * isolation needs a fresh module registry, not just cleared mocks.
 *
 * Writes are SERIALIZED through a promise chain (heartbeat vs transition
 * ordering), so assertions flush microtasks first — statusWrites() is async.
 */

// Sem imports top-level (tudo via require nos setups), o ficheiro seria um
// SCRIPT de escopo global para o tsc e o `setup()` daqui colidia com o de
// outros testes no yarn build. `export {}` torna-o módulo.
export {}

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

// Sessão ativa mutável por teste (prefixo "mock" — permitido em factories).
// Default sem `name`: exercita o fallback de percorrer as mensagens.
let mockActiveSession: Record<string, unknown> = {}
const defaultMockSession = () => ({
  messages: [
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '  Corrige   o bug do login  ' },
  ],
})
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      getActiveSession: () => mockActiveSession,
    }),
  },
}))

jest.mock('@/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

type AgentStoreModule = typeof import('@/stores/agentStore')
type ProjectStoreModule = typeof import('@/stores/projectStore')
type ServiceModule = typeof import('../projectAgentStatusService')
type ProjectInfo = import('@/types/project').ProjectInfo

/** The service only reads `.path` — a minimal stub is all these tests need. */
const mkProject = (path: string, name: string): ProjectInfo =>
  ({ path, name } as unknown as ProjectInfo)

function setup() {
  jest.resetModules()
  mockActiveSession = defaultMockSession()
  const { invoke } = require('@/utils/invokeMetrics') as { invoke: jest.Mock }
  const { useAgentStore } = require('@/stores/agentStore') as AgentStoreModule
  const { useProjectStore } = require('@/stores/projectStore') as ProjectStoreModule
  const service = require('../projectAgentStatusService') as ServiceModule
  service.initProjectAgentStatusWriter()
  return { invoke, useAgentStore, useProjectStore, service }
}

/** Drain the write chain's microtasks (works under fake timers too).
 *  Focused heartbeat is 3s → a 60s advance can enqueue 20+ serial writes;
 *  keep flushing until the chain settles (cap avoids infinite loops). */
async function flushWrites(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve()
}

/** Only the set_project_agent_status payloads, in call order. */
async function statusWrites(invoke: jest.Mock): Promise<Array<Record<string, unknown>>> {
  await flushWrites()
  return invoke.mock.calls
    .filter(call => call[0] === 'set_project_agent_status')
    .map(call => call[1])
}

afterEach(() => {
  jest.useRealTimers()
})

describe('projectAgentStatusService (writer)', () => {
  it('writes running (with task label) when a run starts, once per run', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })

    useAgentStore.getState().setStatus('awaiting_response')
    // busy → busy transitions must NOT rewrite (heartbeat owns refreshes)
    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('applying')

    const writes = await statusWrites(invoke)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      projectPath: '/p/a',
      state: 'running',
      label: 'Corrige o bug do login',
      onlyIfOwn: false,
    })
    // startedAt is set once at run start and preserved by heartbeats.
    expect(typeof writes[0].startedAt).toBe('number')
    expect(writes[0].startedAt as number).toBeGreaterThan(0)
  })

  it('writes done when the run completes', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })

    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('idle')

    const writes = await statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'done',
    })
  })

  it('writes idle (no badge) when the user cancels', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })

    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('cancelled')

    const writes = await statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'idle',
      // Clears are ownership-guarded: never stamp over another window's badge.
      onlyIfOwn: true,
    })
  })

  it('writes error when the run fails', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })

    useAgentStore.getState().setStatus('reasoning')
    useAgentStore.getState().setStatus('error')

    const writes = await statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'error',
    })
  })

  it('heartbeats running so readers can detect a crashed writer', async () => {
    jest.useFakeTimers()
    const { invoke, useAgentStore, useProjectStore, service } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })
    // jsdom is "visible" → focused heartbeat (3s). Use that interval for advances.
    const beat = service.PROJECT_AGENT_STATUS_HEARTBEAT_FOCUSED_MS

    useAgentStore.getState().setStatus('generating')
    jest.advanceTimersByTime(beat * 2 + 50)

    const running = (await statusWrites(invoke)).filter(w => w.state === 'running')
    expect(running.length).toBeGreaterThanOrEqual(3) // initial + 2 heartbeats
    // Every heartbeat reuses the same startedAt from the first write.
    const startedAts = running.map(w => w.startedAt)
    expect(startedAts.every(ts => ts === startedAts[0])).toBe(true)

    // Run ends → heartbeat must stop refreshing `running`.
    useAgentStore.getState().setStatus('idle')
    const countAfterEnd = (await statusWrites(invoke)).length
    jest.advanceTimersByTime(beat * 5)
    const late = (await statusWrites(invoke)).slice(countAfterEnd)
    expect(late.filter(w => w.state === 'running')).toHaveLength(0)
  })

  it('marks the previous project idle on switch (ownership-guarded)', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })
    useAgentStore.getState().setStatus('generating')

    // projectStore's guard cancels the run, then the switch lands:
    useAgentStore.getState().setStatus('cancelled')
    useProjectStore.setState({ currentProject: mkProject('/p/b', 'b') })

    const writes = await statusWrites(invoke)
    const forA = writes.filter(w => w.projectPath === '/p/a')
    expect(forA[forA.length - 1]).toMatchObject({ state: 'idle', onlyIfOwn: true })
    // And nothing was ever written for the new project as a side effect of
    // the old one's run (clearStaleStatusOnOpen only READS here — the mocked
    // get_project_agent_statuses returns {}).
    expect(writes.filter(w => w.projectPath === '/p/b')).toHaveLength(0)
  })

  it('never writes when no project is open', async () => {
    const { invoke, useAgentStore } = setup()
    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('idle')
    expect(await statusWrites(invoke)).toHaveLength(0)
  })

  it('badges the streaming session project, not a stale focused project', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    // Focus is project B, but the run's session is bound to A (F2 mid-switch
    // race / stale focus). Badge must follow the session, not the focus.
    mockActiveSession = {
      projectPath: '/p/a',
      name: 'Task on A',
      messages: [{ role: 'user', content: 'work on A' }],
    }
    // chatStore mock only exposes getActiveSession — set focus to B.
    useProjectStore.setState({ currentProject: mkProject('/p/b', 'b') })
    // Without session.projectPath on the mock factory, resolveMainBadgePath
    // falls through: we need the mock to return projectPath on getActiveSession.
    // setup() already returns mockActiveSession from getActiveSession.
    useAgentStore.getState().setStatus('generating')

    const writes = await statusWrites(invoke)
    // Prefer active session projectPath (/p/a) over focused /p/b.
    expect(writes[0]).toMatchObject({
      projectPath: '/p/a',
      state: 'running',
      label: 'Task on A',
    })
    expect(writes.filter(w => w.projectPath === '/p/b')).toHaveLength(0)
  })

  it('badges a budget stop as error with the budget label (any terminal status)', async () => {
    const { invoke, useAgentStore, useProjectStore, service } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })

    useAgentStore.getState().setStatus('generating')
    service.markNextStopAsBudgetStop('Consumo esgotado — tarefas interrompidas')
    // O abort do budget-stop pode aterrar como cancelled/idle/error — a
    // marca tem de vencer o mapeamento normal (cancelled→idle).
    useAgentStore.getState().setStatus('cancelled')

    const writes = await statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'error',
      label: 'Consumo esgotado — tarefas interrompidas',
      onlyIfOwn: false,
      // Terminal writes drop startedAt (elapsed only matters while running).
      startedAt: null,
    })
  })

  // ── Título estável + descrição (pedido 2026-07-14) ──

  it('o título é a PRIMEIRA mensagem do user, não a última (fallback sem name)', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    mockActiveSession = {
      messages: [
        { role: 'user', content: 'Cria a feature de exportação' },
        { role: 'assistant', content: 'ok' },
        // A versão antiga percorria de trás p/ a frente e apanhava isto:
        { role: 'user', content: 'agora muda a cor do botão' },
      ],
    }
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })
    useAgentStore.getState().setStatus('generating')

    const writes = await statusWrites(invoke)
    expect(writes[0]).toMatchObject({ label: 'Cria a feature de exportação' })
  })

  it('session.name (primeira mensagem fixada ou rename manual) vence o fallback', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    mockActiveSession = {
      name: 'Refactor do billing',
      messages: [
        { role: 'user', content: 'mensagem inicial qualquer' },
        { role: 'user', content: 'mensagem posterior' },
      ],
    }
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })
    useAgentStore.getState().setStatus('generating')

    const writes = await statusWrites(invoke)
    expect(writes[0]).toMatchObject({ label: 'Refactor do billing' })
  })

  it('a descrição escrita pelo user viaja no status file (running e terminal)', async () => {
    const { invoke, useAgentStore, useProjectStore } = setup()
    mockActiveSession = {
      name: 'Tarefa X',
      description: 'Contexto: cliente pediu até sexta',
      messages: [{ role: 'user', content: 'faz X' }],
    }
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })
    useAgentStore.getState().setStatus('generating')
    useAgentStore.getState().setStatus('idle')

    const writes = await statusWrites(invoke)
    expect(writes[0]).toMatchObject({
      state: 'running',
      description: 'Contexto: cliente pediu até sexta',
    })
    expect(writes[writes.length - 1]).toMatchObject({
      state: 'done',
      description: 'Contexto: cliente pediu até sexta',
    })
  })

  it('a new run clears a stale budget-stop mark', async () => {
    const { invoke, useAgentStore, useProjectStore, service } = setup()
    useProjectStore.setState({ currentProject: mkProject('/p/a', 'a') })

    service.markNextStopAsBudgetStop('stale')
    useAgentStore.getState().setStatus('generating') // run start consome/limpa a marca
    useAgentStore.getState().setStatus('cancelled')

    const writes = await statusWrites(invoke)
    expect(writes[writes.length - 1]).toMatchObject({
      projectPath: '/p/a',
      state: 'idle',
    })
  })
})
