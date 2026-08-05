/**
 * Os portões de segurança não podem viver pendurados no ToolsetSelector.
 *
 * O selector é `null` em todos os runs reais: nasce só com `enforceReadOnly`,
 * que exige `auxiliarySelection.readOnly === true`, e nada o produz — o
 * classificador local devolve apenas `vision`/`default_task` e os dois
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
    // CASE-INSENSITIVE de propósito (2026-07-30): a versão anterior procurava
    // `selector?.` em minúsculas e por isso NÃO via `currentToolsetSelector?.`
    // — o auto-apply do TMS.md ficou pendurado num selector null durante toda
    // a migração de 07-29 sem que este guarda desse por isso. Um teste que só
    // apanha a grafia que o autor tinha à frente não é um guarda.
    expect(agentService).not.toMatch(/[sS]elector\?\.getProfile\(\) === "project_bootstrap"/)
  })

  it('nenhum portão sobra pendurado no selector', () => {
    // Varredura genérica: qualquer leitura do selector numa CONDIÇÃO é um
    // portão morto por construção enquanto o selector for null em todo o lado.
    const suspicious = [agentService, query].flatMap(src =>
      src.split('\n').filter(line =>
        /[sS]elector\?\./.test(line) && /(if\s*\(|&&|\|\||\? )/.test(line),
      ),
    )
    expect(suspicious).toEqual([])
  })

  it('a fase do run é publicada no campo que o bridge do executor lê', () => {
    expect(agentService).toContain('private currentExecutionPhase:')
    expect(agentService).toContain('this.currentExecutionPhase = executionPhase;')
  })

  it('o bloqueio de tools destrutivas corre só sobre a política', () => {
    // O ramo `|| toolsetSelector?.isReadOnly()` saiu com a classe (07-30):
    // era uma alternativa que nunca podia ser verdadeira. Fica a flag, que é
    // o que sempre decidiu de facto.
    expect(query).toContain(
      'if (readOnlyRun && DESTRUCTIVE_TOOLS.has(canonicalToolName(tc.name))) {',
    )
    // A nota histórica no topo do query.ts NOMEIA o selector de propósito
    // (explica porque é que `readOnlyRun` existe) — por isso a varredura
    // ignora comentários e procura só uma leitura a sério.
    const codeLines = query
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(codeLines).not.toMatch(/toolsetSelector[?.]*\.\w/)
  })

  it('a política read-only é passada ao loop pelo agentService', () => {
    expect(agentService).toContain(
      'readOnlyRun: this.lightweightOptions?.readOnly === true || enforceReadOnly,',
    )
  })

  // O teste "o guard anti-adiamento respeita a política read-only" viveu aqui
  // até 2026-07-31. O guard que ele vigiava foi APAGADO: dependia de
  // `mutableTask`, órfão desde a remoção do Intent Router, portanto nunca
  // armava. Um teste cujo assunto deixou de existir não deve ser "arranjado"
  // para voltar a verde — a âncora (`query.indexOf(...)`) devolvia -1 e o
  // slice passava a apanhar uma região arbitrária do ficheiro, o que é pior
  // que não testar nada. Se o guard voltar, volta com o seu teste.
  it('o guard anti-adiamento não foi ressuscitado sem produtor para mutableTask', () => {
    expect(query).not.toContain('mutable original_task attempted to stop without file edit')
    // A varredura só falha se alguém reintroduzir uma LEITURA do sinal órfão;
    // as notas históricas que o nomeiam continuam permitidas.
    const codeLines = query
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(codeLines).not.toMatch(/\bmutableTask\b/)
  })

  it('o perfil pós-bootstrap sem chamadores foi apagado, não deixado a parecer vivo', () => {
    expect(agentService).not.toContain('postTmsBootstrapToolProfile')
    expect(read('mainDispatch.ts')).not.toContain('clearPostTmsBootstrapToolProfile')
  })

  // ── ToolSearch (2026-08-03): o sucessor do request_tools TEM produtor ──
  // A doutrina do toolPolicy.ts exige que qualquer selecção de tools volte
  // com um produtor real e um teste que prove que corre. O comportamento do
  // executor está no toolExecutor.test.ts ("deferred MCP tool definitions");
  // aqui fica a prova estrutural de que o meta-tool é INJECTADO e RESPONDIDO
  // nos dois runners — a combinação que faltou ao request_tools (definição
  // sem injecção = tool invisível; intercepção sem injecção = código morto).
  it('ToolSearch é injectado e interceptado no agentService (produtor real)', () => {
    expect(agentService).toContain('openaiTools.push(toolSearchDefinition());')
    expect(agentService).toContain('if (toolName === TOOL_SEARCH_NAME) {')
    // O bridge empurra para o array VIVO do run — sem isto a activação não
    // chega aos pedidos seguintes (query.ts envia `activeTools` por referência).
    expect(agentService).toContain('this.activeRunTools = openaiTools;')
  })

  it('ToolSearch é injectado e interceptado no parallelTaskRunner (espelho)', () => {
    const runner = read('parallelTasks/parallelTaskRunner.ts')
    expect(runner).toContain('openaiTools.push(toolSearchDefinition())')
    expect(runner).toContain('if (toolName === TOOL_SEARCH_NAME) {')
  })
})
