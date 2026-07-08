jest.mock('../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getIdToken: jest.fn() })),
  },
}))

import {
  detectBackendDir,
  detectDatabase,
  detectFramework,
  shouldSkipPortableExportPath,
  type PackageJson,
} from '../webExportService'

// ── Fixtures de paridade ─────────────────────────────────────────────────
// A MESMA heurística de deteção fullstack vive em 5 sítios (IDE
// webExportService, web compatibility.ts, web deployService, previewRuntime
// do control-plane, local-preview-vps.mjs). Estes fixtures são o contrato:
// qualquer mudança de comportamento aqui tem de ser replicada nos restantes.
const FILA1_PKG: PackageJson = {
  scripts: {
    'dev': 'concurrently "npm run dev:server" "npm run dev:client"',
    'dev:client': 'vite --host 0.0.0.0',
    'dev:server': 'tsx watch --env-file=.env server/index.ts',
    'build': 'npm run build:client && npm run build:server',
    'db:migrate': 'tsx server/migrate.ts',
    'start': 'NODE_ENV=production node server/dist/index.js',
  },
  dependencies: { express: '^4', react: '^18', 'drizzle-orm': '^0.33', '@libsql/client': '^0.14' },
  devDependencies: { vite: '^5', tsx: '^4' },
}

const fileSet = (paths: string[]) => new Set(paths)
const asFiles = (entries: Record<string, string>) =>
  Object.entries(entries).map(([path, content]) => ({ path, content }))

describe('webExportService portable export path policy', () => {
  it('skips secret-like files', () => {
    expect(shouldSkipPortableExportPath('.env')).toBe(true)
    expect(shouldSkipPortableExportPath('.env.local')).toBe(true)
    expect(shouldSkipPortableExportPath('.npmrc')).toBe(true)
    expect(shouldSkipPortableExportPath('.netrc')).toBe(true)
    expect(shouldSkipPortableExportPath('keys/id_rsa')).toBe(true)
    expect(shouldSkipPortableExportPath('certs/app.pem')).toBe(true)
    expect(shouldSkipPortableExportPath('firebase/serviceAccount.json')).toBe(true)
    expect(shouldSkipPortableExportPath('config/api-token.json')).toBe(true)
  })

  it('allows safe project dotfiles', () => {
    expect(shouldSkipPortableExportPath('.env.example')).toBe(false)
    expect(shouldSkipPortableExportPath('.gitignore')).toBe(false)
    expect(shouldSkipPortableExportPath('.dockerignore')).toBe(false)
    expect(shouldSkipPortableExportPath('.npmrc.example')).toBe(false)
  })

  it('never exports the agent plan file', () => {
    expect(shouldSkipPortableExportPath('PLAN.md')).toBe(true)
    expect(shouldSkipPortableExportPath('plan.md')).toBe(true)
    expect(shouldSkipPortableExportPath('docs/PLAN.md')).toBe(true)
    // TMS.md continues to travel (project manifest, deliberately included).
    expect(shouldSkipPortableExportPath('TMS.md')).toBe(false)
  })

  it('skips hidden and generated project state directories', () => {
    expect(shouldSkipPortableExportPath('.codex/config.md')).toBe(true)
    expect(shouldSkipPortableExportPath('.toquemedia/project.json')).toBe(true)
    expect(shouldSkipPortableExportPath('.vscode/settings.json')).toBe(true)
    expect(shouldSkipPortableExportPath('node_modules/react/index.js')).toBe(true)
    expect(shouldSkipPortableExportPath('dist/index.html')).toBe(true)
  })

  it('allows normal text source files', () => {
    expect(shouldSkipPortableExportPath('package.json')).toBe(false)
    expect(shouldSkipPortableExportPath('src/App.tsx')).toBe(false)
    expect(shouldSkipPortableExportPath('src/styles.css')).toBe(false)
    expect(shouldSkipPortableExportPath('README.md')).toBe(false)
  })

  it('allows normal source directories', () => {
    expect(shouldSkipPortableExportPath('src', { isDirectory: true })).toBe(false)
    expect(shouldSkipPortableExportPath('src/components', { isDirectory: true })).toBe(false)
    expect(shouldSkipPortableExportPath('public/assets', { isDirectory: true })).toBe(false)
  })

  it('allows media assets (ported as base64 so they work on the published site)', () => {
    expect(shouldSkipPortableExportPath('public/logo.png')).toBe(false)
    expect(shouldSkipPortableExportPath('assets/video.mp4')).toBe(false)
    expect(shouldSkipPortableExportPath('src/fonts/inter.woff2')).toBe(false)
  })

  it('skips unsupported binary paths', () => {
    expect(shouldSkipPortableExportPath('tools/helper.exe')).toBe(true)
    expect(shouldSkipPortableExportPath('vendor/lib.so')).toBe(true)
    expect(shouldSkipPortableExportPath('data/blob.bin')).toBe(true)
  })
})

describe('fullstack detection contract (parity fixtures)', () => {
  it('single-package fullstack (fila1 layout): server/ entrypoint + server deps at root', () => {
    const paths = fileSet(['package.json', 'server/index.ts', 'src/App.tsx', 'index.html'])
    expect(detectBackendDir(paths, FILA1_PKG)).toBe('server')
    expect(detectFramework(asFiles({ 'server/index.ts': '' }), FILA1_PKG)).toBe('react-vite-fullstack')
  })

  it('backend with its own package.json wins regardless of root deps', () => {
    const paths = fileSet(['package.json', 'server/package.json'])
    expect(detectBackendDir(paths, { dependencies: { react: '^18' } })).toBe('server')
  })

  it('backend/ directory variant is recognized', () => {
    const paths = fileSet(['package.json', 'backend/index.ts'])
    expect(detectBackendDir(paths, { dependencies: { fastify: '^4' } })).toBe('backend')
  })

  it('a server/ folder WITHOUT a server-framework dep at root is not a backend', () => {
    const paths = fileSet(['package.json', 'server/index.ts'])
    expect(detectBackendDir(paths, { dependencies: { react: '^18', vite: '^5' } })).toBeUndefined()
  })

  it('plain react-vite without backend stays react-vite', () => {
    const pkg: PackageJson = { dependencies: { react: '^18' }, devDependencies: { vite: '^5' } }
    expect(detectFramework(asFiles({ 'src/App.tsx': '' }), pkg)).toBe('react-vite')
  })

  it('database detection: deps, drizzle schema, or migration .sql files', () => {
    expect(detectDatabase([], FILA1_PKG)).toBe(true)
    expect(detectDatabase(
      asFiles({ 'server/schema.ts': "export const users = sqliteTable('users', {})" }),
      { dependencies: {} },
    )).toBe(true)
    expect(detectDatabase(
      asFiles({ 'server/migrations/0000_init.sql': 'CREATE TABLE users (id integer);' }),
      { dependencies: {} },
    )).toBe(true)
    expect(detectDatabase(asFiles({ 'src/App.tsx': '' }), { dependencies: { react: '^18' } })).toBe(false)
  })
})
