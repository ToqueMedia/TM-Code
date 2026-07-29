/**
 * Compactação NÃO destrutiva (auditoria 2026-07-28).
 *
 * A compactação substituía o histórico inteiro por uma única mensagem de
 * sumário — incluindo os tool results que o modelo tinha acabado de receber e
 * sobre os quais estava a meio de agir. O caminho antigo (compressContext)
 * preservava turnos recentes; ao migrar para o compact via SDK a propriedade
 * perdeu-se, porque compressContext ficou sem callers em vez de ser portado.
 */
import {
  compactNow,
  splitForCompaction,
  KEEP_RECENT_TURNS_ON_COMPACT,
} from '../compact/autoCompact'

import type { ContentBlockAPI } from '../../../types/chat'

/** Mesma forma do MessageLike interno do autoCompact. */
type Msg = { role: 'user' | 'assistant'; content: string | ContentBlockAPI[] | null }

/** N turnos completos: user → assistant → (tool results como user). */
function conversation(turns: number): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `pergunta ${i}` })
    out.push({ role: 'assistant', content: `resposta ${i}` })
    out.push({ role: 'user', content: `tool result ${i}` })
  }
  return out
}

describe('splitForCompaction', () => {
  it('corta numa fronteira de assistant (nunca deixa um tool result órfão)', () => {
    const { older, recent } = splitForCompaction(conversation(6), 2)
    expect(recent[0].role).toBe('assistant')
    expect(older[older.length - 1].role).not.toBe('assistant')
  })

  it('preserva exatamente os N turnos mais recentes', () => {
    const { recent } = splitForCompaction(conversation(6), 2)
    expect(recent.map(m => m.content)).toEqual([
      'resposta 4', 'tool result 4',
      'pergunta 5', 'resposta 5', 'tool result 5',
    ])
  })

  it('não preserva nada quando não há turnos que cheguem (compactar tem de libertar espaço)', () => {
    const msgs = conversation(2)
    const { older, recent } = splitForCompaction(msgs, 3)
    expect(recent).toEqual([])
    expect(older).toEqual(msgs)
  })

  it('keepRecentTurns 0 é o modo de emergência: nada sobrevive', () => {
    const msgs = conversation(6)
    expect(splitForCompaction(msgs, 0)).toEqual({ older: msgs, recent: [] })
  })
})

describe('compactNow', () => {
  it('sumariza SÓ a parte antiga e devolve [sumário, ...turnos recentes]', async () => {
    const msgs = conversation(6)
    const compactFn = jest.fn(async (_messages: Msg[], _systemPrompt: string) => 'SUMÁRIO')

    const out = await compactNow(msgs, 'system', compactFn)

    // O sumarizador nunca vê os turnos preservados — se visse, o conteúdo
    // ficaria duplicado (resumido E literal) e o pedido seria maior.
    const summarized = compactFn.mock.calls[0][0]
    expect(summarized.some(m => m.content === 'resposta 5')).toBe(false)

    expect(out).not.toBeNull()
    // Sumarizado + preservado reconstroem o histórico: nada se perde em
    // silêncio no corte.
    const preserved = out!.slice(1)
    expect(summarized.length + preserved.length).toBe(msgs.length)
    expect([...summarized, ...preserved].map(m => m.content)).toEqual(msgs.map(m => m.content))
    expect(out![0].role).toBe('user')
    expect(out![0].content).toContain('SUMÁRIO')
    expect(out!.slice(1).map(m => m.content)).toEqual([
      'resposta 3', 'tool result 3',
      'pergunta 4', 'resposta 4', 'tool result 4',
      'pergunta 5', 'resposta 5', 'tool result 5',
    ])
  })

  it('avisa o modelo de que os turnos recentes vêm literais a seguir', async () => {
    const out = await compactNow(conversation(6), 'system', async () => 'S')
    // Sem este aviso o modelo trata o resumo como tudo o que sabe e volta a
    // ler ficheiros cujos resultados estão logo abaixo, intactos.
    expect(out![0].content).toContain('EARLIER portion only')
    expect(out![0].content).toContain('do not re-read')
  })

  it('keepRecentTurns 0 volta ao formato de mensagem única (caminho reativo)', async () => {
    const out = await compactNow(conversation(6), 'system', async () => 'S', 0)
    expect(out).toHaveLength(1)
    expect(out![0].content).not.toContain('EARLIER portion only')
  })

  it('sumarizador vazio devolve null (o caller conta a falha)', async () => {
    expect(await compactNow(conversation(6), 'system', async () => null)).toBeNull()
  })

  it('o default preserva turnos — a regressão era exatamente não preservar', async () => {
    const out = await compactNow(conversation(10), 'system', async () => 'S')
    expect(out!.length).toBeGreaterThan(1)
    expect(KEEP_RECENT_TURNS_ON_COMPACT).toBeGreaterThan(0)
  })
})
