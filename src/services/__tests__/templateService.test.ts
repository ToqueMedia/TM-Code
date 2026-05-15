import { templateService, resolveFrontendPortHint } from '../templateService'

// Mock the Tauri invoke used by readTemplateManifest. The test stub returns
// whatever a per-test override sets; default behaviour rejects so the helper
// exercises its "no manifest" branch.
const mockInvoke = jest.fn()
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

describe('templateService', () => {
  describe('getById', () => {
    it('returns react-express-prisma-auth metadata', () => {
      const t = templateService.getById('react-express-prisma-auth')
      expect(t).toBeDefined()
      expect(t?.category).toBe('fullstack')
      expect(t?.workspaces).toEqual(['client', 'server'])
    })
  })

  describe('matchPrompt', () => {
    // The bug we are guarding against: the template ships, but the IDE's
    // prompt-to-template matcher gives a higher score to a different
    // template, so users with auth-like prompts never get the pre-wired
    // scaffold. These tests anchor the score ordering for the prompts
    // most likely to trigger the auth flow.

    it('selects react-express-prisma-auth for the BugHunterKimi-style auth prompt', () => {
      const prompt =
        'Vamos criar uma plataforma que recebe dos testers (previamente registado com #auth-google) ' +
        'informações de bugs de uma aplicação. Essa plataforma é um agente de IA que recebe os bugs, ' +
        'guarda em base de dados a informação do user e oferece 500 kz por bug novo reportado.'
      const matches = templateService.matchPrompt(prompt)
      expect(matches.length).toBeGreaterThan(0)
      expect(matches[0].id).toBe('react-express-prisma-auth')
    })

    it('selects react-express-prisma-auth for "login signup" prompts', () => {
      const matches = templateService.matchPrompt(
        'Build me a fullstack app with React, login, signup, and a users table'
      )
      expect(matches[0]?.id).toBe('react-express-prisma-auth')
    })

    it('does NOT select react-express-prisma-auth for plain frontend prompts', () => {
      // No auth keywords → vanilla react template should outrank.
      const matches = templateService.matchPrompt('React + TypeScript + Vite SPA')
      const top = matches[0]
      expect(top).toBeDefined()
      expect(top?.id).not.toBe('react-express-prisma-auth')
    })

    it('does NOT select react-express-prisma-auth for backend-only prompts', () => {
      // Backend-only → express-ts/fastify-ts/nestjs-ts should rank higher.
      const matches = templateService.matchPrompt('Build a REST API backend with Node and Express')
      // Either no match for the auth template, or it ranks below the backend templates.
      const authIdx = matches.findIndex((t) => t.id === 'react-express-prisma-auth')
      const backendIdx = matches.findIndex((t) => t.category === 'backend')
      if (authIdx !== -1 && backendIdx !== -1) {
        expect(backendIdx).toBeLessThan(authIdx)
      }
    })
  })

  describe('getByCategory', () => {
    it('lists react-express-prisma-auth under fullstack', () => {
      const fullstack = templateService.getByCategory('fullstack')
      const ids = fullstack.map((t) => t.id)
      expect(ids).toContain('react-express-prisma-auth')
    })
  })

  describe('fullstack templates ship a frontendPort', () => {
    // The dev-server classifier consumes this — without it, the port-hint
    // defence layer is empty and we fall back to content-type alone. Pin
    // the fullstack templates here so a future template addition can't
    // silently break the layered defence.
    it('react-express-ts → 5173', () => {
      expect(templateService.getById('react-express-ts')?.frontendPort).toBe(5173)
    })

    it('react-express-prisma-auth → 5173', () => {
      expect(templateService.getById('react-express-prisma-auth')?.frontendPort).toBe(5173)
    })
  })

  describe('resolveFrontendPortHint', () => {
    beforeEach(() => { mockInvoke.mockReset() })

    it('returns undefined for non-fullstack projects (no manifest read)', async () => {
      // Short-circuits before touching the FS — frontend / backend projects
      // never need the hint.
      const hint = await resolveFrontendPortHint('/proj', 'frontend')
      expect(hint).toBeUndefined()
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('reads frontendPort from .toquemedia-template manifest', async () => {
      mockInvoke.mockResolvedValueOnce(JSON.stringify({
        templateId: 'react-express-ts',
        name: 'React + Express',
        framework: 'react+express',
        installCommand: 'npm install',
        devCommand: 'npm run dev',
        scaffoldedAt: '2026-01-01T00:00:00Z',
        frontendPort: 5173,
      }))
      const hint = await resolveFrontendPortHint('/proj', 'fullstack')
      expect(hint).toBe(5173)
    })

    it('returns undefined when manifest is absent (user-imported repo)', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('ENOENT'))
      const hint = await resolveFrontendPortHint('/proj', 'fullstack')
      expect(hint).toBeUndefined()
    })

    it('returns undefined when manifest exists but lacks frontendPort', async () => {
      // Pre-existing scaffolds (before this field was added) don't carry it —
      // hint absent, classifier falls back to probe-based logic. Not a bug.
      mockInvoke.mockResolvedValueOnce(JSON.stringify({
        templateId: 'react-express-ts',
        name: 'React + Express',
        framework: 'react+express',
        installCommand: 'npm install',
        devCommand: 'npm run dev',
        scaffoldedAt: '2025-12-01T00:00:00Z',
      }))
      const hint = await resolveFrontendPortHint('/proj', 'fullstack')
      expect(hint).toBeUndefined()
    })

    it('returns undefined when manifest JSON is malformed', async () => {
      mockInvoke.mockResolvedValueOnce('not json at all')
      const hint = await resolveFrontendPortHint('/proj', 'fullstack')
      expect(hint).toBeUndefined()
    })
  })
})
