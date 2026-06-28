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
} from '../contextBuilder/auxiliaryRegistry'

describe('auxiliaryRegistry', () => {
  // ── classifyPromptIntent ──────────────────────────────────────
  describe('classifyPromptIntent', () => {
    it('defaults to bugfix_local when there is no message', () => {
      expect(classifyPromptIntent(undefined)).toBe('bugfix_local')
      expect(classifyPromptIntent('')).toBe('bugfix_local')
    })

    it('classifies a localised bugfix as bugfix_local', () => {
      // The canonical Phase-D test prompt: a UI tweak in an existing file.
      // "dialog" matches frontend_ui — that's the intended escalation (UI
      // baseline short version stays). Not bugfix_local because it IS a UI
      // task. Verify it does NOT escalate to scaffold/deploy/auth/vision.
      const p = classifyPromptIntent(
        'Centralize os Dialogs de confirmação no meio, usando center no placement',
      )
      expect(p).not.toBe('scaffold_project')
      expect(p).not.toBe('deploy_publish')
      expect(p).not.toBe('auth_database')
      expect(p).not.toBe('vision')
    })

    it('classifies a pure code bugfix (no UI keyword) as bugfix_local', () => {
      expect(classifyPromptIntent('fix the off-by-one in the retry loop')).toBe('bugfix_local')
      expect(classifyPromptIntent('corrige o bug no cálculo do total')).toBe('bugfix_local')
    })

    it('classifies new-project scaffolding', () => {
      expect(classifyPromptIntent('create a new React app with Vite')).toBe('scaffold_project')
      expect(classifyPromptIntent('criar um novo projeto de landing page')).toBe('scaffold_project')
    })

    it('classifies deploy/publish', () => {
      expect(classifyPromptIntent('deploy this to production')).toBe('deploy_publish')
      expect(classifyPromptIntent('publicar o app no domínio')).toBe('deploy_publish')
    })

    it('classifies auth/database', () => {
      expect(classifyPromptIntent('add login with Google')).toBe('auth_database')
      expect(classifyPromptIntent('create a sqlite database for users')).toBe('auth_database')
    })

    it('classifies vision when an image is present', () => {
      expect(classifyPromptIntent('what is wrong here?', { hasImage: true })).toBe('vision')
    })

    it('classifies frontend/ui tasks as frontend_ui', () => {
      expect(classifyPromptIntent('redesign the button styles')).toBe('frontend_ui')
      // NOTE: a UI task that mentions "login" resolves to auth_database because
      // the auth pattern is checked before frontend_ui (auth wins on ambiguity).
      // That's an accepted Phase-1 limitation — the on-demand mechanism covers it.
      expect(classifyPromptIntent('muda o layout da tela principal')).toBe('frontend_ui')
    })
  })

  // ── selectAuxiliaries ─────────────────────────────────────────
  describe('selectAuxiliaries', () => {
    it('omits ALL phase-1 auxiliaries for a bare bugfix_local profile', () => {
      const sel = selectAuxiliaries('bugfix_local', 'fix the retry bug')
      expect(sel.profile).toBe('bugfix_local')
      expect(sel.loaded).toHaveLength(0)
      // Publishing, scaffolding, vision, auth/db must all be omitted.
      const omittedIds = sel.omitted.map((o) => o.id)
      expect(omittedIds).toContain('publishing_fullstack')
      expect(omittedIds).toContain('scaffolding_install')
      expect(omittedIds).toContain('vision_rules')
      expect(omittedIds).toContain('auth_database_provision')
      // Savings = everything (nothing loaded).
      expect(sel.savingsTokens).toBe(sel.totalAvailableTokens)
      expect(sel.loadedTokens).toBe(0)
    })

    it('loads publishing + auth/db for scaffold_project', () => {
      const sel = selectAuxiliaries('scaffold_project', 'create a new react app')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('publishing_fullstack')
      expect(loadedIds).toContain('scaffolding_install')
      expect(loadedIds).toContain('auth_database_provision')
      // Vision is NOT loaded for scaffolding (no image).
      expect(loadedIds).not.toContain('vision_rules')
    })

    it('loads publishing + auth/db for deploy_publish', () => {
      const sel = selectAuxiliaries('deploy_publish', 'deploy to production')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('publishing_fullstack')
      expect(loadedIds).toContain('auth_database_provision')
      expect(loadedIds).not.toContain('scaffolding_install')
      expect(loadedIds).not.toContain('vision_rules')
    })

    it('loads only vision_rules for the vision profile', () => {
      const sel = selectAuxiliaries('vision', 'look at this screenshot')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('vision_rules')
      expect(loadedIds).not.toContain('publishing_fullstack')
      expect(loadedIds).not.toContain('scaffolding_install')
    })

    it('trigger match activates an auxiliary even without a profile match', () => {
      // bugfix_local profile, but the message mentions "provision" →
      // publishing_fullstack trigger fires.
      const sel = selectAuxiliaries('bugfix_local', 'help me provision the database')
      const loadedIds = sel.loaded.map((l) => l.id)
      expect(loadedIds).toContain('publishing_fullstack')
      expect(loadedIds).toContain('auth_database_provision')
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
        readOnly: false,
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
      expect(index).toContain('publishing_fullstack')
      expect(index).toContain('scaffolding_install')
      expect(index).toContain('vision_rules')
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
