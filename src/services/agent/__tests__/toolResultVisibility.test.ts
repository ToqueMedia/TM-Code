/**
 * toolResultVisibility — coordenação evicção↔dedup (raiz da "dança do
 * force: true", 2026-07-13). Um stub de dedup só é permitido quando o
 * tool_result que levou o conteúdo ao modelo seguiu INTACTO no último
 * pedido; compactado/removido → o read serve o conteúdo diretamente.
 */
import {
  clearToolResultVisibility,
  isToolResultContextVisible,
  updateToolResultVisibility,
} from '../toolExecutor/toolResultVisibility'
import {
  checkReadRangeOverlap,
  clearReadRangeTracker,
  recordReadRange,
} from '../toolExecutor/readRangeTracker'

type MessageLike = {
  role: 'user' | 'assistant'
  content: string | any[] | null
}

function toolResultMsg(toolCallId: string, content: string): MessageLike {
  return { role: 'user', content: [{ type: 'tool_result', toolCallId, content }] }
}

describe('toolResultVisibility', () => {
  beforeEach(() => {
    clearToolResultVisibility()
    clearReadRangeTracker()
  })

  it('defaults to visible for unknown ids and missing ids', () => {
    expect(isToolResultContextVisible('never-seen')).toBe(true)
    expect(isToolResultContextVisible(undefined)).toBe(true)
  })

  it('marks intact results visible and compacted results not visible', () => {
    const history: MessageLike[] = [
      toolResultMsg('c1', 'full file content of a.ts'),
      toolResultMsg('c2', 'full file content of b.ts'),
    ]
    const sent: MessageLike[] = [
      toolResultMsg('c1', 'full file content of a.ts'),
      toolResultMsg('c2', '[tool-result-summary]\ntool: read_file | path: /b.ts | original: 9000 chars\n[end summary]'),
    ]
    updateToolResultVisibility(history as any, sent as any)

    expect(isToolResultContextVisible('c1')).toBe(true)
    expect(isToolResultContextVisible('c2')).toBe(false)
  })

  it('marks results absent from the payload (autoCompact/snip) not visible', () => {
    const history: MessageLike[] = [
      toolResultMsg('c1', 'old content removed by compaction'),
      toolResultMsg('c2', 'recent content'),
    ]
    const sent: MessageLike[] = [toolResultMsg('c2', 'recent content')]
    updateToolResultVisibility(history as any, sent as any)

    expect(isToolResultContextVisible('c1')).toBe(false)
    expect(isToolResultContextVisible('c2')).toBe(true)
  })

  it('leaves ids from other loops (sub-agents) untouched', () => {
    // Loop A classifica c1 como não-visível.
    updateToolResultVisibility(
      [toolResultMsg('c1', 'x')] as any,
      [toolResultMsg('c1', '[tool-result-summary]\nevicted')] as any,
    )
    // Loop B faz o seu snapshot — não contém c1, logo não o reclassifica.
    updateToolResultVisibility(
      [toolResultMsg('b1', 'y')] as any,
      [toolResultMsg('b1', 'y')] as any,
    )
    expect(isToolResultContextVisible('c1')).toBe(false)
    expect(isToolResultContextVisible('b1')).toBe(true)
  })

  it('a re-read restores visibility on the next snapshot', () => {
    updateToolResultVisibility(
      [toolResultMsg('c1', 'x')] as any,
      [toolResultMsg('c1', '[tool-result-summary]\nevicted')] as any,
    )
    expect(isToolResultContextVisible('c1')).toBe(false)

    // Releitura produz c9 intacto no pedido seguinte.
    updateToolResultVisibility(
      [toolResultMsg('c1', 'x'), toolResultMsg('c9', 'x')] as any,
      [toolResultMsg('c1', '[tool-result-summary]\nevicted'), toolResultMsg('c9', 'x')] as any,
    )
    expect(isToolResultContextVisible('c9')).toBe(true)
  })

  it('treats per-message truncation as not intact (safe direction)', () => {
    updateToolResultVisibility(
      [toolResultMsg('c1', 'head of the content\n\n[... content truncated by tool result budget ...]')] as any,
      [toolResultMsg('c1', 'head of the content\n\n[... content truncated by tool result budget ...]')] as any,
    )
    expect(isToolResultContextVisible('c1')).toBe(false)
  })

  describe('integration with readRangeTracker overlap dedup', () => {
    it('does not stub coverage from an evicted range; a fresh read re-arms it', () => {
      recordReadRange('/repo/a.ts', 1, undefined, 1, 1000, 'c1')

      // Enquanto c1 está intacto → fully_covered (stub verdadeiro).
      expect(checkReadRangeOverlap('/repo/a.ts', 10, 20, 1, 1000).kind).toBe('fully_covered')

      // c1 foi compactado no último payload → a cobertura desaparece.
      updateToolResultVisibility(
        [toolResultMsg('c1', 'x')] as any,
        [toolResultMsg('c1', '[tool-result-summary]\nevicted')] as any,
      )
      expect(checkReadRangeOverlap('/repo/a.ts', 10, 20, 1, 1000).kind).toBe('not_covered')

      // Releitura (novo id) re-aponta o range para o resultado fresco.
      recordReadRange('/repo/a.ts', 1, undefined, 1, 1000, 'c9')
      updateToolResultVisibility(
        [toolResultMsg('c1', 'x'), toolResultMsg('c9', 'x')] as any,
        [toolResultMsg('c1', '[tool-result-summary]\nevicted'), toolResultMsg('c9', 'x')] as any,
      )
      expect(checkReadRangeOverlap('/repo/a.ts', 10, 20, 1, 1000).kind).toBe('fully_covered')
    })
  })
})
