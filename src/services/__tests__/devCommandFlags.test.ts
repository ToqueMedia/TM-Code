import { appendDevFlags } from '../devCommandFlags'

describe('appendDevFlags', () => {
  it('uses the -- separator for package-manager commands', () => {
    expect(appendDevFlags('npm run dev', '--port 7773')).toBe('npm run dev -- --port 7773')
    expect(appendDevFlags('pnpm dev', '--host 0.0.0.0')).toBe('pnpm dev -- --host 0.0.0.0')
    expect(appendDevFlags('yarn start', '--port 7773')).toBe('yarn start -- --port 7773')
    expect(appendDevFlags('bun run dev', '--port 7773')).toBe('bun run dev -- --port 7773')
  })

  it('appends directly for framework binaries (no separator)', () => {
    expect(appendDevFlags('vite', '--port 7773')).toBe('vite --port 7773')
    expect(appendDevFlags('next dev', '--port 7773')).toBe('next dev --port 7773')
    expect(appendDevFlags('npx ng serve', '--host 0.0.0.0')).toBe('npx ng serve --host 0.0.0.0')
    expect(appendDevFlags('astro dev', '--port 7773')).toBe('astro dev --port 7773')
  })

  it('returns null for unrecognised command shapes', () => {
    expect(appendDevFlags('node server.js', '--port 7773')).toBeNull()
    expect(appendDevFlags('./serve.sh', '--port 7773')).toBeNull()
    expect(appendDevFlags('', '--port 7773')).toBeNull()
  })
})
