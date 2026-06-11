/**
 * Repro harness para o React error #185 ("Maximum update depth exceeded")
 * reportado em produção quando mensagens de erro chegam ao chat.
 *
 * Monta o ChatView REAL (stores reais, windowing real, efeitos de scroll
 * reais) e despacha a mesma sequência de estado que o agentRunner.onError +
 * usePromptBar produzem. Se existir um ciclo síncrono de setState, o React
 * lança "Maximum update depth exceeded" dentro do act() e o teste falha —
 * é o detetor; depois de corrigido, fica como teste de regressão.
 *
 * Módulos ESM-only (react-markdown, remark-gfm, react-syntax-highlighter)
 * são mockados porque o ts-jest não transforma node_modules — os mocks
 * preservam a estrutura (children renderizam) sem a implementação.
 */
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '../../../theme'

// ── Mocks de módulos ESM-only (não transformáveis pelo ts-jest) ──
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div data-testid="md">{children}</div>,
}))
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => null }))
jest.mock('react-syntax-highlighter', () => ({
  __esModule: true,
  Prism: ({ children }: { children?: React.ReactNode }) => <pre>{children}</pre>,
}))
jest.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  __esModule: true,
  vscDarkPlus: {},
}))
// ESM-only; em jsdom não há layout (ResizeObserver é stub), portanto um mock
// com identidades estáveis é equivalente ao real para detetar loops de estado.
jest.mock('use-stick-to-bottom', () => {
  const scrollToBottom = () => true
  const stopScroll = () => {}
  const refs = { scrollRef: { current: null }, contentRef: { current: null } }
  return {
    __esModule: true,
    useStickToBottom: () => ({
      ...refs,
      scrollToBottom,
      stopScroll,
      isAtBottom: true,
      isNearBottom: true,
      escapedFromLock: false,
    }),
  }
})

// Persistência de sessões (Tauri fs) — irrelevante para o ciclo de render.
jest.mock('../../../services/agent/sessionService', () => ({
  sessionService: {
    setSessionGetter: jest.fn(),
    setTokenUsageGetter: jest.fn(),
    setTurnSnapshotGetter: jest.fn(),
    markDirty: jest.fn(),
    flushNow: jest.fn().mockResolvedValue(undefined),
    init: jest.fn().mockResolvedValue(undefined),
    startAutoSave: jest.fn(),
    stopAutoSave: jest.fn(),
    saveSession: jest.fn().mockResolvedValue(undefined),
    loadSession: jest.fn().mockResolvedValue(null),
    getActiveSessionId: jest.fn().mockResolvedValue(null),
    setActiveSessionId: jest.fn().mockResolvedValue(undefined),
    listSessions: jest.fn().mockResolvedValue([]),
    createSession: jest.fn(),
    cleanupEmptySessions: jest.fn().mockResolvedValue(undefined),
  },
  captureByokSnapshot: jest.fn(() => null),
}))

// firebaseAuth usa import.meta.env no corpo do módulo — Jest não o parseia.
jest.mock('../../../services/auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getIdToken: jest.fn().mockResolvedValue(null),
      getCurrentUser: () => null,
      onAuthStateChange: () => () => {},
    }),
  },
}))

// windowService puxa @tauri-apps/api/webviewWindow (classes nativas).
jest.mock('../../../services/windowService', () => ({
  __esModule: true,
  windowService: {
    saveWindowState: jest.fn(),
    restoreWindowState: jest.fn().mockResolvedValue(undefined),
  },
}))

// LSP/Monaco — UMD não carrega no Jest; nada disto participa no render do chat.
jest.mock('../../../services/typescriptLspService', () => ({
  __esModule: true,
  typescriptLspService: {
    init: jest.fn(),
    dispose: jest.fn(),
    getDiagnostics: jest.fn().mockResolvedValue([]),
  },
}))

// O SDK da OpenAI exige fetch/ReadableStream que o jsdom não tem.
jest.mock('../../../services/agent/sdkClient', () => ({
  __esModule: true,
  createAgentClient: jest.fn(),
  createSubAgentClient: jest.fn(),
}))

// refractor é ESM-only; o highlight de sintaxe não participa no ciclo.
jest.mock('../../../utils/syntaxHighlight', () => ({
  __esModule: true,
  highlightLines: (code: string) => code.split('\n').map((line: string) => [{ text: line, color: '' }]),
  highlightCode: (code: string) => code,
}))

// fileIcons usa import.meta.glob (Vite) — irrelevante para o ciclo de render.
jest.mock('../../../utils/fileIcons', () => ({
  __esModule: true,
  getFileIconUrl: () => '',
}))

// ── Polyfills jsdom (antes da cadeia de imports do ChatView) ──
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeUtil = require('util') as typeof import('util')
globalThis.TextEncoder = globalThis.TextEncoder || nodeUtil.TextEncoder
globalThis.TextDecoder = globalThis.TextDecoder
  || (nodeUtil.TextDecoder as unknown as typeof globalThis.TextDecoder)
// Habilita o suporte a act() fora do @testing-library — scoped a este ficheiro.
beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true })
afterAll(() => { delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT })
// jsdom do Jest não expõe structuredClone (Chakra clona a config do theme).
globalThis.structuredClone = globalThis.structuredClone
  || (<T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T))

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver = class {
    constructor(_cb: IntersectionObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
    root = null
    rootMargin = ''
    thresholds = []
  } as unknown as typeof IntersectionObserver
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {})
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList)
})

// Requires tardios — os polyfills acima têm de existir quando a cadeia de
// imports do ChatView (toolExecutor → fileStateCache → TextEncoder) corre.
/* eslint-disable @typescript-eslint/no-require-imports */
const ChatView = (require('../ChatView') as typeof import('../ChatView')).default
const { useChatStore } = require('../../../stores/chatStore') as typeof import('../../../stores/chatStore')
const { useProjectStore } = require('../../../stores/projectStore') as typeof import('../../../stores/projectStore')
const { useAgentStore } = require('../../../stores/agentStore') as typeof import('../../../stores/agentStore')
/* eslint-enable @typescript-eslint/no-require-imports */

const PROJECT_PATH = '/projects/test-app'

let root: Root | null = null
let container: HTMLDivElement | null = null

function mountWithSession(messageCount: number) {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'test-app',
      path: PROJECT_PATH,
      projectType: 'node',
    } as never,
  })

  const sessionId = useChatStore.getState().createSession(PROJECT_PATH)
  useChatStore.getState().setActiveSession(sessionId)
  for (let i = 0; i < messageCount; i++) {
    useChatStore.getState().addSystemMessage(`mensagem ${i}`)
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <ChakraProvider value={theme}>
        <ChatView />
      </ChakraProvider>,
    )
  })
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
  useAgentStore.getState().setStatus('idle')
  useAgentStore.getState().setError(null)
})

test('error sequence (agentRunner.onError + system error message) does not loop', () => {
  mountWithSession(35)

  // Streaming em curso — espelho do estado real quando um erro chega.
  act(() => {
    useChatStore.getState().startAssistantMessage()
    useAgentStore.getState().setStatus('generating')
  })

  // Sequência exata do agentRunner.onError + usePromptBar (erro recuperável).
  act(() => {
    useAgentStore.getState().setCompactPhase('idle')
    useAgentStore.getState().setStatus('error')
    useAgentStore.getState().setError('Erro de upstream — 503 tm_upstream_transport_error')
    useChatStore.getState().finalizeAssistantMessage()
    useChatStore.getState().addSystemMessage(
      'O provedor de IA teve um problema temporário. Tenta novamente.',
      'error',
    )
  })

  // Rajada de mensagens de erro — cenário "mensagens de erro" plural do
  // relatório de produção (vários erros consecutivos do agent loop).
  act(() => {
    for (let i = 0; i < 10; i++) {
      useChatStore.getState().addSystemMessage(`erro consecutivo ${i}`, 'error')
    }
  })

  // Se chegámos aqui sem "Maximum update depth exceeded", não há loop.
  expect(useAgentStore.getState().status).toBe('error')
})
