import { microcompact, CLEARED_MESSAGE } from '../microcompact'

// Minimal builders matching ContentBlockAPI's tool_call / tool_result shape.
const toolCall = (id: string, name: string) => ({ type: 'tool_call' as const, id, name, arguments: '{}' })
const toolResult = (toolCallId: string, content: string) => ({ type: 'tool_result' as const, toolCallId, content })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resultsById = (messages: any[]) =>
  messages
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter(b => b.type === 'tool_result') as Array<{ toolCallId: string; content: string }>

describe('microcompact — COMPACTABLE_TOOLS must match TM Code tool names', () => {
  // Regression guard: the port from claude-vaz kept generic names (bash/grep/
  // terminal). TM Code registers `execute_command` and `search_files` — the two
  // heaviest outputs. If those drop out of the set, microcompact silently stops
  // clearing the biggest context hogs.
  it('clears execute_command and search_files results, keeps the most recent', () => {
    const big = 'x'.repeat(4000)
    const messages = [
      { role: 'assistant' as const, content: [toolCall('t1', 'execute_command')] },
      { role: 'user' as const, content: [toolResult('t1', big)] },
      { role: 'assistant' as const, content: [toolCall('t2', 'search_files')] },
      { role: 'user' as const, content: [toolResult('t2', big)] },
      { role: 'assistant' as const, content: [toolCall('t3', 'read_file')] },
      { role: 'user' as const, content: [toolResult('t3', big)] },
    ]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = microcompact(messages as any, { keepRecent: 1 })

    expect(res.clearedCount).toBe(2)
    expect(res.tokensSaved).toBeGreaterThan(0)
    const byId = Object.fromEntries(resultsById(res.messages as any[]).map(b => [b.toolCallId, b.content]))
    expect(byId.t1).toBe(CLEARED_MESSAGE) // execute_command — cleared
    expect(byId.t2).toBe(CLEARED_MESSAGE) // search_files — cleared
    expect(byId.t3).toBe(big)             // most-recent result — kept in full
  })

  it('does NOT treat the old claude-vaz name "bash" as a compactable tool', () => {
    const big = 'y'.repeat(4000)
    const messages = [
      { role: 'assistant' as const, content: [toolCall('b1', 'bash')] },
      { role: 'user' as const, content: [toolResult('b1', big)] },
      { role: 'assistant' as const, content: [toolCall('r1', 'read_file')] },
      { role: 'user' as const, content: [toolResult('r1', big)] },
    ]

    // keepRecent=1: were 'bash' compactable, b1 would be cleared (read_file r1 is
    // the most recent). It must stay untouched — 'bash' is not a real tool here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = microcompact(messages as any, { keepRecent: 1 })
    const byId = Object.fromEntries(resultsById(res.messages as any[]).map(b => [b.toolCallId, b.content]))
    expect(byId.b1).toBe(big)
  })
})
