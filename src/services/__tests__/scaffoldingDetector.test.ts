import { invoke } from '@tauri-apps/api/core'
import {
  detectScaffolding,
  invalidateScaffoldingCache,
  clearAllScaffoldingCache,
  scaffoldKeyLabel,
  scaffoldUITrigger,
  scaffoldFixHint,
} from '../scaffoldingDetector'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

const PROJECT = '/test/project'

/**
 * Mock helper: builds an invoke handler that responds to read_file +
 * path_exists with the supplied envText, packageJson, and existing
 * marker paths. Anything not in the maps returns "not found" / false.
 */
function setupInvoke(opts: {
  envText?: string | null
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null
  existingMarkers?: string[]
}) {
  const envText = opts.envText ?? null
  const pkg = opts.packageJson ?? null
  const markers = new Set(opts.existingMarkers ?? [])

  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'read_file') {
      const path = (args as { path: string }).path
      if (path === `${PROJECT}/.env`) {
        if (envText === null) throw new Error('not found')
        return envText as unknown as never
      }
      if (path === `${PROJECT}/package.json`) {
        if (pkg === null) throw new Error('not found')
        return JSON.stringify(pkg) as unknown as never
      }
      throw new Error('not found')
    }
    if (cmd === 'path_exists') {
      const path = (args as { path: string }).path
      // Normalise: the detector calls path_exists with absolute-from-project
      // (`${PROJECT}/${rel}`); markers are stored as project-relative.
      const rel = path.startsWith(`${PROJECT}/`) ? path.slice(PROJECT.length + 1) : path
      return markers.has(rel) as unknown as never
    }
    throw new Error(`unexpected invoke: ${cmd}`)
  })
}

describe('scaffoldingDetector', () => {
  beforeEach(() => {
    clearAllScaffoldingCache()
    mockedInvoke.mockReset()
  })

  describe('detectScaffolding — empty project', () => {
    it('returns no applied keys for an empty project (no .env, no package.json, no markers)', async () => {
      setupInvoke({})
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toEqual([])
      expect(state.evidence).toEqual({})
    })
  })

  describe('detectScaffolding — auth.email-password', () => {
    it('does NOT detect when only .env keys present (missing marker file)', async () => {
      // .env was written by an aborted provision_auth — proxy code never
      // landed. Conjunction logic correctly treats this as "not applied"
      // so the user can re-run the scaffolding flow to complete it.
      setupInvoke({
        envText: 'VITE_FIREBASE_API_KEY=abc\nVITE_GIP_TENANT_ID=xyz\n',
        existingMarkers: [],
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).not.toContain('auth.email-password')
    })

    it('does NOT detect when only marker file present (no .env)', async () => {
      // Hand-written stub with no creds — also incomplete.
      setupInvoke({
        envText: null,
        existingMarkers: ['src/routes/auth-proxy.ts'],
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).not.toContain('auth.email-password')
    })

    it('detects when both .env keys AND a marker file exist', async () => {
      setupInvoke({
        envText: 'VITE_FIREBASE_API_KEY=abc\nVITE_GIP_TENANT_ID=xyz\n',
        existingMarkers: ['server/src/routes/auth-proxy.ts'],
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toContain('auth.email-password')
      expect(state.evidence['auth.email-password']).toEqual(
        expect.arrayContaining(['.env:VITE_FIREBASE_API_KEY', '.env:VITE_GIP_TENANT_ID', 'server/src/routes/auth-proxy.ts'])
      )
    })

    it('ignores commented-out env keys', async () => {
      setupInvoke({
        envText: '# VITE_FIREBASE_API_KEY=disabled\nVITE_GIP_TENANT_ID=xyz\n',
        existingMarkers: ['src/lib/authClient.ts'],
      })
      const state = await detectScaffolding(PROJECT)
      // Only one .env key counts → conjunction (need both keys + marker)
      // is partially satisfied but VITE_FIREBASE_API_KEY is missing → no detection.
      // (Detector's conjunction is "AND between hasEnv and hasFile";
      // hasEnv is true if EITHER env key is present, so this case actually
      // counts. Adjust expectation: detection PASSES with one env key
      // because hasEnv is "any env signal".)
      expect(state.applied).toContain('auth.email-password')
      const ev = state.evidence['auth.email-password'] ?? []
      expect(ev).not.toContain('.env:VITE_FIREBASE_API_KEY')
      expect(ev).toContain('.env:VITE_GIP_TENANT_ID')
    })
  })

  describe('detectScaffolding — auth.google', () => {
    it('detects via .env VITE_GOOGLE_CLIENT_ID alone', async () => {
      setupInvoke({
        envText: 'VITE_GOOGLE_CLIENT_ID=client-abc.apps.googleusercontent.com\n',
        existingMarkers: [],
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toContain('auth.google')
      expect(state.evidence['auth.google']).toEqual(['.env:VITE_GOOGLE_CLIENT_ID'])
    })

    it('detects via useGoogleSignIn hook file alone', async () => {
      setupInvoke({
        existingMarkers: ['src/hooks/useGoogleSignIn.ts'],
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toContain('auth.google')
    })

    it('does NOT detect when neither signal present', async () => {
      setupInvoke({
        envText: 'VITE_FIREBASE_API_KEY=abc\n',
        existingMarkers: [],
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).not.toContain('auth.google')
    })
  })

  describe('detectScaffolding — payments.momenu', () => {
    it('detects via .env MOM_FACTURA_API_KEY', async () => {
      setupInvoke({
        envText: 'MOM_FACTURA_API_KEY=tok\n',
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toContain('payments.momenu')
    })

    it('detects via package.json dep mom-factura', async () => {
      setupInvoke({
        packageJson: { dependencies: { 'mom-factura': '^1.0.0' } },
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toContain('payments.momenu')
      expect(state.evidence['payments.momenu']).toContain('package.json:mom-factura')
    })

    it('detects via package.json devDep mcx-express', async () => {
      setupInvoke({
        packageJson: { devDependencies: { 'mcx-express': '^0.1.0' } },
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toContain('payments.momenu')
    })
  })

  describe('detectScaffolding — composite', () => {
    it('detects multiple scaffoldings simultaneously', async () => {
      setupInvoke({
        envText: 'VITE_FIREBASE_API_KEY=abc\nVITE_GIP_TENANT_ID=xyz\nVITE_GOOGLE_CLIENT_ID=clid\nMOM_FACTURA_API_KEY=tok\n',
        existingMarkers: ['src/routes/auth-proxy.ts', 'src/hooks/useGoogleSignIn.ts'],
        packageJson: { dependencies: { 'mom-factura': '^1.0.0' } },
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toEqual(
        expect.arrayContaining(['auth.email-password', 'auth.google', 'payments.momenu'])
      )
      expect(state.applied).toHaveLength(3)
    })
  })

  describe('detectScaffolding — caching', () => {
    it('returns cached state on a second call within TTL (no extra invokes)', async () => {
      setupInvoke({
        envText: 'VITE_GOOGLE_CLIENT_ID=clid\n',
      })
      await detectScaffolding(PROJECT)
      const callsAfterFirst = mockedInvoke.mock.calls.length
      await detectScaffolding(PROJECT)
      // Second call hits cache — no new invoke calls
      expect(mockedInvoke.mock.calls.length).toBe(callsAfterFirst)
    })

    it('invalidateScaffoldingCache forces a fresh scan', async () => {
      setupInvoke({
        envText: 'VITE_GOOGLE_CLIENT_ID=clid\n',
      })
      await detectScaffolding(PROJECT)
      const callsAfterFirst = mockedInvoke.mock.calls.length
      invalidateScaffoldingCache(PROJECT)
      await detectScaffolding(PROJECT)
      expect(mockedInvoke.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    })

    it('clearAllScaffoldingCache forces a fresh scan for any project', async () => {
      setupInvoke({
        envText: 'VITE_GOOGLE_CLIENT_ID=clid\n',
      })
      await detectScaffolding(PROJECT)
      const callsAfterFirst = mockedInvoke.mock.calls.length
      clearAllScaffoldingCache()
      await detectScaffolding(PROJECT)
      expect(mockedInvoke.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    })
  })

  describe('detectScaffolding — robustness', () => {
    it('returns empty applied on malformed package.json', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'read_file') {
          const path = (args as { path: string }).path
          if (path === `${PROJECT}/package.json`) return '{ broken json' as unknown as never
          throw new Error('not found')
        }
        if (cmd === 'path_exists') return false as unknown as never
        throw new Error(`unexpected invoke: ${cmd}`)
      })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toEqual([])
    })

    it('survives invoke errors (returns empty applied, not a throw)', async () => {
      mockedInvoke.mockImplementation(async () => { throw new Error('IPC failed') })
      const state = await detectScaffolding(PROJECT)
      expect(state.applied).toEqual([])
    })
  })

  describe('helpers — labels and triggers', () => {
    it('scaffoldKeyLabel returns human strings', () => {
      expect(scaffoldKeyLabel('auth.email-password')).toBe('Email + password sign-in')
      expect(scaffoldKeyLabel('auth.google')).toBe('Google sign-in')
      expect(scaffoldKeyLabel('payments.momenu')).toBe('MoMenu Payments')
    })

    it('scaffoldUITrigger returns the trigger token (hashtag or slash command)', () => {
      expect(scaffoldUITrigger('auth.email-password')).toBe('#auth-email-password')
      expect(scaffoldUITrigger('auth.google')).toBe('#auth-google')
      expect(scaffoldUITrigger('payments.momenu')).toBe('/payments')
    })

    it('scaffoldFixHint returns non-empty per-key tooltip', () => {
      expect(scaffoldFixHint('auth.email-password')).toMatch(/.+/)
      expect(scaffoldFixHint('auth.google')).toMatch(/.+/)
      expect(scaffoldFixHint('payments.momenu')).toMatch(/.+/)
    })
  })
})
