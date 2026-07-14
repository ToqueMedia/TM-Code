/**
 * Guard de duplo-open (projectWindowLockService): heartbeat de presença por
 * projecto + arbitragem de staleness no leitor. Cada cenário re-require o
 * módulo (estado module-level: heldPath/heartbeat).
 */

// Sem imports top-level (tudo via require nos setups), o ficheiro seria um
// SCRIPT de escopo global para o tsc. `export {}` torna-o módulo.
export {}

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/stores/projectStore', () => {
  const { create } = require('zustand')
  return {
    useProjectStore: create(() => ({
      currentProject: null as { path: string; name: string } | null,
    })),
  }
})

jest.mock('@/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

type ProjectStoreModule = typeof import('@/stores/projectStore')
type ServiceModule = typeof import('../projectWindowLockService')
type ProjectInfo = import('@/types/project').ProjectInfo

const mkProject = (path: string): ProjectInfo =>
  ({ path, name: path } as unknown as ProjectInfo)

function setup() {
  jest.resetModules()
  const { invoke } = require('@/utils/invokeMetrics') as { invoke: jest.Mock }
  const { useProjectStore } = require('@/stores/projectStore') as ProjectStoreModule
  const service = require('../projectWindowLockService') as ServiceModule
  service.initProjectWindowLock()
  return { invoke, useProjectStore, service }
}

function callsTo(invoke: jest.Mock, command: string): Array<Record<string, unknown>> {
  return invoke.mock.calls.filter(c => c[0] === command).map(c => c[1])
}

afterEach(() => {
  jest.useRealTimers()
})

describe('projectWindowLockService', () => {
  it('acquires on open and heartbeats while the project stays open', () => {
    jest.useFakeTimers()
    const { invoke, useProjectStore } = setup()

    useProjectStore.setState({ currentProject: mkProject('/p/a') })
    expect(callsTo(invoke, 'acquire_project_window_lock')).toEqual([{ projectPath: '/p/a' }])

    jest.advanceTimersByTime(30_000 * 2 + 50)
    expect(callsTo(invoke, 'acquire_project_window_lock').length).toBeGreaterThanOrEqual(3)
  })

  it('releases the previous lock and acquires the new one on switch', () => {
    const { invoke, useProjectStore } = setup()

    useProjectStore.setState({ currentProject: mkProject('/p/a') })
    useProjectStore.setState({ currentProject: mkProject('/p/b') })

    expect(callsTo(invoke, 'release_project_window_lock')).toEqual([{ projectPath: '/p/a' }])
    expect(callsTo(invoke, 'acquire_project_window_lock').map(a => a.projectPath)).toEqual([
      '/p/a',
      '/p/b',
    ])
  })

  it('releases and stops heartbeating on close', () => {
    jest.useFakeTimers()
    const { invoke, useProjectStore } = setup()

    useProjectStore.setState({ currentProject: mkProject('/p/a') })
    useProjectStore.setState({ currentProject: null })

    expect(callsTo(invoke, 'release_project_window_lock')).toEqual([{ projectPath: '/p/a' }])
    const acquiresAfterClose = callsTo(invoke, 'acquire_project_window_lock').length
    jest.advanceTimersByTime(30_000 * 3)
    expect(callsTo(invoke, 'acquire_project_window_lock')).toHaveLength(acquiresAfterClose)
  })

  it('isProjectOpenElsewhere: fresh foreign lock → true, stale → false, none → false', async () => {
    const { invoke, service } = setup()

    invoke.mockResolvedValueOnce({ pid: 999, updatedAt: Date.now() - 10_000 })
    await expect(service.isProjectOpenElsewhere('/p/x')).resolves.toBe(true)

    // Dono morto (sem heartbeat dentro da janela de staleness) — não avisa.
    invoke.mockResolvedValueOnce({
      pid: 999,
      updatedAt: Date.now() - service.PROJECT_WINDOW_LOCK_STALE_MS - 1_000,
    })
    await expect(service.isProjectOpenElsewhere('/p/x')).resolves.toBe(false)

    // O comando Rust devolve null para lock próprio/ausente.
    invoke.mockResolvedValueOnce(null)
    await expect(service.isProjectOpenElsewhere('/p/x')).resolves.toBe(false)
  })
})
