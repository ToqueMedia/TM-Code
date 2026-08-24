/**
 * Regression test for the "Mac sees 192.168.64.1:8787" bug.
 *
 * Root cause: `.env` declares VITE_WORKER_URL + VITE_OLLAMA_URL as the UTM
 * gateway IP (Windows convention). Vite bakes those values on every OS, so
 * a Mac dev ends up making cross-machine calls to a gateway that only exists
 * on the Windows host. `resolveUrl` re-maps `192.168.64.1` → `localhost` on
 * non-Windows dev while preserving port/path, Windows dev (verbatim), and
 * production (always verbatim).
 *
 * The pure `resolveUrl(input)` is exercised directly — no module mocking
 * required. The wrapper `resolveWorkerUrl()` / `resolveOllamaUrl()` just
 * forwards real runtime values into the same pure function.
 */
import { resolveUrl } from '../devUrls'

describe('resolveUrl — pure resolver', () => {
  describe('Mac / Linux dev with UTM gateway env value → remap to localhost', () => {
    it('Mac dev env=192.168.64.1:8787 → localhost:8787', () => {
      expect(resolveUrl({
        envValue: 'http://192.168.64.1:8787',
        fallback: 'http://localhost:8787',
        isViteDev: true,
        isWindows: false,
      })).toBe('http://localhost:8787')
    })

    it('Linux dev env=192.168.64.1:11434 → localhost:11434', () => {
      expect(resolveUrl({
        envValue: 'http://192.168.64.1:11434',
        fallback: 'http://localhost:11434',
        isViteDev: true,
        isWindows: false,
      })).toBe('http://localhost:11434')
    })

    it('preserves path segments when remapping', () => {
      expect(resolveUrl({
        envValue: 'http://192.168.64.1:8787/v1/messages',
        fallback: 'http://localhost:8787',
        isViteDev: true,
        isWindows: false,
      })).toBe('http://localhost:8787/v1/messages')
    })
  })

  describe('Windows dev → env value stays verbatim (UTM gateway is correct)', () => {
    it('Windows dev env=192.168.64.1:8787 stays', () => {
      expect(resolveUrl({
        envValue: 'http://192.168.64.1:8787',
        fallback: 'http://localhost:8787',
        isViteDev: true,
        isWindows: true,
      })).toBe('http://192.168.64.1:8787')
    })

    it('Windows dev env=192.168.64.1:11434 stays', () => {
      expect(resolveUrl({
        envValue: 'http://192.168.64.1:11434',
        fallback: 'http://localhost:11434',
        isViteDev: true,
        isWindows: true,
      })).toBe('http://192.168.64.1:11434')
    })
  })

  describe('Production build → env value stays verbatim regardless of OS', () => {
    it('Mac prod with HTTPS remote URL', () => {
      expect(resolveUrl({
        envValue: 'https://api-agents.toquemedia.net',
        fallback: 'http://localhost:8787',
        isViteDev: false,
        isWindows: false,
      })).toBe('https://api-agents.toquemedia.net')
    })

    it('Mac prod with 192.168.64.1 falls back (sanitizes local IP gateway in production builds)', () => {
      expect(resolveUrl({
        envValue: 'http://192.168.64.1:8787',
        fallback: 'https://api-agents.toquemedia.net',
        isViteDev: false,
        isWindows: false,
      })).toBe('https://api-agents.toquemedia.net')
    })

    it('Windows prod with HTTPS URL stays', () => {
      expect(resolveUrl({
        envValue: 'https://api-agents.toquemedia.net',
        fallback: 'http://localhost:8787',
        isViteDev: false,
        isWindows: true,
      })).toBe('https://api-agents.toquemedia.net')
    })
  })

  describe('no env value → fallback on every OS/mode', () => {
    it('Mac dev no env → fallback', () => {
      expect(resolveUrl({
        envValue: undefined,
        fallback: 'http://localhost:8787',
        isViteDev: true,
        isWindows: false,
      })).toBe('http://localhost:8787')
    })

    it('Windows prod no env → fallback', () => {
      expect(resolveUrl({
        envValue: undefined,
        fallback: 'http://localhost:11434',
        isViteDev: false,
        isWindows: true,
      })).toBe('http://localhost:11434')
    })
  })

  describe('non-gateway URLs → never rewritten', () => {
    it('Mac dev env=10.0.0.5:8787 (user override) stays', () => {
      expect(resolveUrl({
        envValue: 'http://10.0.0.5:8787',
        fallback: 'http://localhost:8787',
        isViteDev: true,
        isWindows: false,
      })).toBe('http://10.0.0.5:8787')
    })

    it('Mac dev env=http://my-ollama.local:11434 stays', () => {
      expect(resolveUrl({
        envValue: 'http://my-ollama.local:11434',
        fallback: 'http://localhost:11434',
        isViteDev: true,
        isWindows: false,
      })).toBe('http://my-ollama.local:11434')
    })

    it('does not match a URL that merely contains 192.168.64.1 as a path segment', () => {
      // Hypothetical edge case — the regex is anchored to the host position.
      expect(resolveUrl({
        envValue: 'http://localhost:8787/proxy/192.168.64.1',
        fallback: 'http://localhost:8787',
        isViteDev: true,
        isWindows: false,
      })).toBe('http://localhost:8787/proxy/192.168.64.1')
    })
  })
})

