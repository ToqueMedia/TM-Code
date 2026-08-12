import { useChatStore } from '../chatStore'

/**
 * Libertar o conteúdo de diffs resolvidos (2026-08-11).
 *
 * Bissecção de RSS do WebContent: abrir projecto +1 MB, run só de leituras
 * +1 MB, run com diffs **+35 MB e não desce**; em repouso estabiliza (<1 MB).
 * DOM em 9.153 nós, lado Rust ilibado pelo `ps`, camadas limpas no Layers —
 * sobra heap de JS retido, e `diffOldContent`/`diffNewContent` guardam duas
 * cópias completas do ficheiro por edição enquanto a sessão viver.
 */
describe('release de diffs resolvidos', () => {
  const big = 'x'.repeat(150_000)
  const small = 'y'.repeat(1_000)

  function seed(old: string, neu: string, status: 'pending' = 'pending') {
    useChatStore.setState({
      sessions: new Map([['s1', {
        id: 's1', projectPath: '/p', createdAt: 1, updatedAt: 1,
        messages: [{
          id: 'm1', role: 'assistant', content: '', timestamp: 1,
          toolCalls: [{
            id: 'tc1', toolName: 'Edit', input: {}, status: 'completed',
            timestamp: 1, diffStatus: status,
            diffOldContent: old, diffNewContent: neu,
          }],
        }],
      } as never]]),
      activeSessionId: 's1',
      pendingDiffs: [],
    })
  }

  function toolCall() {
    const s = useChatStore.getState()
    const msg = s.sessions.get('s1')!.messages[0]
    return (msg.toolCalls ?? [])[0] as { diffOldContent?: string; diffNewContent?: string; diffStatus?: string }
  }

  it('liberta um diff GRANDE ao descartar os pendentes', () => {
    seed(big, big)
    useChatStore.getState().discardPendingDiffs()

    const tc = toolCall()
    expect(tc.diffStatus).toBe('denied')          // a acção CORREU
    expect(tc.diffOldContent).toBeUndefined()     // e libertou
    expect(tc.diffNewContent).toBeUndefined()
  })

  it('PRESERVA um diff pequeno — o cartão continua a renderizar', () => {
    seed(small, small)
    useChatStore.getState().discardPendingDiffs()

    const tc = toolCall()
    expect(tc.diffStatus).toBe('denied')
    expect(tc.diffOldContent).toBe(small)
    expect(tc.diffNewContent).toBe(small)
  })

  it('o limiar é o COMBINADO dos dois lados', () => {
    // 150k + 150k = 300k > 200k → liberta. Um lado só (150k) não chegaria.
    seed('z'.repeat(120_000), 'w'.repeat(120_000))
    useChatStore.getState().discardPendingDiffs()
    expect(toolCall().diffNewContent).toBeUndefined()
  })

  /**
   * O caminho NORMAL — e o que faltava (2026-08-12).
   *
   * O fix original tratou cinco call sites e deixou de fora o
   * `syncDiffStatusByResultId`, que é precisamente o que o fluxo de APROVAÇÃO
   * chama (`acceptDiff` → sync → removePendingDiff). Os testes cobriam só o
   * descarte, portanto ficaram verdes com a fuga viva no caso comum: um run
   * de trabalho aprova diffs, não os descarta.
   */
  describe('syncDiffStatusByResultId — o caminho da aprovação', () => {
    function seedWithResultId(old: string, neu: string) {
      useChatStore.setState({
        sessions: new Map([['s1', {
          id: 's1', projectPath: '/p', createdAt: 1, updatedAt: 1,
          messages: [{
            id: 'm1', role: 'assistant', content: '', timestamp: 1,
            toolCalls: [{
              id: 'tc1', toolName: 'Edit', input: {}, status: 'completed',
              timestamp: 1, diffStatus: 'pending', diffResultId: 'dr1',
              diffOldContent: old, diffNewContent: neu,
            }],
          }],
        } as never]]),
        activeSessionId: 's1',
        pendingDiffs: [],
      })
    }

    it('APROVAR liberta um diff grande', () => {
      seedWithResultId(big, big)
      useChatStore.getState().syncDiffStatusByResultId('dr1', 'approved')

      const tc = toolCall()
      expect(tc.diffStatus).toBe('approved')     // a acção CORREU
      expect(tc.diffOldContent).toBeUndefined()  // e libertou
      expect(tc.diffNewContent).toBeUndefined()
    })

    it('RECUSAR por este caminho também liberta', () => {
      seedWithResultId(big, big)
      useChatStore.getState().syncDiffStatusByResultId('dr1', 'denied')
      expect(toolCall().diffNewContent).toBeUndefined()
    })

    it('um diff pequeno continua a renderizar depois de aprovado', () => {
      seedWithResultId(small, small)
      useChatStore.getState().syncDiffStatusByResultId('dr1', 'approved')

      const tc = toolCall()
      expect(tc.diffStatus).toBe('approved')
      expect(tc.diffOldContent).toBe(small)
    })

    it('mensagens NÃO afectadas mantêm a identidade — senão é re-render à toa', () => {
      // O `changed` era partilhado entre mensagens: uma vez true, todas as
      // seguintes eram recriadas com um array de toolCalls novo e itens
      // idênticos. Identidade nova sem conteúdo novo.
      useChatStore.setState({
        sessions: new Map([['s1', {
          id: 's1', projectPath: '/p', createdAt: 1, updatedAt: 1,
          messages: [
            {
              id: 'm1', role: 'assistant', content: '', timestamp: 1,
              toolCalls: [{
                id: 'tc1', toolName: 'Edit', input: {}, status: 'completed',
                timestamp: 1, diffStatus: 'pending', diffResultId: 'dr1',
                diffOldContent: big, diffNewContent: big,
              }],
            },
            { id: 'm2', role: 'assistant', content: 'depois', timestamp: 2, toolCalls: [] },
          ],
        } as never]]),
        activeSessionId: 's1',
        pendingDiffs: [],
      })
      const antes = useChatStore.getState().sessions.get('s1')!.messages[1]
      useChatStore.getState().syncDiffStatusByResultId('dr1', 'approved')
      const depois = useChatStore.getState().sessions.get('s1')!.messages[1]
      expect(depois).toBe(antes)
    })
  })
})
