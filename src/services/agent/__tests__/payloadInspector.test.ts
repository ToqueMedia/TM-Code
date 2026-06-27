import { inspectPayload } from '../payloadInspector'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../contextBuilder/helpers'

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
})
