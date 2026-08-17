import { sessionService } from '../sessionService'
import type { ChatMessage, ToolCallDisplay } from '../../../types/chat'

/**
 * Diffs resolvidos não são persistidos nem re-materializados (2026-08-12).
 *
 * MEDIDO: num ficheiro de sessão de 19,7 MB, **11,9 MB (60%) eram
 * `diffOldContent`/`diffNewContent`** em 185 tool calls — contra 0,6 MB de
 * results, esses truncados desde sempre. 391 MB em disco no total, e +553 MB
 * de RSS só para ABRIR um projecto.
 *
 * O `releaseResolvedDiff` do chatStore não cobre isto: tem limiar de 200 KB
 * por diff e a média real são ~64 KB. O problema é a SOMA, não o tamanho de
 * cada um.
 */
describe('strip de diffs resolvidos na persistência', () => {
  const svc = sessionService as unknown as {
    sanitizeMessageForSave: (m: ChatMessage) => ChatMessage | null
    sanitizeMessage: (m: ChatMessage) => ChatMessage
  }

  const bigOld = 'linha antiga do ficheiro\n'.repeat(2_000)
  const bigNew = 'linha nova do ficheiro\n'.repeat(2_000)

  function msgCom(diffStatus: ToolCallDisplay['diffStatus']): ChatMessage {
    return {
      id: 'm1', role: 'assistant', content: 'x', timestamp: 1,
      toolCalls: [{
        id: 'tc1', toolName: 'Edit', input: {}, status: 'completed',
        timestamp: 1, diffStatus,
        diffOldContent: bigOld, diffNewContent: bigNew,
      } as ToolCallDisplay],
    } as ChatMessage
  }

  const tc = (m: ChatMessage | null) => (m!.toolCalls ?? [])[0] as ToolCallDisplay

  describe('ao GRAVAR', () => {
    it('aprovado perde o conteúdo — é 60% do ficheiro de sessão', () => {
      const out = tc(svc.sanitizeMessageForSave(msgCom('approved')))
      expect(out.diffStatus).toBe('approved')
      expect(out.diffOldContent).toBeUndefined()
      expect(out.diffNewContent).toBeUndefined()
    })

    it('aprovado conserva +N/−M para o header depois de reabrir o projecto', () => {
      const out = tc(svc.sanitizeMessageForSave(msgCom('approved')))
      expect(out.diffAdded).toBeGreaterThan(0)
      expect(out.diffRemoved).toBeGreaterThan(0)
    })

    it('não pisa contagens já gravadas', () => {
      const m = msgCom('approved')
      m.toolCalls![0].diffAdded = 4
      m.toolCalls![0].diffRemoved = 2
      const out = tc(svc.sanitizeMessageForSave(m))
      expect(out.diffAdded).toBe(4)
      expect(out.diffRemoved).toBe(2)
    })

    it('recusado também', () => {
      const out = tc(svc.sanitizeMessageForSave(msgCom('denied')))
      expect(out.diffNewContent).toBeUndefined()
    })

    it('PENDENTE fica intacto — ainda tem de ser mostrado para decidir', () => {
      const out = tc(svc.sanitizeMessageForSave(msgCom('pending')))
      expect(out.diffOldContent).toBe(bigOld)
      expect(out.diffNewContent).toBe(bigNew)
    })

    it('SEM limiar de tamanho — o problema é a soma, não o diff grande', () => {
      // 64 KB é a média real medida; o releaseResolvedDiff (limiar 200 KB)
      // deixaria passar este e os outros 184 da sessão.
      const medio = 'x'.repeat(32_000)
      const m = msgCom('approved')
      m.toolCalls![0].diffOldContent = medio
      m.toolCalls![0].diffNewContent = medio
      expect(tc(svc.sanitizeMessageForSave(m)).diffNewContent).toBeUndefined()
    })
  })

  describe('ao LER do disco', () => {
    it('sessões antigas não voltam a materializar o conteúdo', () => {
      // Sem isto, os 391 MB já gravados continuavam a custar a abertura toda
      // até cada sessão ser re-gravada.
      const out = tc(svc.sanitizeMessage(msgCom('approved')))
      expect(out.diffOldContent).toBeUndefined()
      // Mas as contagens nascem do conteúdo ainda presente, para o header.
      expect(out.diffAdded).toBeGreaterThan(0)
    })

    it('e um pendente restaurado continua a poder ser decidido', () => {
      const out = tc(svc.sanitizeMessage(msgCom('pending')))
      expect(out.diffNewContent).toBe(bigNew)
    })
  })
})

export {}
