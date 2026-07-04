/**
 * Unit tests for the Auxiliary Context Registry — the on-demand context
 * architecture that decides which heavy system-prompt blocks load inline vs.
 * stay available on-demand. Covers the intent classifier, the selector, and
 * the gating criteria from the Phase-1 spec.
 */
import {
  classifyPromptIntent,
  selectAuxiliaries,
  buildOnDemandIndex,
  AUXILIARY_METAS,
  type ContextPlan,
} from '../contextBuilder/auxiliaryRegistry'

function plan(overrides: Partial<ContextPlan>): ContextPlan {
  return {
    taskDomain: 'bugfix_local',
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
  // ── classifyPromptIntent ──────────────────────────────────────
  describe('classifyPromptIntent', () => {
    it('defaults to bugfix_local when there is no message', () => {
      expect(classifyPromptIntent(undefined)).toBe('bugfix_local')
      expect(classifyPromptIntent('')).toBe('bugfix_local')
    })

    it('does not infer profiles from free text in fallback mode', () => {
      expect(classifyPromptIntent('fix the off-by-one in the retry loop')).toBe('bugfix_local')
      expect(classifyPromptIntent('create a new React app with Vite')).toBe('bugfix_local')
      expect(classifyPromptIntent('deploy this to production')).toBe('bugfix_local')
      expect(classifyPromptIntent('add login with Google')).toBe('bugfix_local')
      expect(classifyPromptIntent('redesign the button styles')).toBe('bugfix_local')
    })

    it('classifies vision when an image is present', () => {
      expect(classifyPromptIntent('what is wrong here?', { hasImage: true })).toBe('vision')
    })

  })

  // ── selectAuxiliaries ─────────────────────────────────────────
  describe('selectAuxiliaries', () => {
    it('omits ALL phase-1 auxiliaries for a bare bugfix_local profile', () => {
      const sel = selectAuxiliaries('bugfix_local', 'fix the retry bug')
      expect(sel.profile).toBe('bugfix_local')
      expect(sel.loaded).toHaveLength(0)
      const omittedIds = sel.omitted.map((o) => o.id)
      expect(omittedIds).toContain('delivery.deploy')
      expect(omittedIds).toContain('scaffold.workflow')
      expect(omittedIds).toContain('vision.image_rules')
      expect(omittedIds).toContain('auth_database.provision')
      expect(sel.savingsTokens).toBe(sel.totalAvailableTokens)
      expect(sel.loadedTokens).toBe(0)
    })

    it('loads scaffold workflow for scaffold_project without broad project full context', () => {
      const sel = selectAuxiliaries('scaffold_project', 'create a new react app')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('scaffold.workflow')
      expect(loadedIds).toContain('project.package_map')
      expect(loadedIds).not.toContain('project.structure_full')
      expect(loadedIds).not.toContain('vision.image_rules')
    })

    it('loads deploy + build context for deploy_publish', () => {
      const sel = selectAuxiliaries('deploy_publish', 'deploy to production')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('delivery.deploy')
      expect(loadedIds).toContain('delivery.build_scripts')
      expect(loadedIds).not.toContain('scaffold.workflow')
      expect(loadedIds).not.toContain('vision.image_rules')
    })

    it('loads only vision.image_rules for the vision profile', () => {
      const sel = selectAuxiliaries('vision', 'look at this screenshot')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('vision.image_rules')
      expect(loadedIds).not.toContain('delivery.deploy')
      expect(loadedIds).not.toContain('scaffold.workflow')
    })

    it('does not activate auxiliaries from free-text triggers without a model plan', () => {
      const sel = selectAuxiliaries('bugfix_local', 'help me provision the database')
      expect(sel.loaded).toHaveLength(0)
    })

    it('does not load UI baseline for an MCP audit just because the profile is frontend_ui', () => {
      const sel = selectAuxiliaries(
        'frontend_ui',
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
      const sel = selectAuxiliaries('bugfix_local', 'polish the account screen layout', false, 'test', undefined, plan({
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
        'frontend_ui',
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
      const sel = selectAuxiliaries('analysis_readonly', 'Faça uma auditoria read-only da integração MCP.', true, 'test', undefined, plan({
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
      const sel = selectAuxiliaries('bugfix_local', 'O preview não abre no browser.', false, 'test', undefined, plan({
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
      const sel = selectAuxiliaries('frontend_ui', 'Melhore visualmente a lista de sessões.', false, 'test', undefined, plan({
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
      const sel = selectAuxiliaries('bugfix_local', 'Faz commit das alterações.', false, 'test', undefined, plan({
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
      const sel = selectAuxiliaries('scaffold_project', 'create app')
      for (const l of sel.loaded) {
        expect(l.reason).toBeTruthy()
        expect(l.reason.length).toBeGreaterThan(5)
      }
    })

    it('every omitted entry has a reason', () => {
      const sel = selectAuxiliaries('bugfix_local', 'fix bug')
      for (const o of sel.omitted) {
        expect(o.reason).toBeTruthy()
        expect(o.reason.length).toBeGreaterThan(5)
      }
    })

    // ── Context Planner telemetry ──────────────────────────────
    it('marks a bare profile call (no plan, no telemetry) as planner fallback', () => {
      const sel = selectAuxiliaries('bugfix_local', 'fix the retry bug')
      expect(sel.contextPlannerStatus).toBe('fallback')
      expect(sel.contextPlannerSelectionReason).toBeTruthy()
    })

    it('infers parsed status when a model plan is provided without telemetry', () => {
      const sel = selectAuxiliaries(
        'frontend_ui',
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
        'bugfix_local',
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
        'frontend_ui',
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
        profile: 'scaffold_project' as const,
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
        requiresMutation: false,
        reason: 'test',
        routerSource: 'keyword' as const,
        routerConfidence: 'none' as const,
      }
      expect(buildOnDemandIndex(sel)).toBeNull()
    })

    it('lists each omitted auxiliary with its id and request_context hint', () => {
      const sel = selectAuxiliaries('bugfix_local', 'fix the bug')
      const index = buildOnDemandIndex(sel)
      expect(index).not.toBeNull()
      expect(index).toContain('request_context')
      expect(index).toContain('delivery.deploy')
      expect(index).toContain('scaffold.workflow')
      expect(index).toContain('project.symbol_index')
      expect(index).toContain('locate functions/classes/components/hooks/handlers/services')
      expect(index).toContain('verify source with Read before editing')
      expect(index).toContain('vision.image_rules')
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
  })
})
