/**
 * toolResultGlobalBudget — o budget tem de ser um GATE real (2026-07-13).
 * A versão original compactava incondicionalmente tudo fora dos 4 resultados
 * mais recentes, mesmo a 5K dos 40K orçamentados — working set do modelo
 * hardcoded a 4, releituras forçadas, dança do force:true.
 */
import {
  applyGlobalToolResultBudget,
} from '../toolResultGlobalBudget'

type MessageLike = {
  role: 'user' | 'assistant'
  content: string | any[] | null
}

/** Um par tool_call/tool_result de read_file com corpo de `chars` chars. */
function readPair(id: string, path: string, chars: number): MessageLike[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool_call',
        id,
        name: 'read_file',
        arguments: JSON.stringify({ file_path: path }),
      }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: id, content: 'x'.repeat(chars) }],
    },
  ]
}

function resultContents(messages: MessageLike[]): string[] {
  const out: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === 'tool_result') out.push(block.content as string)
    }
  }
  return out
}

describe('applyGlobalToolResultBudget', () => {
  it('compacts NOTHING while under budget, even beyond keepRecent results', () => {
    // 8 resultados (o dobro do keepRecent=4), todos pequenos → sob o budget.
    const messages: MessageLike[] = []
    for (let i = 0; i < 8; i++) {
      messages.push(...readPair(`c${i}`, `/repo/f${i}.ts`, 3000)) // ~1000 tokens cada
    }
    const result = applyGlobalToolResultBudget(messages as any)

    expect(result.compactedCount).toBe(0)
    expect(result.messages).toBe(messages) // passthrough, sem cópia
    for (const content of resultContents(result.messages as any)) {
      expect(content.startsWith('[tool-result-summary]')).toBe(false)
    }
  })

  it('over budget: evicts OLDEST-first and only until back under', () => {
    // 4 resultados de ~2000 tokens (6000 chars), budget 5000, keepRecent 2.
    // before=8000 → compacta c0 (→~6350) → compacta c1 (→~4700 ≤ 5000) → para.
    const messages: MessageLike[] = []
    for (let i = 0; i < 4; i++) {
      messages.push(...readPair(`c${i}`, `/repo/f${i}.ts`, 6000))
    }
    const result = applyGlobalToolResultBudget(messages as any, {
      budgetTokens: 5000,
      keepRecent: 2,
    })

    const contents = resultContents(result.messages as any)
    expect(result.compactedCount).toBe(2)
    expect(contents[0].startsWith('[tool-result-summary]')).toBe(true)
    expect(contents[1].startsWith('[tool-result-summary]')).toBe(true)
    expect(contents[2]).toBe('x'.repeat(6000))
    expect(contents[3]).toBe('x'.repeat(6000))
    expect(result.tokensAfter).toBeLessThanOrEqual(5000)
    // O sumário preserva identificabilidade + instrução de releitura.
    expect(contents[0]).toContain('path: /repo/f0.ts')
    expect(contents[0]).toContain('Re-read')
  })

  it('never compacts the single most recent result, even hopelessly over budget', () => {
    const messages: MessageLike[] = []
    for (let i = 0; i < 3; i++) {
      messages.push(...readPair(`c${i}`, `/repo/f${i}.ts`, 6000))
    }
    const result = applyGlobalToolResultBudget(messages as any, {
      budgetTokens: 100, // impossível de cumprir
      keepRecent: 2,
    })

    const contents = resultContents(result.messages as any)
    expect(contents[0].startsWith('[tool-result-summary]')).toBe(true)
    expect(contents[1].startsWith('[tool-result-summary]')).toBe(true)
    expect(contents[2]).toBe('x'.repeat(6000)) // o mais recente sobrevive sempre
  })

  it('respects pinnedPaths under pressure', () => {
    const messages: MessageLike[] = []
    for (let i = 0; i < 4; i++) {
      messages.push(...readPair(`c${i}`, `/repo/f${i}.ts`, 6000))
    }
    const result = applyGlobalToolResultBudget(messages as any, {
      budgetTokens: 5000,
      keepRecent: 2,
      pinnedPaths: new Set(['/repo/f0.ts']),
    })

    const contents = resultContents(result.messages as any)
    // f0 está pinado → a evicção salta-o e come o seguinte mais antigo.
    expect(contents[0]).toBe('x'.repeat(6000))
    expect(contents[1].startsWith('[tool-result-summary]')).toBe(true)
  })
})
