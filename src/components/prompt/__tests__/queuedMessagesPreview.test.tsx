/**
 * QueuedMessagesPreview — cablagem da pilha fundida no composer.
 *
 * O foco é o comportamento EDITAR: tirar a mensagem da fila e devolvê-la
 * ao draft (texto + anexos), sem comer o que o utilizador já estava a
 * escrever, e pedindo o focus do textarea (evento promptbar:focus).
 * Mais o apagar por mensagem e o filtro por sessão activa.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'

// jsdom não tem structuredClone (Chakra clona o theme ao montar).
globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

// Chaves de tradução passam a puro identificador — os aria-label dos
// botões ficam estáveis ('queue.editQueued', 'queue.removeQueued').
jest.mock('@/i18n', () => ({ t: (key: string) => key }))

// Sem Tauri nos testes — o log de operações da fila é um no-op.
jest.mock('@/services/agent/queueOperationLog', () => ({
  getQueueLogSessionId: () => 'test',
  recordQueueOperation: jest.fn().mockResolvedValue(undefined),
  setQueueLogContext: jest.fn(),
}))

// O componente só lê activeSessionId e (no editar) escreve no draft —
// um store zustand mínimo cobre os dois sem arrastar a persistência.
jest.mock('@/stores/chatStore', () => {
  const { create } = require('zustand')
  const useChatStore = create(() => ({
    activeSessionId: 'sess-1',
    draftInput: '',
    draftAttachments: [] as Array<{ id: string; name: string }>,
    setDraftInput: (value: string) => useChatStore.setState({ draftInput: value }),
    addDraftAttachment: (attachment: { id: string; name: string }) =>
      useChatStore.setState((s: { draftAttachments: Array<{ id: string; name: string }> }) => ({
        draftAttachments: [...s.draftAttachments, attachment],
      })),
  }))
  return { useChatStore }
})

import QueuedMessagesPreview from '../QueuedMessagesPreview'
import {
  enqueue,
  getCommandQueueSnapshot,
  resetCommandQueue,
} from '@/services/agent/messageQueue'
import { useChatStore } from '@/stores/chatStore'
import type { Attachment } from '@/types/chat'
import type { QueuedCommand } from '@/types/messageQueueTypes'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

const mk = (value: QueuedCommand['value'], overrides?: Partial<QueuedCommand>): QueuedCommand => ({
  value,
  mode: 'prompt',
  ...overrides,
})

const mkAtt = (id: string): Attachment =>
  ({ id, type: 'image', name: `${id}.png`, path: `/tmp/${id}.png` }) as Attachment

function clickButton(root: HTMLElement, ariaLabel: string): void {
  const btn = Array.from(root.querySelectorAll('button')).find(
    b => b.getAttribute('aria-label') === ariaLabel,
  )
  expect(btn).toBeDefined()
  act(() => {
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('QueuedMessagesPreview — editar e apagar mensagens em fila', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetCommandQueue()
    useChatStore.setState({ draftInput: '', draftAttachments: [] })
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
          <QueuedMessagesPreview />
        </ChakraProvider>,
      )
    })
  }

  it('não renderiza nada com a fila vazia', () => {
    render()
    expect(container.textContent).toBe('')
  })

  it('mostra só as mensagens da sessão activa', () => {
    enqueue(mk('msg da sessão', { uuid: 'q1', sessionId: 'sess-1' }))
    enqueue(mk('msg de outra sessão', { uuid: 'q2', sessionId: 'sess-other' }))
    render()
    expect(container.textContent).toContain('msg da sessão')
    expect(container.textContent).not.toContain('msg de outra sessão')
  })

  it('editar devolve o texto ao draft, esvazia a fila e pede focus do textarea', () => {
    const focusSpy = jest.fn()
    window.addEventListener('promptbar:focus', focusSpy)

    enqueue(mk('concertiza o header', { uuid: 'q1', sessionId: 'sess-1' }))
    render()
    clickButton(container, 'queue.editQueued')

    expect(useChatStore.getState().draftInput).toBe('concertiza o header')
    expect(getCommandQueueSnapshot().length).toBe(0)
    expect(focusSpy).toHaveBeenCalledTimes(1)

    window.removeEventListener('promptbar:focus', focusSpy)
  })

  it('editar NÃO come o rascunho em curso — acrescenta por baixo', () => {
    useChatStore.setState({ draftInput: 'rascunho' })
    enqueue(mk('segunda mensagem', { uuid: 'q1', sessionId: 'sess-1' }))
    render()
    clickButton(container, 'queue.editQueued')

    expect(useChatStore.getState().draftInput).toBe('rascunho\nsegunda mensagem')
  })

  it('editar devolve os anexos como chips do draft', () => {
    enqueue(mk([
      { type: 'text', text: 'olha esta imagem' },
      { type: 'attachment', attachment: mkAtt('img-1') },
    ], { uuid: 'q1', sessionId: 'sess-1' }))
    render()
    clickButton(container, 'queue.editQueued')

    const state = useChatStore.getState()
    expect(state.draftInput).toBe('olha esta imagem')
    expect(state.draftAttachments).toHaveLength(1)
    expect(state.draftAttachments[0]!.name).toBe('img-1.png')
  })

  it('apagar remove só a mensagem clicada', () => {
    enqueue(mk('primeira', { uuid: 'q1', sessionId: 'sess-1' }))
    enqueue(mk('segunda', { uuid: 'q2', sessionId: 'sess-1' }))
    render()
    expect(container.textContent).toContain('primeira')

    clickButton(container, 'queue.removeQueued')

    const remaining = getCommandQueueSnapshot()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.uuid).toBe('q2')
    expect(useChatStore.getState().draftInput).toBe('')
  })
})
