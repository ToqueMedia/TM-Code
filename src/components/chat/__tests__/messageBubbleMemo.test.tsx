/**
 * Freeze fix (2026-07-18): react-syntax-highlighter (Prism) re-tokenizes on
 * every render, and MessageBubble re-renders ~20×/s during streaming (each
 * reasoning/text delta bumps streamingVersion). This test proves the memo
 * layer holds: a parent re-render that does NOT change a block's text must
 * NOT re-run the highlighter (that was the main-thread saturation that froze
 * the UI mid-reasoning). Changing the text DOES re-highlight.
 *
 * Uses the createRoot + act harness (this repo has no @testing-library/dom).
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'

// Count how many times the Prism highlighter actually renders (re-tokenizes).
let highlightRenders = 0
jest.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children?: React.ReactNode }) => {
    highlightRenders++
    return <pre data-testid="hl">{children}</pre>
  },
}))
jest.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ vscDarkPlus: {} }))

// react-markdown v10 is ESM-only (ts-jest can't transform it, and no other
// test mounts it). Stub it to route a fenced ```lang block straight through the
// REAL `components.code` renderer — that's what exercises HighlightedCode's
// memo. Non-code text renders verbatim. remark-gfm is a no-op plugin here.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children, components }: { children: string; components: Record<string, React.ComponentType<Record<string, unknown>>> }) => {
    const m = /```(\w+)\n([\s\S]*?)```/.exec(children || '')
    if (m && components?.code) {
      const Code = components.code
      return <Code className={`language-${m[1]}`}>{m[2]}</Code>
    }
    return <div>{children}</div>
  },
}))
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }))

import { MemoMarkdown } from '../ChatMarkdown'

// jsdom lacks structuredClone (Chakra clones its theme on mount).
globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

const CODE_A = 'Intro paragraph.\n\n```ts\nconst x = 1\n```\n'
const CODE_B = 'Intro paragraph.\n\n```ts\nconst x = 2\n```\n'

let forceReRender: () => void = () => {}
function Harness({ text }: { text: string }) {
  const [tick, setTick] = useState(0)
  forceReRender = () => setTick(n => n + 1)
  return (
    <div>
      <span data-testid="tick">{tick}</span>
      <MemoMarkdown text={text} />
    </div>
  )
}

describe('MessageBubble — memo layer prevents streaming re-highlight (freeze fix)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    highlightRenders = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('does NOT re-highlight a stable code block when the parent re-renders', () => {
    act(() => root.render(<ChakraProvider value={theme}><Harness text={CODE_A} /></ChakraProvider>))
    expect(highlightRenders).toBe(1)

    // Simulate a streaming frame that does not touch this block's text
    // (e.g. a reasoning delta bumping streamingVersion). Before the fix this
    // re-tokenized the whole code block; now memo bails out.
    act(() => forceReRender())
    act(() => forceReRender())
    act(() => forceReRender())

    expect(container.querySelector('[data-testid="tick"]')?.textContent).toBe('3')
    expect(highlightRenders).toBe(1) // still 1 — the highlighter never re-ran
  })

  it('DOES re-highlight when the block text actually changes', () => {
    act(() => root.render(<ChakraProvider value={theme}><Harness text={CODE_A} /></ChakraProvider>))
    expect(highlightRenders).toBe(1)

    act(() => root.render(<ChakraProvider value={theme}><Harness text={CODE_B} /></ChakraProvider>))
    expect(highlightRenders).toBe(2) // text changed → re-tokenized once more
  })
})

// ═══════════ Ronda 2: streaming incremental (bloco ATIVO) ═══════════
import { StreamingMarkdown, splitMarkdownForStreaming } from '../ChatMarkdown'

describe('splitMarkdownForStreaming — fronteiras estáveis', () => {
  it('divide parágrafos completos e deixa o em-curso na cauda', () => {
    const r = splitMarkdownForStreaming('um.\n\ndois.\n\ntrês em curso')
    expect(r.stable).toEqual(['um.', 'dois.'])
    expect(r.tail).toBe('três em curso')
  })

  it('não fecha o parágrafo no \\n terminal (o modelo pode continuá-lo)', () => {
    const r = splitMarkdownForStreaming('abc\n')
    expect(r.stable).toEqual([])
    expect(r.tail).toBe('abc')
  })

  it('linha vazia DENTRO de um fence não é fronteira', () => {
    const text = '```ts\nconst a = 1\n\nconst b = 2\n```\n\ndepois'
    const r = splitMarkdownForStreaming(text)
    expect(r.stable).toEqual(['```ts\nconst a = 1\n\nconst b = 2\n```'])
    expect(r.tail).toBe('depois')
  })

  it('fence ABERTO pertence todo à cauda', () => {
    const r = splitMarkdownForStreaming('intro.\n\n```ts\nlinha1\n\nlinha2')
    expect(r.stable).toEqual(['intro.'])
    expect(r.tail).toBe('```ts\nlinha1\n\nlinha2')
  })

  it('lista contígua fica num só segmento', () => {
    const r = splitMarkdownForStreaming('- a\n- b\n- c\n\nfim')
    expect(r.stable).toEqual(['- a\n- b\n- c'])
    expect(r.tail).toBe('fim')
  })

  it('prefix-stability: mais texto nunca reescreve segmentos anteriores', () => {
    const t1 = 'um.\n\ndois ainda'
    const t2 = t1 + ' mais.\n\ntrês.'
    const r1 = splitMarkdownForStreaming(t1)
    const r2 = splitMarkdownForStreaming(t2)
    expect(r2.stable.slice(0, r1.stable.length)).toEqual(r1.stable)
  })
})

describe('StreamingMarkdown — fence em crescimento não tokeniza', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    highlightRenders = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const OPEN = 'intro.\n\n```ts\nconst x = 1\n```'
  const DONE = OPEN + '\n\nfim.'

  it('cauda com fence → plain (0 tokenizações); ao estabilizar → 1; re-renders mantêm 1', () => {
    act(() => root.render(<ChakraProvider value={theme}><StreamingMarkdown text={OPEN} /></ChakraProvider>))
    expect(highlightRenders).toBe(0)

    act(() => root.render(<ChakraProvider value={theme}><StreamingMarkdown text={DONE} /></ChakraProvider>))
    expect(highlightRenders).toBe(1)

    act(() => root.render(<ChakraProvider value={theme}><StreamingMarkdown text={DONE} /></ChakraProvider>))
    act(() => root.render(<ChakraProvider value={theme}><StreamingMarkdown text={DONE + ' cauda nova'} /></ChakraProvider>))
    expect(highlightRenders).toBe(1)
  })
})
