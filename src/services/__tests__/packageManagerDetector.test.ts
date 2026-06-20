import { invoke } from '@tauri-apps/api/core'
import { detectProjectPackageManager, adaptCommand } from '../packageManagerDetector'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

const PROJECT = '/test/project'

beforeEach(() => {
  jest.clearAllMocks()
})

/** path_exists → true for any lockfile name in `lockfiles`. */
function setupLockfiles(lockfiles: string[]) {
  const present = new Set(lockfiles.map(f => `${PROJECT}/${f}`))
  mockedInvoke.mockImplementation((async (cmd: string, args?: { path?: string }) => {
    if (cmd === 'path_exists') return present.has(args?.path ?? '')
    return undefined
  }) as unknown as typeof invoke)
}

describe('detectProjectPackageManager', () => {
  it('falls back to npm when no lockfile is present', async () => {
    setupLockfiles([])
    expect(await detectProjectPackageManager(PROJECT)).toBe('npm')
  })

  it('detects yarn from yarn.lock', async () => {
    setupLockfiles(['yarn.lock'])
    expect(await detectProjectPackageManager(PROJECT)).toBe('yarn')
  })

  it('detects pnpm from pnpm-lock.yaml', async () => {
    setupLockfiles(['pnpm-lock.yaml'])
    expect(await detectProjectPackageManager(PROJECT)).toBe('pnpm')
  })

  it('prefers pnpm over yarn/npm when several lockfiles coexist', async () => {
    // A repo migrated between managers can carry multiple lockfiles; precedence
    // must be deterministic so every install/run surface agrees.
    setupLockfiles(['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'])
    expect(await detectProjectPackageManager(PROJECT)).toBe('pnpm')
  })
})

describe('adaptCommand', () => {
  it('rewrites a yarn install to the target package manager', () => {
    expect(adaptCommand('yarn install', 'pnpm')).toBe('pnpm install')
  })

  it('leaves an already-matching command unchanged', () => {
    expect(adaptCommand('npm install', 'npm')).toBe('npm install')
  })
})
