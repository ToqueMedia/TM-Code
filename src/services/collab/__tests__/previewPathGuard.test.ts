import { isBlockedPreviewPath } from '../previewPathGuard'

describe('isBlockedPreviewPath', () => {
  it('blocks secret / VCS / key paths', () => {
    expect(isBlockedPreviewPath('/.env')).toBe(true)
    expect(isBlockedPreviewPath('/.env.local')).toBe(true)
    expect(isBlockedPreviewPath('/sub/.env.production')).toBe(true)
    expect(isBlockedPreviewPath('/.git/config')).toBe(true)
    expect(isBlockedPreviewPath('/.ssh/id_rsa')).toBe(true)
    expect(isBlockedPreviewPath('/keys/id_ed25519')).toBe(true)
    expect(isBlockedPreviewPath('/certs/server.pem')).toBe(true)
    expect(isBlockedPreviewPath('/app.key')).toBe(true)
    expect(isBlockedPreviewPath('/.npmrc')).toBe(true)
    expect(isBlockedPreviewPath('/.aws/credentials')).toBe(true)
    // Query strings are stripped before matching.
    expect(isBlockedPreviewPath('/.env?t=1')).toBe(true)
  })

  it('allows normal app + Vite-internal module paths', () => {
    expect(isBlockedPreviewPath('/')).toBe(false)
    expect(isBlockedPreviewPath('/index.html')).toBe(false)
    expect(isBlockedPreviewPath('/src/main.tsx')).toBe(false)
    expect(isBlockedPreviewPath('/@vite/client')).toBe(false)
    expect(isBlockedPreviewPath('/@fs/Users/dev/app/src/App.tsx')).toBe(false)
    expect(isBlockedPreviewPath('/assets/logo.svg')).toBe(false)
    expect(isBlockedPreviewPath('/environment.js')).toBe(false) // not ".env"
  })
})
