import { inspectPayload } from '../payloadInspector'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../contextBuilder/helpers'
import { selectAuxiliaries } from '../contextBuilder/auxiliaryRegistry'

describe('payloadInspector system-prompt analysis', () => {
  it('breaks down system prompt sections and flags on-demand candidates', () => {
    const systemPrompt = [
      'Complete every file the task requires.',
      '',
      '# Role',
      'Senior software engineer.',
      '',
      '# UI baseline',
      'Frontend visual guidance.'.repeat(100),
      '',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      '',
      '# Project structure',
      'src/index.ts\nsrc/app.tsx',
    ].join('\n')

    const report = inspectPayload(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Fix a bug' }],
      systemPrompt,
      [],
      'test-model',
      1,
    )

    expect(report.systemPromptSections.some(s => s.name === 'UI baseline' && s.location === 'static')).toBe(true)
    expect(report.systemPromptSections.some(s => s.name === 'Project structure' && s.location === 'dynamic')).toBe(true)
    expect(report.auxiliaryPromptCandidates.map(s => s.name)).toContain('UI baseline')
    expect(report.auxiliaryPromptCandidates.map(s => s.name)).toContain('Project structure')
  })

  it('accounts @mention synthetic context separately from user text', () => {
    const mentionContext = [
      '<system-reminder>',
      'Called the read_file tool with the following input: {"file_path":"/proj/src/a.ts"}',
      '</system-reminder>',
      '<system-reminder>',
      'Result of calling the read_file tool:',
      'Mentioned file summary (@mention compacted; full content was NOT injected):',
      'path: /proj/src/a.ts',
      '</system-reminder>',
    ].join('\n')

    const report = inspectPayload(
      [{ role: 'user', content: `please fix this\n${mentionContext}` }],
      undefined,
      [],
      'test-model',
      1,
    )

    expect(report.mentionContextTokens).toBeGreaterThan(0)
    expect(report.byCategory.mention_context?.tokens).toBe(report.mentionContextTokens)
    expect(report.byCategory['user-text']?.tokens).toBeGreaterThan(0)
  })

  it('accounts compact @mention reference stubs as mention context', () => {
    const stub = [
      '<system-reminder>@mention compact_reference already provided earlier.',
      'mentionContextRefId: mc-0',
      'filePath: /proj/src/a.ts',
      'alreadyProvided: true',
      'Use previous outline or read only missing ranges.</system-reminder>',
    ].join('\n')

    const report = inspectPayload(
      [{ role: 'user', content: `continue\n${stub}` }],
      undefined,
      [],
      'test-model',
      2,
    )

    expect(report.mentionContextTokens).toBeGreaterThan(0)
    expect(report.byCategory.mention_context?.tokens).toBe(report.mentionContextTokens)
    expect(report.byCategory.mention_context?.tokens).toBeLessThan(100)
  })

  it('reporta as secções auto-carregadas e os candidatos do plano', () => {
    const selection = selectAuxiliaries('default_task', 'audit MCP routing')

    const report = inspectPayload(
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'audit MCP routing' }],
      'system',
      [],
      'test-model',
      1,
      undefined,
      undefined,
      selection,
    )

    expect(report.autoLoadedSystemSections).toEqual(selection.autoLoadedSystemSections)
    expect(report.contextPlanCandidateSections).toEqual(selection.contextPlanCandidateSections)
  })
})

/**
 * Envelope do assistant (auditoria da sessão golive, 2026-08-10).
 *
 * No formato OpenAI os tool_calls e o raciocínio NÃO são blocos de `content` —
 * vivem em `msg.tool_calls` / `msg.reasoning_content`. O inspector percorria só
 * o `content`, portanto `toolCall` e `thinking` eram 0 em todos os 45 pedidos
 * da sessão e a estimativa derivava para −26% do input real ao turno 45.
 */
describe('payloadInspector — envelope do assistant (tool_calls + reasoning)', () => {
  const bigArgs = JSON.stringify({ file_path: '/proj/src/App.tsx', content: 'x'.repeat(6000) })

  const assistantWithToolCall = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'Write', arguments: bigArgs } },
    ],
  }

  it('contabiliza os argumentos dos tool_calls do envelope', () => {
    const report = inspectPayload(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'escreve' }, assistantWithToolCall],
      'sys',
      [],
      'test-model',
      2,
    )

    expect(report.estimatedInputTokensBreakdown.toolCall).toBeGreaterThan(1000)
    expect(report.byCategory.tool_call?.blocks).toBe(1)
    expect(report.topBlocks.some(b => b.kind === 'tool_call' && b.toolName === 'Write')).toBe(true)
  })

  it('inclui o tool_call no total estimado', () => {
    const withCall = inspectPayload(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'escreve' }, assistantWithToolCall],
      'sys', [], 'test-model', 2,
    )
    const withoutCall = inspectPayload(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'escreve' }, { role: 'assistant', content: null }],
      'sys', [], 'test-model', 2,
    )

    expect(withCall.totalEstimatedTokens - withoutCall.totalEstimatedTokens)
      .toBe(withCall.estimatedInputTokensBreakdown.toolCall)
  })

  it('contabiliza reasoning_content como thinking (volta no round-trip nativo)', () => {
    const report = inspectPayload(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'porquê?' },
        { role: 'assistant', content: 'A resposta.', reasoning_content: 'r'.repeat(4000) },
      ],
      'sys', [], 'test-model', 2,
    )

    expect(report.estimatedInputTokensBreakdown.thinking).toBeGreaterThan(500)
    expect(report.estimatedInputTokensBreakdown.assistantText).toBeGreaterThan(0)
  })

  /**
   * As duas representações coexistem no produto: o formato de FIO usa
   * envelope, o INTERNO usa blocos de content. A sessão BYOK/MiMo (2026-08-10)
   * mostrou 47 blocos `tool_call` em `content` com `toolCall` já correcto —
   * contar também o envelope nesse caso somaria a dobrar o número que esta
   * correcção existe para acertar.
   */
  it('não soma a dobrar quando os tool_calls já vêm como blocos de content', () => {
    const asBlocks = {
      role: 'assistant',
      content: [{ type: 'tool_call', name: 'Write', input: { path: '/a.tsx', body: 'x'.repeat(6000) } }],
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Write', arguments: bigArgs } }],
    }
    const report = inspectPayload(
      [{ role: 'system', content: 'sys' }, asBlocks],
      'sys', [], 'test-model', 2,
    )

    expect(report.byCategory.tool_call?.blocks).toBe(1)
  })

  it('não soma a dobrar o raciocínio quando já vem como bloco thinking', () => {
    const report = inspectPayload(
      [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'r'.repeat(4000) }],
          reasoning_content: 'r'.repeat(4000),
        },
      ],
      'sys', [], 'test-model', 2,
    )

    expect(report.byCategory.thinking?.blocks).toBe(1)
  })

  it('não conta nada quando o assistant não traz envelope', () => {
    const report = inspectPayload(
      [{ role: 'system', content: 'sys' }, { role: 'assistant', content: 'só texto' }],
      'sys', [], 'test-model', 2,
    )

    expect(report.estimatedInputTokensBreakdown.toolCall).toBe(0)
    expect(report.estimatedInputTokensBreakdown.thinking).toBe(0)
  })
})
