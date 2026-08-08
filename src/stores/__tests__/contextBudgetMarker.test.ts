import { useChatStore } from '../chatStore'

/**
 * Marco do orçamento de tool results — o registo de que contexto foi libertado
 * SEM sumarização.
 *
 * Foi entregue partido: o callback atravessa quatro ficheiros (query →
 * queryEngine → agentService → mainDispatch) e dois deles não o repassavam. Um
 * callback opcional a que falta um elo não dá erro de compilação nem parte
 * teste nenhum — morreu em silêncio, e só uma sessão real de 96 pedidos, horas
 * depois, mostrou três quedas de contexto e um único marcador.
 *
 * A guarda da CADEIA vive em `services/agent/__tests__/hooks.test.ts` (lê os
 * ficheiros e confirma que nenhum elo falta). O que falta é o COMPORTAMENTO da
 * ponta final: o marco entra na sessão certa, com os números certos, e não é
 * renderizado — é essa a forma do cli-vaz (cria a mensagem, devolve null ao
 * pintá-la).
 */
describe('marco do orçamento de contexto', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: new Map(), activeSessionId: null, streamingSessionId: null })
  })

  it('regista tokens antes/depois e quantos resultados foram limpos', () => {
    const id = useChatStore.getState().createSession('/proj')
    useChatStore.setState({ activeSessionId: id })

    useChatStore.getState().addContextBudgetMarker(80_000, 62_000, 7)

    const msgs = useChatStore.getState().sessions.get(id)!.messages
    const marco = msgs.find(m => m.kind === 'context_budget')
    expect(marco).toBeDefined()
    expect(marco!.role).toBe('system')
    expect(marco!.contextBudget).toEqual({
      tokensBefore: 80_000,
      tokensAfter: 62_000,
      clearedCount: 7,
    })
  })

  // Escreve na sessão em TRANSMISSÃO, não na que está em foco. É a mesma
  // distinção que fazia o pill ler uma sessão que ninguém actualizava.
  it('vai para a sessão a transmitir quando ela difere da activa', () => {
    const emFoco = useChatStore.getState().createSession('/proj')
    const aTransmitir = useChatStore.getState().createSession('/proj')
    useChatStore.setState({ activeSessionId: emFoco, streamingSessionId: aTransmitir })

    useChatStore.getState().addContextBudgetMarker(50_000, 40_000, 3)

    const s = useChatStore.getState().sessions
    expect(s.get(aTransmitir)!.messages.some(m => m.kind === 'context_budget')).toBe(true)
    expect(s.get(emFoco)!.messages.some(m => m.kind === 'context_budget')).toBe(false)
  })

  // A outra metade do contrato do cli-vaz: `createMicrocompactBoundaryMessage`
  // cria a mensagem, e `Message.tsx:246` devolve `null` ao pintá-la. Registado
  // e invisível. Montar o MessageBubble aqui puxaria meia UI, por isso o que se
  // trava é o ramo — se alguém o apagar, o marco começa a aparecer no chat a
  // cada punhado de turnos e vira ruído.
  it('o MessageBubble tem o ramo que NÃO o renderiza', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    const src = fs.readFileSync('src/components/chat/MessageBubble.tsx', 'utf8')
    expect(src).toMatch(/message\.kind === 'context_budget'\) return null/)
  })

  it('sem sessão nenhuma, não rebenta nem inventa uma', () => {
    expect(() => useChatStore.getState().addContextBudgetMarker(10, 5, 1)).not.toThrow()
    expect(useChatStore.getState().sessions.size).toBe(0)
  })
})
