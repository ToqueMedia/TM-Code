import {
  detectProjectContextEvidence,
  evidenceOmittedAuxiliaries,
} from '../contextBuilder/projectEvidence'
import {
  applyEvidenceOmissions,
  applyRenderedTokenCounts,
  buildOnDemandIndex,
  selectAuxiliaries,
  BOUNDED_INLINE_CONTEXTS,
} from '../contextBuilder/auxiliaryRegistry'
import type { PackageSummary } from '../contextBuilder/types'

function pkg(deps: string[], truncatedRootDeps: string[] = deps.slice(0, 15)): PackageSummary {
  return {
    name: 'fixture',
    scripts: ['build'],
    dependencies: truncatedRootDeps,
    devDependencies: [],
    dependencyCount: deps.length,
    devDependencyCount: 0,
    workspaceDependencies: [],
    detectionDependencies: deps,
    packageManager: 'yarn',
  }
}

const BACKEND_TREE = `project/
  src/
    routes/
    db/
    services/
    index.ts
  package.json
  drizzle.config.ts`

const FRONTEND_TREE = `project/
  src/
    components/
    App.tsx
    index.css
  index.html
  package.json`

describe('detectProjectContextEvidence', () => {
  it('backend Express+Drizzle: sem superfície de UI, tema ou Chakra', () => {
    const ev = detectProjectContextEvidence({
      pkgSummary: pkg(['express', 'drizzle-orm', 'pg', 'zod']),
      treeString: BACKEND_TREE,
    })
    expect(ev.hasSourceFiles).toBe(true)
    expect(ev.hasUiSurface).toBe(false)
    expect(ev.hasThemeSurface).toBe(false)
    expect(ev.hasChakra).toBe(false)
  })

  it('app React com um index.css solto: UI sim, superfície de tema não', () => {
    const ev = detectProjectContextEvidence({
      pkgSummary: pkg(['react', 'react-dom']),
      treeString: FRONTEND_TREE,
    })
    expect(ev.hasUiSurface).toBe(true)
    // Um `.css` solto não é um sistema de tokens — ver a nota em THEME_SURFACE.
    expect(ev.hasThemeSurface).toBe(false)
    expect(ev.signals).toContain('dep:react')
  })

  it('Tailwind ou uma pasta de tema contam como superfície de tema', () => {
    expect(
      detectProjectContextEvidence({
        pkgSummary: pkg(['react', 'tailwindcss']),
        treeString: FRONTEND_TREE,
      }).hasThemeSurface,
    ).toBe(true)
    expect(
      detectProjectContextEvidence({
        pkgSummary: pkg(['react']),
        treeString: 'project/\n  src/\n    theme/\n    App.tsx',
      }).hasThemeSurface,
    ).toBe(true)
  })

  // A REGRA que evita a falha silenciosa nº1: ausência de dados não é
  // evidência negativa. Criar uma app de raiz é o momento em que a linha de
  // base de gosto mais vale — não pode nascer sem ela.
  it('projecto vazio mantém TUDO (ausência de dados ≠ evidência negativa)', () => {
    const ev = detectProjectContextEvidence({ pkgSummary: null, treeString: 'project/' })
    expect(ev.hasSourceFiles).toBe(false)
    // Os campos dizem o que foi detectado (nada); a política vive no portão.
    expect(ev.hasUiSurface).toBe(false)
    expect(evidenceOmittedAuxiliaries({ evidence: ev, sessionHasImage: false })).toEqual([])
  })

  // A detecção usa `detectionDependencies` (união NÃO truncada) — as listas
  // renderizadas vêm cortadas a 15/10 e um framework fora dessa janela dava
  // falso negativo calado.
  it('detecta React declarado FORA da janela de truncagem do prompt', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `pkg-${i}`)
    const ev = detectProjectContextEvidence({
      pkgSummary: pkg([...filler, 'react'], filler.slice(0, 15)),
      treeString: BACKEND_TREE,
    })
    expect(ev.hasUiSurface).toBe(true)
  })

  it('monorepo: a pasta client/ chega como sinal mesmo sem deps de UI na raiz', () => {
    const ev = detectProjectContextEvidence({
      pkgSummary: pkg(['express']),
      treeString: 'project/\n  server/\n  client/\n  package.json',
    })
    expect(ev.hasUiSurface).toBe(true)
  })

  it('Chakra gera o sinal e desbloqueia as receitas', () => {
    const ev = detectProjectContextEvidence({
      pkgSummary: pkg(['react', '@chakra-ui/react']),
      treeString: FRONTEND_TREE,
    })
    expect(ev.hasChakra).toBe(true)
    const held = evidenceOmittedAuxiliaries({ evidence: ev, sessionHasImage: true }).map(o => o.id)
    expect(held).toEqual([])
  })
})

describe('evidenceOmittedAuxiliaries', () => {
  it('num backend puro retém as 6 secções de design system e as de visão', () => {
    const ev = detectProjectContextEvidence({
      pkgSummary: pkg(['express', 'drizzle-orm']),
      treeString: BACKEND_TREE,
    })
    const held = evidenceOmittedAuxiliaries({ evidence: ev, sessionHasImage: false }).map(o => o.id)
    expect(held.sort()).toEqual([
      'design_system.brand_palette',
      'design_system.chakra_recipes',
      'design_system.component_patterns',
      'design_system.semantic_tokens',
      'design_system.theme_config',
      'ui_patterns',
      'vision.image_rules',
    ])
  })

  it('uma imagem na sessão devolve as regras de visão', () => {
    const ev = detectProjectContextEvidence({
      pkgSummary: pkg(['express']),
      treeString: BACKEND_TREE,
    })
    const held = evidenceOmittedAuxiliaries({ evidence: ev, sessionHasImage: true }).map(o => o.id)
    expect(held).not.toContain('vision.image_rules')
  })
})

describe('applyEvidenceOmissions', () => {
  const backendEvidence = () =>
    detectProjectContextEvidence({
      pkgSummary: pkg(['express', 'drizzle-orm']),
      treeString: BACKEND_TREE,
    })

  it('move de loaded para omitted e reconcilia tokens, plano e telemetria', () => {
    const sel = selectAuxiliaries('default_task', undefined)
    const before = sel.loadedTokens
    const ev = backendEvidence()
    applyEvidenceOmissions(sel, evidenceOmittedAuxiliaries({ evidence: ev, sessionHasImage: false }), ev.signals)

    const loadedIds = sel.loaded.map(l => l.id)
    expect(loadedIds).not.toContain('ui_patterns')
    expect(loadedIds).not.toContain('design_system.component_patterns')
    // Continua a entregar o que o projecto justifica.
    expect(loadedIds).toContain('project.package_map')
    expect(loadedIds).toContain('agent_runtime.mcp_routing')

    expect(sel.loadedTokens).toBeLessThan(before)
    expect(sel.loadedTokens).toBe(sel.loaded.reduce((s, l) => s + l.tokens, 0))
    expect(sel.savingsTokens).toBe(sel.totalAvailableTokens - sel.loadedTokens)
    // O plano tem de contar a mesma história que a entrega.
    expect(sel.contextPlan.selectedContexts).not.toContain('ui_patterns')
    expect(sel.autoLoadedSystemSections).toEqual(loadedIds)
    // Não há duplicados entre loaded e omitted.
    expect(sel.omitted.filter(o => loadedIds.includes(o.id))).toEqual([])
  })

  it('a omissão fica VISÍVEL no índice on-demand, com a razão e o convite a pedir', () => {
    const sel = selectAuxiliaries('default_task', undefined)
    const ev = backendEvidence()
    applyEvidenceOmissions(sel, evidenceOmittedAuxiliaries({ evidence: ev, sessionHasImage: false }), ev.signals)
    const index = buildOnDemandIndex(sel) ?? ''

    expect(index).toContain('Withheld for lack of project evidence')
    expect(index).toContain('`ui_patterns`')
    expect(index).toContain('no UI surface in this project')
    // Uma secção só pode aparecer numa lista.
    expect(index.match(/`ui_patterns`/g)).toHaveLength(1)
  })

  it('sem omissões só carimba os sinais', () => {
    const sel = selectAuxiliaries('default_task', undefined)
    const loadedBefore = sel.loaded.map(l => l.id)
    applyEvidenceOmissions(sel, [], ['dep:react'])
    expect(sel.loaded.map(l => l.id)).toEqual(loadedBefore)
    expect(sel.evidenceSignals).toEqual(['dep:react'])
    expect(sel.evidenceOmittedSections).toBeUndefined()
  })

  it('cada secção inline é retível por evidência ou justificada em todo o projecto', () => {
    // Trava de âmbito: o portão só pode mexer em secções que existem na lista
    // inline — um id mal escrito ficaria a não fazer nada, calado.
    const ev = detectProjectContextEvidence({ pkgSummary: pkg(['express']), treeString: BACKEND_TREE })
    for (const { id } of evidenceOmittedAuxiliaries({ evidence: ev, sessionHasImage: false })) {
      expect(BOUNDED_INLINE_CONTEXTS).toContain(id)
    }
  })
})

describe('applyRenderedTokenCounts', () => {
  it('substitui o estTokens declarado pelo custo real do corpo renderizado', () => {
    const sel = selectAuxiliaries('default_task', undefined)
    const body = 'x'.repeat(300)
    applyRenderedTokenCounts(sel, { ui_patterns: body })
    const entry = sel.loaded.find(l => l.id === 'ui_patterns')
    expect(entry?.tokens).toBe(100)
    expect(sel.loadedTokens).toBe(sel.loaded.reduce((s, l) => s + l.tokens, 0))
  })

  it('mantém o estTokens quando a secção não rendeu conteúdo', () => {
    const sel = selectAuxiliaries('default_task', undefined)
    const before = sel.loaded.find(l => l.id === 'ui_patterns')?.tokens
    applyRenderedTokenCounts(sel, {})
    expect(sel.loaded.find(l => l.id === 'ui_patterns')?.tokens).toBe(before)
  })
})
