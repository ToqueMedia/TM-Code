/**
 * Paridade claude-vaz para sessões longas (2026-07-31).
 *
 * Duas propriedades que o TM Code tinha escritas e não usava — o caminho de
 * compactação perdeu os callers quando `compressContext` foi substituído pelo
 * compact via SDK, e o código ficou lá a parecer implementado:
 *
 *   1. ARQUIVO. O que a compactação substitui pelo sumário é gravado em disco e
 *      o caminho vai NA mensagem de sumário. O sumário é lossy por definição;
 *      sem o caminho, a citação literal do developer e a mensagem de erro exata
 *      desaparecem sem recurso.
 *   2. RECUPERAÇÃO. A seguir ao sumário volta o ESTADO DE TRABALHO (conteúdo dos
 *      ficheiros recentes, texto das skills lidas). O claude-vaz faz isto com
 *      anexos pós-compactação; sem isso o modelo continua com uma narrativa e
 *      nenhum material, e a primeira coisa que faz depois de compactar é reler
 *      tudo o que a compactação acabou de pagar para deitar fora.
 */
import { compactNow } from '../compact/autoCompact'
import { getCompactUserSummaryMessage } from '../compact/prompt'
import { rebuildConversationHistory } from '../../../stores/chatStore'

import type { ContentBlockAPI, ChatMessage } from '../../../types/chat'

type Msg = { role: 'user' | 'assistant'; content: string | ContentBlockAPI[] | null }

function conversation(turns: number): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `pergunta ${i}` })
    out.push({ role: 'assistant', content: `resposta ${i}` })
    out.push({ role: 'user', content: `tool result ${i}` })
  }
  return out
}

const ARCHIVE = '/proj/.tmcode/sessions/s1.pre-compact-1.jsonl'

describe('arquivo pré-compactação', () => {
  it('recebe SÓ o bloco antigo — o preservado continua literal no contexto', async () => {
    const archive = jest.fn(async (_older: Msg[]) => ARCHIVE)
    await compactNow(conversation(6), 'system', async () => 'S', 3, archive)

    const archived = archive.mock.calls[0][0]
    // Arquivar o que fica no contexto duplicava-o: uma vez literal, outra em
    // disco, e o modelo com duas fontes para a mesma coisa.
    expect(archived.some(m => m.content === 'resposta 5')).toBe(false)
    expect(archived.some(m => m.content === 'pergunta 0')).toBe(true)
  })

  it('põe o caminho na mensagem de sumário com instruções de uso', async () => {
    const out = await compactNow(conversation(6), 'system', async () => 'S', 3, async () => ARCHIVE)
    expect(out![0].content).toContain(ARCHIVE)
    // Ler o JSONL inteiro custaria mais do que o sumário poupou.
    expect(out![0].content).toContain('search_files')
  })

  it('sem arquivo (escrita falhou) a compactação segue e não inventa caminho', async () => {
    const out = await compactNow(conversation(6), 'system', async () => 'S', 3, async () => null)
    expect(out).not.toBeNull()
    expect(out![0].content).not.toContain('pre-compaction transcript')
  })

  it('uma falha do arquivo nunca derruba a compactação', async () => {
    const out = await compactNow(conversation(6), 'system', async () => 'S', 3, async () => {
      throw new Error('disco cheio')
    })
    expect(out).not.toBeNull()
    expect(out![0].content).toContain('S')
  })

  it('sumarizador vazio → null, e o arquivo não é referenciado', async () => {
    // O histórico fica como está; um caminho de arquivo apontaria para
    // mensagens que continuam vivas no contexto.
    const archive = jest.fn(async (_older: Msg[]) => ARCHIVE)
    expect(await compactNow(conversation(6), 'system', async () => null, 3, archive)).toBeNull()
  })
})

describe('getCompactUserSummaryMessage', () => {
  it('sem transcriptPath mantém o texto anterior (nada de secção vazia)', () => {
    const msg = getCompactUserSummaryMessage('RESUMO', true, true)
    expect(msg).toContain('RESUMO')
    expect(msg).not.toContain('pre-compaction transcript')
  })

  it('acumula os três blocos: enquadramento, arquivo e ordem de continuar', () => {
    const msg = getCompactUserSummaryMessage('RESUMO', true, true, ARCHIVE)
    expect(msg).toContain('EARLIER portion only')
    expect(msg).toContain(ARCHIVE)
    expect(msg).toContain('without asking the user any further questions')
  })
})

describe('rebuildConversationHistory — fronteira de compactação', () => {
  const boundary = (extra: Partial<ChatMessage>): ChatMessage => ({
    id: 'b1',
    role: 'system',
    kind: 'compact_boundary',
    content: 'Conversa comprimida (120K tokens).',
    timestamp: 1,
    ...extra,
  } as ChatMessage)

  it('re-emite sumário e recuperação como DUAS mensagens user, por essa ordem', () => {
    const history = rebuildConversationHistory([
      boundary({ compactSummary: 'SUMÁRIO', compactRecovery: 'MATERIAL' }),
      { id: 'm1', role: 'user', content: 'e agora?', timestamp: 2 } as ChatMessage,
    ])
    expect(history.map(h => h.content)).toEqual(['SUMÁRIO', 'MATERIAL', 'e agora?'])
  })

  it('recuperação sozinha continua a ser emitida (sumário pode falhar e a recuperação não)', () => {
    const history = rebuildConversationHistory([boundary({ compactRecovery: 'MATERIAL' })])
    expect(history).toHaveLength(1)
    expect(history[0].content).toBe('MATERIAL')
  })

  it('fronteira sem payload continua invisível para o modelo', () => {
    // A linha de estatísticas (`content`) é UI. Emiti-la mandava "Conversa
    // comprimida (120K tokens)." ao modelo como se fosse contexto.
    expect(rebuildConversationHistory([boundary({})])).toHaveLength(0)
  })
})

describe('compactação é um filtro de leitura, não uma eliminação', () => {
  const user = (id: string, text: string): ChatMessage =>
    ({ id, role: 'user', content: text, timestamp: 1 } as ChatMessage)
  const boundary = (id: string, summary: string): ChatMessage =>
    ({
      id,
      role: 'system',
      kind: 'compact_boundary',
      content: 'Conversa comprimida.',
      compactSummary: summary,
      timestamp: 1,
    } as ChatMessage)

  it('mensagens antes da fronteira não vão para o modelo, mesmo estando no array', () => {
    // Esta é a propriedade que permite parar de as APAGAR do store: o corte
    // acontece na leitura, portanto o disco pode guardar tudo.
    const history = rebuildConversationHistory([
      user('m1', 'pergunta muito antiga'),
      user('m2', 'outra antiga'),
      boundary('b1', 'SUMÁRIO'),
      user('m3', 'pergunta atual'),
    ])
    expect(history.map(h => h.content)).toEqual(['SUMÁRIO', 'pergunta atual'])
  })

  it('com várias compactações manda a ÚLTIMA fronteira', () => {
    // A fronteira mais recente já resume o sumário anterior; honrar a primeira
    // reenviava tudo o que as compactações seguintes tinham comprimido.
    const history = rebuildConversationHistory([
      user('m1', 'antiga'),
      boundary('b1', 'SUMÁRIO 1'),
      user('m2', 'meio'),
      boundary('b2', 'SUMÁRIO 2'),
      user('m3', 'atual'),
    ])
    expect(history.map(h => h.content)).toEqual(['SUMÁRIO 2', 'atual'])
  })

  it('sem fronteira nenhuma nada é cortado', () => {
    const history = rebuildConversationHistory([user('m1', 'a'), user('m2', 'b')])
    expect(history.map(h => h.content)).toEqual(['a', 'b'])
  })

  it('a recuperação da última fronteira também passa, a das anteriores não', () => {
    const history = rebuildConversationHistory([
      { ...boundary('b1', 'VELHO'), compactRecovery: 'MATERIAL VELHO' } as ChatMessage,
      user('m2', 'meio'),
      { ...boundary('b2', 'NOVO'), compactRecovery: 'MATERIAL NOVO' } as ChatMessage,
    ])
    expect(history.map(h => h.content)).toEqual(['NOVO', 'MATERIAL NOVO'])
  })
})
