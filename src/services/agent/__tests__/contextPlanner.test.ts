import { parseContextPlanJson } from '../contextPlanner'
import type { RouterDiagnostics } from '../contextBuilder/auxiliaryRegistry'

// contextPlanner imports firebaseAuth (for App Check on the planner request),
// which reads import.meta.env at module load — Jest cannot parse import.meta.
// Match the repo's established mock shape (see agentServiceRequestType.test.ts).
jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getIdToken: jest.fn().mockResolvedValue('mock-firebase-token'),
    }),
  },
  getAppCheckHeader: jest.fn().mockResolvedValue({ 'X-Firebase-AppCheck': 'mock-appcheck' }),
}))

function diag(): RouterDiagnostics {
  return {
    url: 'https://test',
    appCheckPresent: false,
    httpStatus: 200,
  }
}

describe('parseContextPlanJson', () => {
  test('parses a valid JSON object', () => {
    const d = diag()
    const out = parseContextPlanJson(
      JSON.stringify({
        taskDomain: 'bugfix_local',
        requiredCapabilities: ['file_edit'],
        minimumContextNeeded: 'index',
        candidateContexts: ['project.structure_overview'],
        selectedContexts: [],
        toolGroups: ['FILE_OPS'],
        fallbackRisk: 'low',
        reason: 'simple bugfix',
        confidence: 'high',
      }),
      d,
    )
    expect(out).not.toBeNull()
    expect(out!.source).toBe('model')
    expect(out!.plan.taskDomain).toBe('bugfix_local')
    expect(out!.plan.selectedContexts).toEqual([])
    // candidate not selected → surfaces as rejected
    expect(out!.plan.rejectedContexts).toEqual(['project.structure_overview'])
    expect(d.parseError).toBeUndefined()
  })

  test('parses JSON wrapped in markdown fences', () => {
    const out = parseContextPlanJson(
      '```json\n{"taskDomain":"design_system_ui","requiredCapabilities":[],"selectedContexts":[]}\n```',
      diag(),
    )
    expect(out).not.toBeNull()
    expect(out!.plan.taskDomain).toBe('design_system_ui')
  })

  test('parses JSON after a thinking block', () => {
    const out = parseContextPlanJson(
      '<think>\nplanning\n</think>\n\n{"taskDomain":"bugfix_local","requiredCapabilities":[],"selectedContexts":[]}',
      diag(),
    )
    expect(out).not.toBeNull()
    expect(out!.plan.taskDomain).toBe('bugfix_local')
  })

  test('repairs a trailing comma on a single attempt', () => {
    const d = diag()
    const out = parseContextPlanJson(
      '{"taskDomain":"bugfix_local","selectedContexts":["project.entrypoints",],"reason":"x",}',
      d,
    )
    expect(out).not.toBeNull()
    expect(out!.plan.selectedContexts).toEqual(['project.entrypoints'])
    expect(d.parseError).toBeUndefined()
  })

  test('rejects prose with no JSON object (fallback)', () => {
    const d = diag()
    const out = parseContextPlanJson('Sorry, I cannot help with that.', d)
    expect(out).toBeNull()
    expect(d.parseError).toMatch(/no JSON object found/)
  })

  test('reports empty planner output distinctly', () => {
    const d = diag()
    const out = parseContextPlanJson('', d)
    expect(out).toBeNull()
    expect(d.parseError).toBe('empty content from context planner')
  })

  test('reports truncated planner JSON distinctly', () => {
    const d = diag()
    const out = parseContextPlanJson('<think>planning</think>\n{"taskDomain":"bugfix_local"', d)
    expect(out).toBeNull()
    expect(d.parseError).toMatch(/incomplete JSON object/)
  })

  test('rejects broken JSON syntax that repair cannot fix (fallback)', () => {
    const d = diag()
    const out = parseContextPlanJson('{"taskDomain":"bugfix_local","selectedContexts":[unterminated', d)
    expect(out).toBeNull()
    expect(d.parseError).toBeDefined()
  })

  test('rejects schema-invalid output: missing taskDomain (fallback)', () => {
    const d = diag()
    // Valid JSON, but taskDomain missing → schema gate trips.
    const out = parseContextPlanJson('{"selectedContexts":[]}', d)
    expect(out).toBeNull()
    expect(d.parseError).toMatch(/schema validation failed/)
  })

  test('rejects schema-invalid output: selectedContexts not an array (fallback)', () => {
    const d = diag()
    const out = parseContextPlanJson(
      '{"taskDomain":"bugfix_local","selectedContexts":"project.entrypoints"}',
      d,
    )
    expect(out).toBeNull()
    expect(d.parseError).toMatch(/schema validation failed/)
  })

  test('design-system refactor fixture matches the expected plan', () => {
    const out = parseContextPlanJson(
      JSON.stringify({
        taskDomain: 'design_system_ui',
        requiredCapabilities: ['semantic_tokens', 'component_patterns', 'relative_time_formatting'],
        minimumContextNeeded: 'summary',
        candidateContexts: [
          'design_system.semantic_tokens',
          'design_system.component_patterns',
          'project.entrypoints',
          'project.structure_overview',
        ],
        selectedContexts: ['design_system.semantic_tokens', 'design_system.component_patterns'],
        rejectedContexts: ['project.entrypoints'],
        toolGroups: ['FILE_OPS'],
        fallbackRisk: 'low',
        reason: 'refactor session list with semantic tokens and relative dates',
        confidence: 'high',
      }),
      diag(),
    )
    expect(out).not.toBeNull()
    expect(out!.plan.taskDomain).toBe('design_system_ui')
    expect(out!.plan.requiredCapabilities).toEqual([
      'semantic_tokens',
      'component_patterns',
      'relative_time_formatting',
    ])
    expect(out!.plan.selectedContexts).toEqual([
      'design_system.semantic_tokens',
      'design_system.component_patterns',
    ])
    // project.entrypoints (explicit) + project.structure_overview (derived)
    // are rejected — entrypoints only loads if the component cannot be located.
    expect(out!.plan.rejectedContexts).toEqual([
      'project.entrypoints',
      'project.structure_overview',
    ])
  })
})
