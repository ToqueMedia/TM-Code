/**
 * Guardas de transição do backgroundCommandStore.
 *
 * O invariante crítico: 'cancelled' é TERMINAL. Um cancel do user
 * (BackgroundCommandsBar / Stop) mata o processo, e o cmd-exit que chega a
 * seguir (exit code != 0 por causa do kill) chamava failCommand — sem a
 * guarda, o cancel do user era reescrito para 'error' e o auto-wake acordava
 * o agente com uma falha fantasma.
 */

import { useBackgroundCommandStore, type BackgroundCommand } from '../backgroundCommandStore'

function makeCommand(overrides: Partial<BackgroundCommand> = {}): BackgroundCommand {
  return {
    id: 'cmd-test-1',
    command: 'yarn build',
    owner: 'main',
    status: 'running',
    pid: 4242,
    exitCode: null,
    output: '',
    startedAt: Date.now(),
    completedAt: null,
    ...overrides,
  }
}

describe('backgroundCommandStore — guardas de transição', () => {
  beforeEach(() => {
    useBackgroundCommandStore.setState({ commands: new Map() })
  })

  it('completeCommand transita running → completed', () => {
    const store = useBackgroundCommandStore.getState()
    store.addCommand(makeCommand())
    store.completeCommand('cmd-test-1', 0)
    expect(useBackgroundCommandStore.getState().getById('cmd-test-1')?.status).toBe('completed')
  })

  it('failCommand transita running → error', () => {
    const store = useBackgroundCommandStore.getState()
    store.addCommand(makeCommand())
    store.failCommand('cmd-test-1', 'Process exited with code 1')
    expect(useBackgroundCommandStore.getState().getById('cmd-test-1')?.status).toBe('error')
  })

  it('cancelled é terminal: failCommand do exit tardio NÃO reescreve', () => {
    const store = useBackgroundCommandStore.getState()
    store.addCommand(makeCommand())
    store.cancelCommand('cmd-test-1')
    // O kill produz um cmd-exit com código != 0 — chega depois do cancel.
    store.failCommand('cmd-test-1', 'Process exited with code 137')
    const cmd = useBackgroundCommandStore.getState().getById('cmd-test-1')
    expect(cmd?.status).toBe('cancelled')
    // O output também não é contaminado com o "erro" do kill.
    expect(cmd?.output).toBe('')
  })

  it('cancelled é terminal: completeCommand tardio NÃO reescreve', () => {
    const store = useBackgroundCommandStore.getState()
    store.addCommand(makeCommand())
    store.cancelCommand('cmd-test-1')
    store.completeCommand('cmd-test-1', 0)
    expect(useBackgroundCommandStore.getState().getById('cmd-test-1')?.status).toBe('cancelled')
  })

  it('cancelCommand só actua sobre running', () => {
    const store = useBackgroundCommandStore.getState()
    store.addCommand(makeCommand())
    store.completeCommand('cmd-test-1', 0)
    store.cancelCommand('cmd-test-1')
    expect(useBackgroundCommandStore.getState().getById('cmd-test-1')?.status).toBe('completed')
  })
})

export {}
