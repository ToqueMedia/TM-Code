import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'
import { ExpandReveal } from '../ExpandReveal'

globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

describe('ExpandReveal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('não monta o conteúdo enquanto está fechado', () => {
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <ExpandReveal open={false}><span>dentro</span></ExpandReveal>
        </ChakraProvider>,
      )
    })
    expect(container.textContent).not.toContain('dentro')
  })

  it('mostra o conteúdo quando abre', () => {
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <ExpandReveal open><span>dentro</span></ExpandReveal>
        </ChakraProvider>,
      )
    })
    expect(container.textContent).toContain('dentro')
  })
})
