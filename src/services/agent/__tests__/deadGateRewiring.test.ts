/**
 * Os portões de segurança não podem viver pendurados no ToolsetSelector.
 *
 * O selector é `null` em todos os runs reais: nasce só com `enforceReadOnly`,
 * que exige `auxiliarySelection.readOnly === true`, e nada o produz — o
 * classificador local devolve apenas `vision`/`bugfix_local` e os dois
 * produtores de `intentOverride` (/init e o preflight de TMS) passam
 * `readOnly: false`. Medido na auditoria de 2026-07-29.
 *
 * Dois portões estavam pendurados nele e portanto mortos:
 *
 *   1. Confinação de escrita do `project_bootstrap` — o /init podia escrever
 *      QUALQUER ficheiro do projecto, e como `markTmsWriteAttempt` vivia no
 *      mesmo ramo, o diagnóstico de falha afirmava sempre "terminou antes de
 *      tentar escrever TMS.md" mesmo quando havia tentativa.
 *   2. Bloqueio de tools destrutivas em runs read-only — um sub-agente criado
 *      com `createLightweight({ readOnly: true })` (o `verify`, o /review)
 *      não tinha bloqueio nenhum ao nível do loop.
 *
 * As asserções são estruturais, sobre o texto da fonte: os dois caminhos vivem
 * dentro de closures de classes grandes sem ponto de injeção. Não provam o
 * comportamento — provam que os portões deixaram de depender de um objeto que
 * nunca existe, que é a condição para voltarem a valer algo.
 */
describe('portões de segurança fora do ToolsetSelector', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = jest.requireActual('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realPath = jest.requireActual('path') as typeof import('path')
  const read = (rel: string): string =>
    realFs.readFileSync(realPath.resolve(__dirname, '..', rel), 'utf8')

  const agentService = read('agentService.ts')
  const query = read('query.ts')

  it('a confinação de escrita do bootstrap olha para a FASE, não para o perfil do selector', () => {
    expect(agentService).toContain(
      'if (this.currentExecutionPhase === "project_bootstrap" && WRITE_TOOLS.has(canonicalName)) {',
    )
    // O que não pode voltar: a condição do portão a ler um selector null.
    expect(agentService).not.toContain('selector?.getProfile() === "project_bootstrap"')
  })

  it('a fase do run é publicada no campo que o bridge do executor lê', () => {
    expect(agentService).toContain('private currentExecutionPhase:')
    expect(agentService).toContain('this.currentExecutionPhase = executionPhase;')
  })

  it('o bloqueio de tools destrutivas aceita a política sem selector', () => {
    expect(query).toContain(
      'if ((readOnlyRun || toolsetSelector?.isReadOnly()) && DESTRUCTIVE_TOOLS.has(canonicalToolName(tc.name))) {',
    )
    // `noteDeniedToolName` tem de ser opcional aqui: com selector null, um
    // acesso direto rebentaria exatamente no caminho que devia bloquear.
    expect(query).toContain('toolsetSelector?.noteDeniedToolName(tc.name);')
  })

  it('a política read-only é passada ao loop pelo agentService', () => {
    expect(agentService).toContain(
      'readOnlyRun: this.lightweightOptions?.readOnly === true || enforceReadOnly,',
    )
  })

  it('o guard anti-adiamento respeita a política read-only', () => {
    // Sem isto, um run read-only levava a mensagem "aplica o edit agora"
    // depois de lhe termos negado as tools de escrita.
    const guard = query.slice(
      query.indexOf('mutable original_task attempted to stop without file edit') - 900,
      query.indexOf('mutable original_task attempted to stop without file edit'),
    )
    expect(guard).toContain('!readOnlyRun &&')
  })

  it('o perfil pós-bootstrap sem chamadores foi apagado, não deixado a parecer vivo', () => {
    expect(agentService).not.toContain('postTmsBootstrapToolProfile')
    expect(read('mainDispatch.ts')).not.toContain('clearPostTmsBootstrapToolProfile')
  })
})
