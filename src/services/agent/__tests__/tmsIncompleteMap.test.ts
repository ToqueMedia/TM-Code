import { missingTmsSections } from '../tmsBootstrap'

/**
 * Completeness do template `/init` — não é validade em runtime.
 * Um TMS.md livre continua a ser memória válida (paridade CLAUDE.md).
 */
describe('missingTmsSections', () => {
  /** O TMS.md real do momenu-fact, reduzido aos seus cabeçalhos. */
  const REAL_INVALID_TMS = [
    '# TMS.md',
    '## Project Analysis',
    '### Visão Geral do Diretório',
    '## Memory',
    '### Milestones',
    '### Decisions',
    '### Pending Tasks',
    '## Custom Instructions',
  ].join('\n')

  it('nomeia as secções que faltam ao TMS real desta sessão', () => {
    const missing = missingTmsSections(REAL_INVALID_TMS)

    // As quatro que explicam o desperdício medido: sem estrutura, entrypoints,
    // comandos nem regras, o agente descobre o layout à força.
    expect(missing).toContain('structure')
    expect(missing).toContain('entrypoints')
    expect(missing).toContain('commands')
    expect(missing).toContain('agent rules')
    // E as de proveniência, que dizem se o mapa é de confiar.
    expect(missing).toContain('lastgeneratedat')
    expect(missing).toContain('sourcefilesused')
  })

  it('a "Visão Geral do Diretório" conta como overview — acentos incluídos', () => {
    // Se a normalização não tirasse acentos, `visao geral` nunca casaria com
    // `Visão Geral` e o overview apareceria como ausente estando presente.
    expect(missingTmsSections(REAL_INVALID_TMS)).not.toContain('overview')
  })

  it('um TMS completo não reporta nada em falta', () => {
    const complete = [
      '# TMS.md',
      '## Overview', '## Stack', '## Commands', '## Structure', '## Entrypoints',
      '## Project Patterns', '## Agent Rules', '## Confirmed', '## Inferred',
      '## Pending Confirmation', '## lastGeneratedAt', '## sourceFilesUsed',
    ].join('\n')

    expect(missingTmsSections(complete)).toEqual([])
  })

  it('aceita os aliases em português', () => {
    const pt = [
      '# TMS.md',
      '## Visao Geral', '## Stack', '## Comandos', '## Estrutura', '## Entrypoints',
      '## Padroes do Projecto', '## Regras para o Agente', '## Confirmed', '## Inferred',
      '## Pending Confirmation', '## lastGeneratedAt', '## sourceFilesUsed',
    ].join('\n')

    expect(missingTmsSections(pt)).toEqual([])
  })

  it('um ficheiro vazio reporta TODAS as secções, não zero', () => {
    // O caminho perigoso é o inverso: um parser que não encontra cabeçalhos
    // nenhuns e conclui "está tudo bem".
    expect(missingTmsSections('').length).toBeGreaterThanOrEqual(12)
  })
})
