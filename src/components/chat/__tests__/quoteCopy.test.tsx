/**
 * Blockquote do chat: copiar o prompt sem a barra vermelha.
 */
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }))
jest.mock('react-syntax-highlighter', () => ({
  Prism: () => null,
}))
jest.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  vscDarkPlus: {},
}))

import { markdownComponents, plainTextFromNode } from '../ChatMarkdown'

globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

describe('plainTextFromNode — clipboard do blockquote', () => {
  it('junta parágrafos sem artefactos de DOM', () => {
    const tree = (
      <>
        <p>Um vídeo vertical de 15 segundos.</p>
        <p>Narração feminina, calma.</p>
      </>
    )
    expect(plainTextFromNode(tree)).toBe(
      'Um vídeo vertical de 15 segundos.\nNarração feminina, calma.\n',
    )
  })

  it('não inclui nós vazios nem booleanos', () => {
    expect(plainTextFromNode([null, false, 'Calma', true, undefined])).toBe('Calma')
  })
})

describe('QuoteBlock copy', () => {
  let container: HTMLDivElement
  let root: Root
  const writeText = jest.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    writeText.mockClear()
    Object.assign(navigator, { clipboard: { writeText } })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('o botão copia só o texto do quote', () => {
    const Blockquote = markdownComponents!.blockquote as React.FC<{ children?: React.ReactNode }>
    act(() => {
      root.render(
        <ChakraProvider value={theme}>
          <Blockquote>
            <p>Um vídeo vertical de 15 segundos para lançar Calma.</p>
          </Blockquote>
        </ChakraProvider>,
      )
    })
    const btn = container.querySelector('button')
    expect(btn).toBeTruthy()
    act(() => { btn!.click() })
    expect(writeText).toHaveBeenCalledWith(
      'Um vídeo vertical de 15 segundos para lançar Calma.',
    )
  })
})
