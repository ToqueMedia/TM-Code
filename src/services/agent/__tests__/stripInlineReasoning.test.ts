/**
 * Strip de raciocínio INLINE nas respostas não-streaming (auditoria 2026-07-28).
 *
 * Modelos não-streaming metem `<think>…</think>` dentro do `message.content` em
 * vez de o separarem em `reasoning_content`. O strip existia só no gerador de
 * mensagens de commit, portanto todas as outras one-shots — melhoria de prompt,
 * autocompletar, e sobretudo os SUMÁRIOS DE COMPACTAÇÃO — podiam levar
 * raciocínio cru para a UI ou de volta para o histórico do modelo.
 */
import { stripInlineReasoning, extractAssistantTextFromCompletion } from '../completionText'
import { formatCompactSummary } from '../compact/prompt'

describe('stripInlineReasoning', () => {
  it('remove blocos <think> fechados', () => {
    expect(stripInlineReasoning('<think>hmm, deixa ver</think>A resposta é 42.'))
      .toBe('A resposta é 42.')
  })

  it('trata <thought> (dialeto Gemini) tal como <think>', () => {
    expect(stripInlineReasoning('<thought>a analisar</thought>Feito.')).toBe('Feito.')
  })

  it('fecho SEM abertura: tudo o que vem antes é raciocínio', () => {
    // O caso real do leak: o stream corta a etiqueta de abertura.
    expect(stripInlineReasoning('divagação sem fim</think>Resposta final.'))
      .toBe('Resposta final.')
  })

  it('não mexe em texto sem raciocínio', () => {
    expect(stripInlineReasoning('Só uma resposta normal.')).toBe('Só uma resposta normal.')
  })

  it('vários blocos são todos removidos', () => {
    expect(stripInlineReasoning('<think>a</think>X<think>b</think>Y')).toBe('XY')
  })
})

describe('extractAssistantTextFromCompletion', () => {
  it('limpa o raciocínio das one-shots (era o buraco: só commits estavam cobertos)', () => {
    const text = extractAssistantTextFromCompletion({
      choices: [{ message: { content: '<think>vou escolher um nome</think>feat: adiciona login' } }],
    })
    expect(text).toBe('feat: adiciona login')
  })

  it('limpa também o caminho de topo (envelopes estilo Responses)', () => {
    expect(extractAssistantTextFromCompletion({ output_text: '<think>x</think>ok' })).toBe('ok')
  })
})

describe('formatCompactSummary', () => {
  it('nunca deixa raciocínio entrar no sumário — ele volta para o HISTÓRICO', () => {
    // O pior sítio para um leak: o sumário É a memória da conversa toda, e um
    // <think> lá dentro contamina todos os turnos seguintes.
    const out = formatCompactSummary('<think>a decidir o que resumir</think><summary>Fizemos X e Y.</summary>')
    expect(out).not.toContain('<think>')
    expect(out).not.toContain('a decidir o que resumir')
    expect(out).toContain('Fizemos X e Y.')
  })
})
