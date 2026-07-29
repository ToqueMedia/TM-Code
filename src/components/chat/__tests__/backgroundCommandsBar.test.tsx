/**
 * Teste de CABLAGEM da BackgroundCommandsBar (createRoot + act, como
 * permissionDialog.test):
 *   - invisível sem comandos running do owner 'main' (poluição zero);
 *   - comandos de tarefas paralelas (owner = taskId) nunca aparecem aqui;
 *   - o botão Cancelar chama cancelBackgroundCommand com o id certo.
 * O comportamento do cancel em si (kill + estado terminal) tem testes próprios
 * no store; aqui prova-se que a UI o LIGA.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'

// jsdom não tem structuredClone (Chakra clona o theme ao montar).
globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

jest.mock('@/services/agent/backgroundCommands/cancelBackgroundCommand', () => ({
  cancelBackgroundCommand: jest.fn().mockResolvedValue(undefined),
}))

import BackgroundCommandsBar from '../BackgroundCommandsBar'
import { useBackgroundCommandStore, type BackgroundCommand } from '@/stores/backgroundCommandStore'
import { cancelBackgroundCommand } from '@/services/agent/backgroundCommands/cancelBackgroundCommand'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

function makeCommand(overrides: Partial<BackgroundCommand> = {}): BackgroundCommand {
  return {
    id: 'cmd-a',
    command: 'yarn build',
    owner: 'main',
    status: 'running',
    pid: 4242,
    exitCode: null,
    output: '',
    startedAt: Date.now() - 5000,
    completedAt: null,
    ...overrides,
  }
}

function seedStore(...cmds: BackgroundCommand[]) {
  useBackgroundCommandStore.setState({ commands: new Map(cmds.map(c => [c.id, c])) })
}

describe('BackgroundCommandsBar — cablagem', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    jest.clearAllMocks()
    seedStore()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render() {
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <BackgroundCommandsBar />
        </ChakraProvider>,
      )
    })
  }

  it('não renderiza nada sem comandos running do main', () => {
    seedStore(
      makeCommand({ id: 'done', status: 'completed', completedAt: Date.now() }),
      makeCommand({ id: 'task-owned', owner: 'ptask-1' }),
    )
    render()
    expect(container.textContent).toBe('')
  })

  it('mostra o comando running do main e Cancelar chama o serviço com o id', () => {
    seedStore(makeCommand({ id: 'cmd-a', command: 'yarn tauri build' }))
    render()
    expect(container.textContent).toContain('yarn tauri build')

    const cancelBtn = container.querySelector('button')
    expect(cancelBtn).not.toBeNull()
    act(() => {
      cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(cancelBackgroundCommand).toHaveBeenCalledTimes(1)
    expect(cancelBackgroundCommand).toHaveBeenCalledWith('cmd-a')
  })

  it('com vários: header com contagem e Cancelar todos cancela cada um', () => {
    seedStore(
      makeCommand({ id: 'cmd-a', command: 'yarn build', startedAt: Date.now() - 9000 }),
      makeCommand({ id: 'cmd-b', command: 'cargo check', pid: 4243, startedAt: Date.now() - 3000 }),
    )
    render()
    expect(container.textContent).toContain('yarn build')
    expect(container.textContent).toContain('cargo check')
    expect(container.textContent).toContain('2')

    // Primeiro botão é o "Cancelar todos" do header.
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(3)
    act(() => {
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(cancelBackgroundCommand).toHaveBeenCalledTimes(2)
    expect(cancelBackgroundCommand).toHaveBeenCalledWith('cmd-a')
    expect(cancelBackgroundCommand).toHaveBeenCalledWith('cmd-b')
  })

  it('reage ao store: comando que termina sai da strip', () => {
    seedStore(makeCommand({ id: 'cmd-a' }))
    render()
    expect(container.textContent).toContain('yarn build')
    act(() => {
      useBackgroundCommandStore.getState().completeCommand('cmd-a', 0)
    })
    expect(container.textContent).toBe('')
  })
})
