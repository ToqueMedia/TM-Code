jest.mock('../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getIdToken: jest.fn() })),
  },
}))

import { shouldSkipPortableExportPath } from '../webExportService'

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

  it('skips unsupported binary paths', () => {
    expect(shouldSkipPortableExportPath('public/logo.png')).toBe(true)
    expect(shouldSkipPortableExportPath('assets/video.mp4')).toBe(true)
  })
})
