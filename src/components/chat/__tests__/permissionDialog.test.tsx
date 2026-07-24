/**
 * Teste de CABLAGEM do PermissionDialog (createRoot + act, como messageBubbleMemo):
 *   - razão do classificador do Modo Auto renderiza no diálogo (ponto D — antes
 *     só ia para o log do chat);
 *   - o campo de PREFIXO editável leva o prefixo extraído ao grant "sempre neste
 *     projeto" (plumbing prefixDraft → approveAlwaysInProject).
 * A extração pura (getCommandPrefix) e o grant no store têm testes próprios;
 * aqui prova-se que a UI os LIGA.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'

// jsdom não tem structuredClone (Chakra clona o theme ao montar).
globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

import PermissionDialog from '../PermissionDialog'
import { usePermissionStore } from '../../../stores/permissionStore'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

function noop() { /* */ }

describe('PermissionDialog — cablagem', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePermissionStore.setState({ autoModePermissions: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function press(key: string) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  it('mostra a razão do classificador quando o diálogo vem por escalada do Modo Auto (ponto D)', () => {
    const reason = 'writes to a shared production secret store'
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <PermissionDialog
            toolName="execute_command"
            args={{ command: 'gcloud secrets versions add PROD_KEY' }}
            promptReason={null}
            classifierReason={reason}
            approve={noop}
            approveAlwaysInProject={noop}
            approveAlwaysGlobal={noop}
            deny={noop}
            denyWith={noop}
          />
        </ChakraProvider>,
      )
    })
    expect(container.textContent).toContain(reason)
  })

  it('NÃO mostra secção de classificador quando classifierReason é ausente (prompt normal)', () => {
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <PermissionDialog
            toolName="execute_command"
            args={{ command: 'ls -la' }}
            promptReason={null}
            approve={noop}
            approveAlwaysInProject={noop}
            approveAlwaysGlobal={noop}
            deny={noop}
            denyWith={noop}
          />
        </ChakraProvider>,
      )
    })
    // A label do bloco de classificador não aparece.
    expect(container.textContent).not.toContain('flagged this')
  })

  it('o grant "sempre neste projeto" leva o PREFIXO extraído do comando', () => {
    const approveAlwaysInProject = jest.fn()
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <PermissionDialog
            toolName="execute_command"
            args={{ command: 'gcloud secrets versions add PROD_KEY --data-file=-' }}
            promptReason={null}
            approve={noop}
            approveAlwaysInProject={approveAlwaysInProject}
            approveAlwaysGlobal={noop}
            deny={noop}
            denyWith={noop}
          />
        </ChakraProvider>,
      )
    })
    // Seleciona a opção 2 ("sempre neste projeto") via atalho e submete com Enter.
    press('2')
    // O campo de prefixo editável aparece com o prefixo extraído.
    const input = container.querySelector('input') as HTMLInputElement | null
    expect(input?.value).toBe('gcloud secrets versions add')
    press('Enter')
    // O grant recebe o prefixo NARROW, não a tool inteira (doutrina do incidente).
    expect(approveAlwaysInProject).toHaveBeenCalledWith('gcloud secrets versions add')
  })
})
