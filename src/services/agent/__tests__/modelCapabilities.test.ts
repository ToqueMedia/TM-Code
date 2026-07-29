import { effectiveCapability } from '../modelProfiles'

/**
 * As capacidades de um modelo não podem ser herdadas de OUTRO modelo.
 *
 * `MODEL_PROFILES` é uma lista fixa no código, enquanto o resto do sistema é
 * config-driven: adicionar um modelo é editar a KV do data-plane. Quando o nome
 * servido não estava na tabela, o código caía em `getProfileForPlan()` — que
 * devolve SEMPRE o perfil do MiMo — e o modelo novo ficava com a visão, o
 * pensamento e a pesquisa nativa dele.
 *
 * Consequências medidas na auditoria de 2026-07-29:
 *   · imagens enviadas como `image_url` a um modelo que não as lê (o pipeline
 *     de visão decide por `supportsAttachments`);
 *   · o prompt a anunciar "podes pesquisar a web directamente, sem tool call"
 *     a um modelo sem pesquisa nativa — e o modelo a confiar, deixando de
 *     chamar a única tool que lhe dava acesso real à web.
 *
 * O data-plane passa a declarar `X-Model-Capabilities`
 * (`vision=1;search=0;thinking=toggleable`) a partir da config KV, e a
 * distinção que estes testes protegem é a de três estados: declarado-sim,
 * declarado-não, e NÃO DECLARADO — este último é o único em que o perfil local
 * ainda manda.
 */
describe('effectiveCapability', () => {
  it('o servidor a declarar `true` vence um perfil local que diz false', () => {
    expect(effectiveCapability(true, false)).toBe(true)
  })

  it('o servidor a declarar `false` vence um perfil local que diz true', () => {
    // Este é o caso que causava dano: o fallback dizia "tem visão" e a imagem
    // seguia para um modelo que não a lê.
    expect(effectiveCapability(false, true)).toBe(false)
  })

  it('sem declaração (null), o perfil local manda', () => {
    expect(effectiveCapability(null, true)).toBe(true)
    expect(effectiveCapability(null, false)).toBe(false)
  })

  it('sem declaração (undefined), o perfil local manda', () => {
    expect(effectiveCapability(undefined, true)).toBe(true)
    expect(effectiveCapability(undefined, false)).toBe(false)
  })

  it('perfil local ausente é tratado como não-suportado, não como suportado', () => {
    // `supportsAttachments` é opcional em perfis parciais; a ausência não pode
    // ser lida como permissão.
    expect(effectiveCapability(null, undefined)).toBe(false)
    expect(effectiveCapability(undefined, undefined)).toBe(false)
  })

  it('`false` declarado NÃO é confundido com "não declarado"', () => {
    // A armadilha óbvia era escrever `declared || profileValue`, que trata
    // `false` como ausência e reintroduz exactamente a herança que isto corrige.
    expect(effectiveCapability(false, true)).not.toBe(effectiveCapability(null, true))
  })
})

/**
 * O parse do header vive dentro de `applyStreamingResponseHeaders`, numa
 * closure sem ponto de injeção. A asserção é estrutural sobre a fonte e digo-o
 * à cabeça: prova que o header é LIDO e passado ao store, não o comportamento
 * ponta-a-ponta.
 */
describe('X-Model-Capabilities chega ao store', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = jest.requireActual('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realPath = jest.requireActual('path') as typeof import('path')
  const source = realFs.readFileSync(
    realPath.resolve(__dirname, '../agentService.ts'),
    'utf8',
  )

  it('o header é lido', () => {
    expect(source).toContain('headers.get("X-Model-Capabilities")')
  })

  it('o resultado é passado ao setModelInfo', () => {
    expect(source).toContain('vision: declaredCapabilities.vision')
    expect(source).toContain('search: declaredCapabilities.search')
  })

  it('o header presente conta como informação de modelo', () => {
    // Sem isto, um header de capacidades sozinho (sem X-TM-Model) era ignorado.
    expect(source).toContain('capabilitiesRaw !== null;')
  })
})
