const mockGetIdToken = jest.fn().mockResolvedValue(null)

jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getIdToken: mockGetIdToken,
    }),
  },
  getAppCheckHeader: jest.fn().mockResolvedValue({}),
}))

jest.mock('../../../utils/devUrls', () => ({
  resolveAIWorkerUrl: () => 'http://worker.test',
}))

import { classifyIntent, hasExplicitNoEditIntent, summarizeIntentHistory } from '../intentRouter'

const originalFetch = global.fetch

beforeEach(() => {
  mockGetIdToken.mockReset()
  mockGetIdToken.mockResolvedValue(null)
  global.fetch = originalFetch
})

afterAll(() => {
  global.fetch = originalFetch
})

describe('intentRouter local no-edit safety', () => {
  it('detects Portuguese no-edit instructions deterministically', () => {
    expect(hasExplicitNoEditIntent('Não editar nada')).toBe(true)
    expect(hasExplicitNoEditIntent('sem editar, apenas confirme')).toBe(true)
  })

  it('detects English no-edit instructions deterministically', () => {
    expect(hasExplicitNoEditIntent("don't edit, just inspect")).toBe(true)
    // 2026-07-17: "read-only" SOLTO deixou de classificar — quase sempre
    // descreve um artefacto ("modal read-only"), não uma instrução ao agente
    // (falso positivo real: "Adicione um modal para listar o perfil read-only"
    // negou create/edit ao run inteiro). Instruções genuínas usam imperativos.
    expect(hasExplicitNoEditIntent('read-only review')).toBe(false)
    expect(hasExplicitNoEditIntent('Adicione um modal para listar o perfil read-only da pessoa')).toBe(false)
    expect(hasExplicitNoEditIntent('do not edit anything, read-only review')).toBe(true)
  })

  it('does not classify ordinary edit requests as no-edit', () => {
    expect(hasExplicitNoEditIntent('corrija o bug no editor')).toBe(false)
    expect(hasExplicitNoEditIntent('edit the failing test')).toBe(false)
  })

  it('forces read-only before auth/fetch can fail', async () => {
    const intent = await classifyIntent('Não editar nada')
    expect(intent).toMatchObject({
      profile: 'analysis_readonly',
      readOnly: true,
      requiresMutation: false,
      source: 'keyword',
      confidence: 'high',
    })
  })

  it('summarizes recent text history for contextual continuation routing', () => {
    const history = summarizeIntentHistory([
      { role: 'user', content: 'Implementar as secções OurExperience e OurClients.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: 'Vou começar por OurExperience.' },
          { type: 'tool_call', id: 'call_1', name: 'read_file', arguments: '{"file_path":"src/App.tsx"}' },
          { type: 'tool_result', toolCallId: 'call_1', content: 'large file content omitted' },
        ],
      },
    ])

    expect(history).toEqual([
      { role: 'user', text: 'Implementar as secções OurExperience e OurClients.' },
      { role: 'assistant', text: 'Vou começar por OurExperience. [tool_call read_file]' },
    ])
  })

  it('sends recent conversation to the model router and parses requiresMutation', async () => {
    mockGetIdToken.mockResolvedValue('token')
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: jest.fn().mockReturnValue(null) },
      text: jest.fn().mockResolvedValue(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                profile: 'frontend_ui',
                readOnly: false,
                requiresMutation: true,
                confidence: 'high',
                reason: 'continue previous UI implementation',
              }),
            },
          },
        ],
      })),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const intent = await classifyIntent('Continue onde paraste', {
      conversationHistory: [
        { role: 'user', content: 'Implementar as secções de suporte na landing page.' },
        { role: 'assistant', content: 'Vou continuar com OurExperience.' },
      ],
    })

    expect(intent).toMatchObject({
      profile: 'frontend_ui',
      readOnly: false,
      requiresMutation: true,
      source: 'model',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const routerPayload = JSON.parse(body.messages[1].content)
    expect(routerPayload).toMatchObject({
      currentUserMessage: 'Continue onde paraste',
      hasImage: false,
      recentConversation: [
        { role: 'user', text: 'Implementar as secções de suporte na landing page.' },
        { role: 'assistant', text: 'Vou continuar com OurExperience.' },
      ],
    })
  })

  it('falls back without local intent inference when the router is unavailable', async () => {
    mockGetIdToken.mockResolvedValue(null)

    const intent = await classifyIntent('Continue onde paraste')

    expect(intent).toMatchObject({
      profile: 'bugfix_local',
      readOnly: false,
      requiresMutation: false,
      source: 'fallback',
    })
  })
})
