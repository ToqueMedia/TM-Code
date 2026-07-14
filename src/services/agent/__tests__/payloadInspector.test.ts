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

  it('separates auto-loaded sections from real request_context loads', () => {
    const selection = selectAuxiliaries('bugfix_local', 'audit MCP routing')
    selection.modelRequestedContextSections = ['project.docs_full', 'project.structure_full']
    selection.requestContextToolCalls = 2
    selection.requestContextSectionsLoaded = ['project.structure_full']
    selection.requestedButNotLoadedSections = ['project.docs_full']
    selection.requestContextSelectionReason = {
      'project.structure_full': 'loaded project/structure_full; fallback for broad architecture',
    }
    selection.requestContextCostTier = { 'project.structure_full': 'high' }
    selection.requestContextFallbackUsed = true
    selection.requestContextFallbackFrom = ['agent_runtime.mcp_routing']
    selection.requestContextFallbackTo = ['project.structure_full']

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
    expect(report.modelRequestedContextSections).toEqual(['project.docs_full', 'project.structure_full'])
    expect(report.requestContextToolCalls).toBe(2)
    expect(report.requestContextSectionsLoaded).toEqual(['project.structure_full'])
    expect(report.requestContextSelectionReason['project.structure_full']).toContain('loaded')
    expect(report.requestContextCostTier['project.structure_full']).toBe('high')
    expect(report.requestContextFallbackUsed).toBe(true)
    expect(report.requestContextFallbackFrom).toEqual(['agent_runtime.mcp_routing'])
    expect(report.requestContextFallbackTo).toEqual(['project.structure_full'])
    expect(report.requestedButNotLoadedSections).toEqual(['project.docs_full'])
    expect(report.requestedContextSections).toEqual(['project.structure_full'])
  })
})
