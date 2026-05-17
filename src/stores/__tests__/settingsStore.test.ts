/**
 * Regression guards for settingsStore.
 *
 * Critical scenario: a Mac user who ran a build that persisted
 * `ollamaUrl: 'http://192.168.64.1:11434'` must self-heal to `localhost:11434`
 * on next app start — without losing their other settings, and without
 * clobbering explicit user overrides.
 *
 * Uses a synthetic localStorage mock + platform-specific mocks of
 * ../../utils/platform so we can simulate both Mac and Windows hosts
 * regardless of where the test actually runs.
 */

// Minimal localStorage shim BEFORE loading the store so the zustand persist
// middleware sees our seeded value during rehydration.
const localStorageMock = {
  store: new Map<string, string>(),
  getItem(key: string) { return this.store.get(key) ?? null },
  setItem(key: string, val: string) { this.store.set(key, val) },
  removeItem(key: string) { this.store.delete(key) },
  clear() { this.store.clear() },
  key() { return null },
  get length() { return this.store.size },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock, writable: true, configurable: true,
})

// navigator.platform needs to be set BEFORE importing platform.ts (which
// reads it at module load). We use jest's module reset + per-test platform
// injection via mock.
jest.mock('../../utils/platform', () => {
  return {
    IS_MAC: false,
    IS_WINDOWS: false,
    IS_LINUX: false,
  }
})

function seedPersistedSettings(ollamaUrl: string) {
  localStorageMock.clear()
  localStorageMock.setItem('settings-storage', JSON.stringify({
    state: {
      editor: { tabSize: 2, insertSpaces: true, detectIndentation: true },
      autocomplete: {
        enabled: true,
        model: 'qwen2.5-coder:7b',
        ollamaUrl,
      },
      formatOnSave: false,
      appLanguage: 'en',
      agentLanguage: 'en',
      shortcuts: {},
      hasCompletedOnboarding: true,
      sandboxEnabled: false,
      flaggedCommands: [],
    },
    version: 0,
  }))
}

async function loadStoreAs(
  platform: 'mac' | 'windows' | 'linux',
  opts: { ollamaEnv?: string; workerEnv?: string } = {},
) {
  jest.resetModules()
  const mocks = {
    IS_MAC: platform === 'mac',
    IS_WINDOWS: platform === 'windows',
    IS_LINUX: platform === 'linux',
  }
  jest.doMock('../../utils/platform', () => mocks)
  // Simulate the real dev setup: .env typically sets both URLs to the UTM
  // gateway (192.168.64.1). The OS-aware resolver should remap them to
  // localhost on Mac/Linux and keep them on Windows.
  jest.doMock('../../utils/viteEnv', () => ({
    DEFAULT_OLLAMA_URL: 'http://localhost:11434',
    DEFAULT_WORKER_URL: 'http://localhost:8787',
    VITE_OLLAMA_URL: opts.ollamaEnv ?? 'http://192.168.64.1:11434',
    VITE_WORKER_URL: opts.workerEnv ?? 'http://192.168.64.1:8787',
    IS_VITE_DEV: true,
  }))
  const mod = await import('../settingsStore')
  return mod.useSettingsStore
}

describe('settingsStore — ollamaUrl self-healing on rehydration', () => {
  afterEach(() => {
    jest.resetModules()
    localStorageMock.clear()
  })

  it('Mac dev with persisted 192.168.64.1 self-heals to localhost', async () => {
    seedPersistedSettings('http://192.168.64.1:11434')
    const useStore = await loadStoreAs('mac')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://localhost:11434')
  })

  it('Windows dev with persisted localhost self-heals to 192.168.64.1', async () => {
    seedPersistedSettings('http://localhost:11434')
    const useStore = await loadStoreAs('windows')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://192.168.64.1:11434')
  })

  it('Mac dev with persisted localhost stays on localhost (no change)', async () => {
    seedPersistedSettings('http://localhost:11434')
    const useStore = await loadStoreAs('mac')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://localhost:11434')
  })

  it('Windows dev with persisted 192.168.64.1 stays (no change)', async () => {
    seedPersistedSettings('http://192.168.64.1:11434')
    const useStore = await loadStoreAs('windows')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://192.168.64.1:11434')
  })

  it('user override (non-auto URL) is preserved verbatim on Mac', async () => {
    seedPersistedSettings('http://192.168.1.50:11434')
    const useStore = await loadStoreAs('mac')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://192.168.1.50:11434')
  })

  it('user override is preserved on Windows too', async () => {
    seedPersistedSettings('http://10.0.0.5:11434')
    const useStore = await loadStoreAs('windows')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://10.0.0.5:11434')
  })

  it('fresh install with nothing persisted uses the platform default (Mac → localhost)', async () => {
    localStorageMock.clear()
    const useStore = await loadStoreAs('mac')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://localhost:11434')
  })

  it('fresh install on Windows uses the Windows dev default', async () => {
    localStorageMock.clear()
    const useStore = await loadStoreAs('windows')
    expect(useStore.getState().autocomplete.ollamaUrl).toBe('http://192.168.64.1:11434')
  })
})
