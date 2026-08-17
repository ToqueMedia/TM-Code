/**
 * Hover do pill de contexto — rótulos concretos, não "85k / 262k · 36%".
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'
import { translations } from '@/i18n/translations'
import { buildContextOccupancyDetails } from '@/utils/contextWindow'
import ContextWindowIndicator, { ContextOccupancyHoverCard } from '../ContextWindowIndicator'

globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

function digits(s: string): string {
  return s.replace(/\D/g, '')
}

describe('ContextOccupancyHoverCard', () => {
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

  it('mostra usado, livre, pedido, reserva e quanto falta até compactar', () => {
    const details = buildContextOccupancyDetails({
      promptTokens: 85_033,
      responseTokens: 1_428,
      peakTokens: 90_967,
      rawWindow: 262_144,
    })
    const t = (key: keyof typeof translations.en) => translations.pt[key]
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <ContextOccupancyHoverCard details={details} lang="pt" t={t} />
        </ChakraProvider>,
      )
    })
    const text = container.textContent ?? ''
    expect(text).toContain('Esta sessão')
    expect(text).toContain('úteis')
    expect(text).toContain('livres')
    expect(text).toContain('Último pedido')
    expect(text).toContain('Última resposta')
    expect(text).toContain('Pico da sessão')
    expect(text).toContain('Janela do modelo')
    expect(text).toContain('Reserva do sumário')
    expect(text).toContain('Compacta a')
    expect(text).toContain('Até compactar')
    expect(text).toContain('Mapa completo: /context')
    const d = digits(text)
    expect(d).toContain('86461')
    expect(d).toContain('242144')
    expect(d).toContain('155683')
    expect(d).toContain('85033')
    expect(d).toContain('1428')
    expect(d).toContain('90967')
    expect(d).toContain('262144')
    expect(d).toContain('20000')
    expect(d).toContain('229144')
    expect(d).toContain('142683')
    expect(text).not.toMatch(/Passou o limiar/)
    expect(text).toContain('Abaixo do limiar — ainda não compacta')
  })

  it('montar o círculo não entra em Maximum update depth', () => {
    // O selector NÃO pode devolver um objeto novo por getSnapshot — o React 18
    // trata isso como update infinito ao abrir um projecto (composer monta).
    expect(() => {
      act(() => {
        root.render(
          <ChakraProvider value={theme}>
            <ContextWindowIndicator />
          </ChakraProvider>,
        )
      })
    }).not.toThrow()
  })

  it('sessão vazia não mostra 0% como se a janela estivesse vazia de conversa', () => {
    const details = buildContextOccupancyDetails({
      promptTokens: 0,
      responseTokens: 0,
      peakTokens: 0,
      rawWindow: 262_144,
    })
    const t = (key: keyof typeof translations.en) => translations.pt[key]
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <ContextOccupancyHoverCard details={details} lang="pt" t={t} />
        </ChakraProvider>,
      )
    })
    const text = container.textContent ?? ''
    expect(text).toContain('Ainda sem pedido nesta sessão')
    expect(text).toContain('Janela do modelo')
    expect(text).toContain('Compacta a')
    expect(text).not.toContain('Último pedido')
    expect(text).not.toContain('0%')
  })
})
