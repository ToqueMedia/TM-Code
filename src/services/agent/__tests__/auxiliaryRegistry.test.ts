/**
 * Unit tests for the Auxiliary Context Registry — the on-demand context
 * architecture that decides which heavy system-prompt blocks load inline vs.
 * stay available on-demand. Covers the intent classifier, the selector, and
 * the gating criteria from the Phase-1 spec.
 */
import {
  selectAuxiliaries,
  buildOnDemandIndex,
  AUXILIARY_METAS,
  type ContextPlan,
} from '../contextBuilder/auxiliaryRegistry'

function plan(overrides: Partial<ContextPlan>): ContextPlan {
  return {
    taskDomain: 'default_task',
    requiredCapabilities: [],
    minimumContextNeeded: 'summary',
    candidateContexts: [],
    selectedContexts: [],
    fallbackRisk: 'low',
    reason: 'model test plan',
    ...overrides,
  }
}

describe('auxiliaryRegistry', () => {
  // ── profileForSignals ──────────────────────────────────────

  // ── selectAuxiliaries ─────────────────────────────────────────
  describe('selectAuxiliaries', () => {
    it('full delivery: default_task entrega inline as bounded, omite só as unbounded', () => {
      // Doutrina invertida a 2026-08-03: a meia-entrega falhava em silêncio
      // (0 request_context em 34 pedidos na sessão momenu-fact de 02-08) e o
      // cache-read torna a entrega total ~10% do preço nominal. Ficam
      // on-demand só as unbounded — ver BOUNDED_INLINE_CONTEXTS.
      const sel = selectAuxiliaries('default_task', 'fix the retry bug')
      expect(sel.profile).toBe('default_task')
      expect(sel.loaded.length).toBeGreaterThan(0)
      const omittedIds = sel.omitted.map((o) => o.id)
      expect(omittedIds).toContain('scaffold.workflow')
      expect(omittedIds).toContain('project.structure_full')
      expect(omittedIds).not.toContain('vision.image_rules')
      // MANAGED-PLATFORM cut (2026-07): 'delivery.deploy' and
      // 'auth_database.provision' no longer exist in the registry at all.
      expect(omittedIds).not.toContain('delivery.deploy')
      expect(omittedIds).not.toContain('auth_database.provision')
      expect(sel.loadedTokens).toBeGreaterThan(0)
      expect(sel.savingsTokens).toBe(sel.totalAvailableTokens - sel.loadedTokens)
    })

  
  
    it('loads only vision.image_rules for the vision profile', () => {
      const sel = selectAuxiliaries('vision', 'look at this screenshot')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('vision.image_rules')
      expect(loadedIds).not.toContain('delivery.deploy')
      expect(loadedIds).not.toContain('scaffold.workflow')
    })

    it('does not activate auxiliaries from free-text triggers without a model plan', () => {
      // O texto livre não acrescenta nada à selecção determinística — a
      // lista carregada é EXACTAMENTE a mesma com qualquer mensagem.
      const withTrigger = selectAuxiliaries('default_task', 'help me provision the database')
      const bare = selectAuxiliaries('default_task', 'fix the retry bug')
      expect(withTrigger.loaded.map(l => l.id).sort()).toEqual(bare.loaded.map(l => l.id).sort())
    })

    it('does not load UI baseline for an MCP audit just because the profile is frontend_ui', () => {
      const sel = selectAuxiliaries(
        'default_task',
        'audit the MCP routing in src/screens/account/Settings.tsx',
        false,
        'test',
        undefined,
        plan({
          taskDomain: 'agent_runtime',
          requiredCapabilities: ['mcp_routing'],
          candidateContexts: ['agent_runtime.mcp_routing', 'project.structure_overview'],
          selectedContexts: ['agent_runtime.mcp_routing'],
          reason: 'model selected MCP routing',
        }),
      )
      const loadedIds = sel.loaded.map((l) => l.id)

      expect(loadedIds).toContain('agent_runtime.mcp_routing')
      expect(loadedIds).not.toContain('design_system.component_patterns')
      expect(loadedIds).not.toContain('ui_patterns')
    })

    it('loads UI guidance only when the user explicitly asks for visual work', () => {
      const sel = selectAuxiliaries('default_task', 'polish the account screen layout', false, 'test', undefined, plan({
        taskDomain: 'design_system/ui',
        requiredCapabilities: ['component_patterns', 'spacing_typography'],
        candidateContexts: ['design_system.component_patterns', 'ui_patterns'],
        selectedContexts: ['design_system.component_patterns', 'ui_patterns'],
      }))
      const loadedIds = sel.loaded.map((l) => l.id)

      expect(loadedIds).toContain('design_system.component_patterns')
      expect(loadedIds).toContain('ui_patterns')
    })

    it('golden: semantic tokens choose design-system context before project structure', () => {
      const sel = selectAuxiliaries(
        'default_task',
        'Implemente os semantic tokens sidebar.session.item e sidebar.session.itemActive no design system/theme.',
        false,
        'test',
        undefined,
        plan({
          taskDomain: 'design_system',
          requiredCapabilities: ['semantic_tokens', 'theme_config'],
          minimumContextNeeded: 'summary',
          candidateContexts: ['design_system.semantic_tokens', 'design_system.theme_config', 'design_system.brand_palette', 'design_system.chakra_recipes', 'project.structure_overview'],
          selectedContexts: ['design_system.semantic_tokens', 'design_system.theme_config'],
          fallbackRisk: 'low',
        }),
      )
      const loadedIds = sel.loaded.map((l) => l.id)

      expect(sel.contextPlan.taskDomain).toBe('design_system')
      expect(sel.contextPlan.requiredCapabilities).toEqual(['semantic_tokens', 'theme_config'])
      expect(loadedIds).toContain('design_system.semantic_tokens')
      expect(loadedIds).toContain('design_system.theme_config')
      expect(loadedIds).not.toContain('project.structure_full')
      expect(loadedIds).not.toContain('project_structure_full')
      expect(sel.requestContextFallbackUsed).toBe(false)
    })

    it('golden: MCP audit chooses agent runtime routing only', () => {
      const sel = selectAuxiliaries('default_task', 'Faça uma auditoria read-only da integração MCP.', true, 'test', undefined, plan({
        taskDomain: 'agent_runtime',
        requiredCapabilities: ['mcp_routing'],
        candidateContexts: ['agent_runtime.mcp_routing', 'agent_runtime.tool_profiles', 'project.structure_overview'],
        selectedContexts: ['agent_runtime.mcp_routing'],
      }))
      const loadedIds = sel.loaded.map((l) => l.id)

      expect(sel.contextPlan.taskDomain).toBe('agent_runtime')
      expect(loadedIds).toContain('agent_runtime.mcp_routing')
      expect(loadedIds).not.toContain('design_system.semantic_tokens')
      expect(loadedIds).not.toContain('project.structure_full')
    })

    it('golden: dev server preview chooses delivery runtime context', () => {
      const sel = selectAuxiliaries('default_task', 'O preview não abre no browser.', false, 'test', undefined, plan({
        taskDomain: 'delivery/runtime',
        requiredCapabilities: ['dev_server'],
        candidateContexts: ['delivery.dev_server', 'delivery.build_scripts', 'project.package_map'],
        selectedContexts: ['delivery.dev_server'],
      }))
      const loadedIds = sel.loaded.map((l) => l.id)

      expect(sel.contextPlan.taskDomain).toBe('delivery/runtime')
      expect(loadedIds).toContain('delivery.dev_server')
      expect(loadedIds).not.toContain('delivery.git_status')
      expect(loadedIds).not.toContain('design_system.semantic_tokens')
    })

    it('golden: UI polish chooses design system and UI patterns', () => {
      const sel = selectAuxiliaries('default_task', 'Melhore visualmente a lista de sessões.', false, 'test', undefined, plan({
        taskDomain: 'design_system/ui',
        requiredCapabilities: ['component_patterns', 'semantic_tokens', 'spacing_typography'],
        candidateContexts: ['design_system.component_patterns', 'design_system.semantic_tokens', 'ui_patterns', 'project.structure_overview'],
        selectedContexts: ['design_system.component_patterns', 'design_system.semantic_tokens', 'ui_patterns'],
        fallbackRisk: 'medium',
      }))
      const loadedIds = sel.loaded.map((l) => l.id)

      expect(sel.contextPlan.taskDomain).toBe('design_system/ui')
      expect(loadedIds).toContain('design_system.component_patterns')
      expect(loadedIds).toContain('design_system.semantic_tokens')
      expect(loadedIds).toContain('ui_patterns')
      expect(loadedIds).not.toContain('project.structure_full')
    })

    it('golden: git commit chooses git delivery context only', () => {
      const sel = selectAuxiliaries('default_task', 'Faz commit das alterações.', false, 'test', undefined, plan({
        taskDomain: 'delivery/git',
        requiredCapabilities: ['git_status', 'changed_files'],
        candidateContexts: ['delivery.git_status', 'delivery.changed_files'],
        selectedContexts: ['delivery.git_status', 'delivery.changed_files'],
      }))
      const loadedIds = sel.loaded.map((l) => l.id)

      expect(sel.contextPlan.taskDomain).toBe('delivery/git')
      expect(loadedIds).toContain('delivery.git_status')
      expect(loadedIds).toContain('delivery.changed_files')
      expect(loadedIds).not.toContain('delivery.dev_server')
      expect(loadedIds).not.toContain('design_system.semantic_tokens')
    })

    it('every loaded entry has a reason', () => {
      const sel = selectAuxiliaries('default_task', 'create app')
      for (const l of sel.loaded) {
        expect(l.reason).toBeTruthy()
        expect(l.reason.length).toBeGreaterThan(5)
      }
    })

    it('every omitted entry has a reason', () => {
      const sel = selectAuxiliaries('default_task', 'fix bug')
      for (const o of sel.omitted) {
        expect(o.reason).toBeTruthy()
        expect(o.reason.length).toBeGreaterThan(5)
      }
    })

    // ── Context Planner telemetry ──────────────────────────────
    it('marks a bare profile call (no plan, no telemetry) as planner fallback', () => {
      const sel = selectAuxiliaries('default_task', 'fix the retry bug')
      expect(sel.contextPlannerStatus).toBe('fallback')
      expect(sel.contextPlannerSelectionReason).toBeTruthy()
    })

    it('infers parsed status when a model plan is provided without telemetry', () => {
      const sel = selectAuxiliaries(
        'default_task',
        'audit the MCP routing',
        false,
        'test',
        undefined,
        plan({
          taskDomain: 'agent_runtime',
          requiredCapabilities: ['mcp_routing'],
          candidateContexts: ['agent_runtime.mcp_routing', 'project.structure_overview'],
          selectedContexts: ['agent_runtime.mcp_routing'],
          reason: 'model selected MCP routing',
        }),
      )
      expect(sel.contextPlannerStatus).toBe('parsed')
    })

    it('threads planner fallback telemetry (error + rawOutput) through plannerInfo', () => {
      const sel = selectAuxiliaries(
        'default_task',
        'fix the retry bug',
        false,
        'context planner fallback: invalid context plan JSON',
        undefined,
        undefined,
        {
          status: 'fallback',
          error: 'schema validation failed: taskDomain must be a non-empty string',
          rawOutput: '{"selectedContexts":[]}',
          selectionReason: 'invalid context plan JSON',
        },
      )
      expect(sel.contextPlannerStatus).toBe('fallback')
      expect(sel.contextPlannerError).toMatch(/schema validation failed/)
      expect(sel.contextPlannerRawOutput).toBe('{"selectedContexts":[]}')
      expect(sel.contextPlannerSelectionReason).toBe('invalid context plan JSON')
    })

    it('golden: design-system refactor surfaces parsed status + rejected entrypoints', () => {
      const sel = selectAuxiliaries(
        'default_task',
        'Refatora a lista de sessões com semantic tokens e data relativa.',
        false,
        'test',
        undefined,
        plan({
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
          fallbackRisk: 'low',
          reason: 'refactor session list with semantic tokens and relative dates',
        }),
        { status: 'parsed', selectionReason: 'model context planning' },
      )
      expect(sel.contextPlannerStatus).toBe('parsed')
      expect(sel.contextPlan.taskDomain).toBe('design_system_ui')
      expect(sel.contextPlan.requiredCapabilities).toEqual([
        'semantic_tokens',
        'component_patterns',
        'relative_time_formatting',
      ])
      expect(sel.contextPlan.selectedContexts).toEqual([
        'design_system.semantic_tokens',
        'design_system.component_patterns',
      ])
      // project.entrypoints (explicit) + project.structure_overview (derived)
      // are rejected — entrypoints only loads if the component cannot be located.
      expect(sel.contextPlannerRejectedContexts).toEqual([
        'project.entrypoints',
        'project.structure_overview',
      ])
    })
  })

  // ── buildOnDemandIndex ────────────────────────────────────────
  describe('buildOnDemandIndex', () => {
    it('returns null when nothing is omitted', () => {
      // Manually craft a selection with no omissions.
      const sel = {
        profile: 'default_task' as const,
        loaded: [],
        omitted: [],
        loadedTokens: 0,
        totalAvailableTokens: 0,
        savingsTokens: 0,
        contextPlan: {
          taskDomain: 'test',
          requiredCapabilities: [],
          minimumContextNeeded: 'index' as const,
          candidateContexts: [],
          selectedContexts: [],
          fallbackRisk: 'low' as const,
          reason: 'test',
        },
        readOnly: false,
        reason: 'test',
        routerSource: 'keyword' as const,
        routerConfidence: 'none' as const,
      }
      expect(buildOnDemandIndex(sel)).toBeNull()
    })

    it('lists each omitted auxiliary with its id and request_context hint', () => {
      const sel = selectAuxiliaries('default_task', 'fix the bug')
      const index = buildOnDemandIndex(sel)
      expect(index).not.toBeNull()
      expect(index).toContain('request_context')
      expect(index).toContain('scaffold.workflow')
      expect(index).toContain('project.symbol_index')
      expect(index).toContain('locate functions/classes/components/hooks/handlers/services')
      expect(index).toContain('verify source with Read before editing')
      // Full-delivery (2026-08-03): secções bounded vão INLINE — aparecem na
      // linha "Selected inline:" do cabeçalho, mas NUNCA no corpo de
      // omitidas ("Other available contexts").
      const body = (index as string).slice((index as string).indexOf('Other available contexts'))
      expect(body).not.toContain('vision.image_rules')
      expect(body).not.toContain('design_system.semantic_tokens')
      expect(body).not.toContain('ui_patterns')
      // MANAGED-PLATFORM cut (2026-07): the managed auxiliaries must not be
      // advertised to the agent anymore.
      expect(index).not.toContain('delivery.deploy')
      expect(index).not.toContain('auth_database.provision')
    })

    it('full delivery: bounded sections são seleccionadas inline no perfil default_task', () => {
      const sel = selectAuxiliaries('default_task', 'fix the bug')
      const loadedIds = sel.loaded.map(l => l.id)
      for (const id of ['design_system.semantic_tokens', 'ui_patterns', 'project.package_map', 'agent_runtime.mcp_routing', 'vision.image_rules']) {
        expect(loadedIds).toContain(id)
      }
      // As unbounded ficam on-demand — nunca inline por defeito.
      for (const id of ['project.structure_full', 'project.docs_full', 'project.symbol_index', 'agent_runtime.memory_context']) {
        expect(loadedIds).not.toContain(id)
        expect(sel.omitted.map(o => o.id)).toContain(id)
      }
    })
  })

  // ── Registry metadata sanity ──────────────────────────────────
  describe('AUXILIARY_METAS', () => {
    it('phase-1 entries have unique ids and non-zero estTokens', () => {
      const phase1 = AUXILIARY_METAS.filter((m) => m.phase === 1)
      const ids = phase1.map((m) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const m of phase1) expect(m.estTokens).toBeGreaterThan(0)
    })

    it('does not register redundant tms.* section auxiliaries (TMS is static full)', () => {
      const tmsSectionIds = AUXILIARY_METAS.filter((m) => m.id.startsWith('tms.'))
      expect(tmsSectionIds).toEqual([])
      expect(AUXILIARY_METAS.some((m) => m.id === 'project.docs_full')).toBe(true)
    })
  })
})
