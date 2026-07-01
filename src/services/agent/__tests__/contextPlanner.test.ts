import { ContextPlannerError, parseContextPlanJson, planContextWithModel } from '../contextPlanner'
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

jest.mock('../byokRouting', () => ({
  byokAuxCompletion: jest.fn(),
}))

function diag(): RouterDiagnostics {
  return {
    url: 'https://test',
    appCheckPresent: false,
    httpStatus: 200,
  }
}

function completionEnvelope(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
  })
}

function completionEnvelopeWithMessage(message: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{ message }],
  })
}

function mockResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => undefined,
    },
    text: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

afterEach(() => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'fetch')
})

function installFetchMock(): jest.Mock {
  const fetchMock = jest.fn()
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    configurable: true,
    writable: true,
  })
  return fetchMock
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

describe('planContextWithModel', () => {
  test('retries the utility planner 3 times, then accepts valid JSON from the code model', async () => {
    const validPlan = JSON.stringify({
      taskDomain: 'billing_payment_ui',
      requiredCapabilities: ['modal_ui', 'account_profile_data'],
      minimumContextNeeded: 'summary',
      candidateContexts: ['project.package_map', 'ui_patterns', 'auth_database.provision'],
      selectedContexts: ['project.package_map', 'ui_patterns'],
      rejectedContexts: ['auth_database.provision'],
      toolGroups: ['FILE_OPS'],
      fallbackRisk: 'medium',
      reason: 'billing/payment modal work needs UI and project map',
      confidence: 'high',
    })
    const fetchMock = installFetchMock()
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope('not json')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope('{"selectedContexts":[]}')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope(validPlan)) as never)

    const out = await planContextWithModel(
      'Rota: /billing ou /payments. Detectar NIF e abrir modal.',
      'frontend_ui',
      false,
    )

    expect(out.source).toBe('model')
    expect(out.modelTier).toBe('code')
    expect(out.attempts).toBe(4)
    expect(out.fallbackReason).toContain('3 attempts')
    expect(out.plan.selectedContexts).toEqual(['project.package_map', 'ui_patterns'])
    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const call of fetchMock.mock.calls.slice(0, 3)) {
      expect((call[1] as RequestInit).headers).toMatchObject({ 'X-Request-Type': 'context-planner' })
    }
    const codeRequest = fetchMock.mock.calls[3]?.[1] as RequestInit
    expect((codeRequest.headers as Record<string, string>)['X-Request-Type']).toBeUndefined()
    expect(JSON.parse(String(codeRequest.body)).model).toBe('tm-active-model')
  })

  test('fails the planner when utility retries and code-model fallback all return invalid JSON', async () => {
    installFetchMock()
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)

    await expect(
      planContextWithModel('Implementar modal de NIF em /billing.', 'frontend_ui', false),
    ).rejects.toBeInstanceOf(ContextPlannerError)
  })

  test('accepts planner text returned as OpenAI content parts', async () => {
    const validPlan = JSON.stringify({
      taskDomain: 'billing_payment_ui',
      requiredCapabilities: ['modal_ui'],
      selectedContexts: ['ui_patterns'],
      reason: 'content parts response',
      confidence: 'high',
    })
    installFetchMock()
      .mockResolvedValueOnce(mockResponse(completionEnvelopeWithMessage({
        content: [{ type: 'text', text: validPlan }],
      })) as never)

    const out = await planContextWithModel(
      'Implementar modal de NIF em /billing.',
      'frontend_ui',
      false,
    )

    expect(out.modelTier).toBe('utility')
    expect(out.plan.selectedContexts).toEqual(['ui_patterns'])
  })

  test('accepts planner text returned as Responses output_text', async () => {
    const validPlan = JSON.stringify({
      taskDomain: 'billing_payment_ui',
      requiredCapabilities: ['modal_ui'],
      selectedContexts: ['project.package_map'],
      reason: 'responses style',
      confidence: 'high',
    })
    installFetchMock()
      .mockResolvedValueOnce(mockResponse(JSON.stringify({ output_text: validPlan })) as never)

    const out = await planContextWithModel(
      'Implementar modal de NIF em /billing.',
      'frontend_ui',
      false,
    )

    expect(out.modelTier).toBe('utility')
    expect(out.plan.selectedContexts).toEqual(['project.package_map'])
  })

  test('uses the active BYOK code model for the code fallback', async () => {
    const validPlan = JSON.stringify({
      taskDomain: 'billing_payment_ui',
      requiredCapabilities: ['modal_ui'],
      minimumContextNeeded: 'summary',
      candidateContexts: ['project.package_map', 'ui_patterns'],
      selectedContexts: ['project.package_map'],
      rejectedContexts: ['ui_patterns'],
      toolGroups: ['FILE_OPS'],
      fallbackRisk: 'medium',
      reason: 'fallback through the active code model',
      confidence: 'high',
    })
    const fetchMock = installFetchMock()
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)
      .mockResolvedValueOnce(mockResponse(completionEnvelope('')) as never)

    const [{ useChatStore }, { useByokStore }, { byokAuxCompletion }] = await Promise.all([
      import('../../../stores/chatStore'),
      import('../../../stores/byokStore'),
      import('../byokRouting'),
    ])
    const byokMock = byokAuxCompletion as jest.Mock
    byokMock.mockResolvedValueOnce(validPlan)

    const sessionId = useChatStore.getState().createSession('/tmp/project')
    useChatStore.setState(state => {
      const sessions = new Map(state.sessions)
      const session = sessions.get(sessionId)
      if (session) {
        sessions.set(sessionId, {
          ...session,
          byokSnapshot: {
            providerId: 'custom',
            modelId: 'zai-org/GLM-5.2',
            baseURL: 'https://api.parasail.io/v1',
            custom: true,
          },
        })
      }
      return { sessions, activeSessionId: sessionId }
    })
    useByokStore.setState({ enabled: true })

    try {
      const out = await planContextWithModel(
        'Rota: /billing ou /payments. Detectar NIF e abrir modal.',
        'frontend_ui',
        false,
      )

      expect(out.modelTier).toBe('code')
      expect(out.plan.selectedContexts).toEqual(['project.package_map'])
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(byokMock).toHaveBeenCalledTimes(1)
      expect(byokMock.mock.calls[0]?.[0]).toMatchObject({
        providerId: 'custom',
        modelId: 'zai-org/GLM-5.2',
        baseURL: 'https://api.parasail.io/v1',
      })
      expect(byokMock.mock.calls[0]?.[1]).toMatchObject({
        jsonObject: false,
        temperature: 0,
      })
    } finally {
      useByokStore.setState({ enabled: false })
      useChatStore.setState({
        sessions: new Map(),
        activeSessionId: null,
        conversationHistory: [],
      })
    }
  })
})
