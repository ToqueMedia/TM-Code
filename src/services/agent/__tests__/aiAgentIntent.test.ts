import { detectAiAgentIntent, buildAiAgentPlatformLine } from '../aiAgentIntent'

describe('detectAiAgentIntent', () => {
  // ── no-op cases ──────────────────────────────────────────────
  it('returns empty for empty input', () => {
    const r = detectAiAgentIntent('')
    expect(r.namedModels).toEqual([])
    expect(r.isConversational).toBe(false)
  })

  it('returns empty for plain CRUD prompts', () => {
    const r = detectAiAgentIntent('Build a todo app with React and SQLite')
    expect(r.namedModels).toEqual([])
    expect(r.isConversational).toBe(false)
  })

  // ── named LLM detection ──────────────────────────────────────
  it('detects Mercury 2 (BugHunterKimi case)', () => {
    const r = detectAiAgentIntent('alimentado com o modelo Mercury 2 que recebe os bugs')
    expect(r.namedModels).toContain('Mercury 2')
  })

  it('detects GPT-4', () => {
    expect(detectAiAgentIntent('use GPT-4 for summarization').namedModels).toContain('GPT-4')
  })

  it('detects Claude', () => {
    expect(detectAiAgentIntent('integrate with Claude').namedModels).toContain('Claude')
  })

  it('detects Gemini', () => {
    expect(detectAiAgentIntent('using Gemini Pro').namedModels).toContain('Gemini')
  })

  it('detects multiple models in the same prompt', () => {
    const r = detectAiAgentIntent('compare GPT-4 vs Claude on this task')
    expect(r.namedModels).toContain('GPT-4')
    expect(r.namedModels).toContain('Claude')
  })

  it('does not double-list the same canonical model from multiple alias hits', () => {
    const r = detectAiAgentIntent('use claude 4 and claude opus together')
    expect(r.namedModels.filter((m) => m === 'Claude')).toHaveLength(1)
  })

  // ── word boundary ────────────────────────────────────────────
  it('does NOT trigger on substring matches (mercury inside chemistry app)', () => {
    // "mercury thermometer" — "mercury" is its own token, so it WILL match
    // by design (no domain context). Test the inverse: "mercuryapp" should NOT match.
    expect(detectAiAgentIntent('mercuryapp is the name').namedModels).toEqual([])
  })

  // ── conversational keywords ─────────────────────────────────
  it('detects "agente de IA" (Portuguese)', () => {
    expect(detectAiAgentIntent('uma plataforma que é um agente de IA').isConversational).toBe(true)
  })

  it('detects "AI agent" (English)', () => {
    expect(detectAiAgentIntent('build an AI agent that helps users').isConversational).toBe(true)
  })

  it('detects "chatbot"', () => {
    expect(detectAiAgentIntent('I need a chatbot for my site').isConversational).toBe(true)
  })

  it('detects "chat" alone', () => {
    expect(detectAiAgentIntent('add a chat feature').isConversational).toBe(true)
  })

  it('detects "conversational"', () => {
    expect(detectAiAgentIntent('build a conversational UI').isConversational).toBe(true)
  })

  // ── BugHunterKimi exact prompt ──────────────────────────────
  it('detects both signals from the BugHunterKimi initial prompt', () => {
    const prompt =
      'Vamos criar uma plataforma que recebe dos testers (previamente registado com #auth-google) ' +
      'informações de bugs de uma aplicação. Essa plataforma é um agente de IA alimentado com o ' +
      'modelo da Inception, o Mercury 2 que recebe os bugs informados, guarda em base de dados ' +
      'a informação do user e uma descrição do bug informado de 100 palavras provenientes do ' +
      'agente de IA e oferece 500 kz por bug novo reportado.'
    const r = detectAiAgentIntent(prompt)
    expect(r.namedModels).toContain('Mercury 2')
    expect(r.isConversational).toBe(true)
  })
})

describe('buildAiAgentPlatformLine', () => {
  it('returns null when no signal detected', () => {
    expect(buildAiAgentPlatformLine({ namedModels: [], isConversational: false })).toBeNull()
  })

  it('builds a chat-UX directive when conversational flag is set', () => {
    const line = buildAiAgentPlatformLine({ namedModels: [], isConversational: true })
    expect(line).toContain('CHAT-based UX')
    expect(line).toContain('NOT a form-based one')
  })

  it('mentions the named model in the backend integration clause', () => {
    const line = buildAiAgentPlatformLine({ namedModels: ['Mercury 2'], isConversational: false })
    expect(line).toContain('Mercury 2 API')
  })

  it('requires LLM keys to stay server-side', () => {
    const line = buildAiAgentPlatformLine({ namedModels: ['GPT-4'], isConversational: true })
    expect(line).toContain('SERVER-SIDE')
    expect(line).toContain('frontend NEVER calls the model directly')
  })

  it('requires a dedicated Implementation Phase named for the model', () => {
    const line = buildAiAgentPlatformLine({ namedModels: ['Mercury 2'], isConversational: true })
    expect(line).toContain('Model integration')
  })

  it('lists multiple models in the integration clause', () => {
    const line = buildAiAgentPlatformLine({ namedModels: ['GPT-4', 'Claude'], isConversational: false })
    expect(line).toContain('GPT-4 / Claude')
  })
})
