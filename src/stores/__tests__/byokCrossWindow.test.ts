/**
 * BYOK entre janelas — o clobber que fazia a definição "não persistir".
 *
 * O TM Code é multi-janela por desenho (uma janela = um processo = um
 * projecto) e todas partilham o mesmo localStorage: a origem é a mesma
 * (localhost:14300 em produção). O `persist` do zustand hidrata UMA vez, na
 * criação do store, e depois reescreve a fatia INTEIRA a cada `set`.
 *
 * Daí o defeito, que da janela do utilizador parece perda de persistência:
 *
 *   1. janelas A e B abertas, ambas hidrataram com enabled:false;
 *   2. utilizador liga o BYOK em A → disco fica enabled:true;
 *   3. B continua com enabled:false em memória e qualquer escrita sua
 *      reescreve a fatia toda — o `loadProviders()` faz isso a cada
 *      autenticação, portanto basta B refrescar;
 *   4. disco volta a false → no arranque seguinte o toggle está desligado.
 *
 * O `authStore` e o `personaStore` já tinham o listener de `storage` que
 * fecha isto; o byokStore não tinha.
 */
jest.mock('@/utils/invokeMetrics', () => ({ invoke: jest.fn(async () => false) }))
jest.mock('../../utils/invokeMetrics', () => ({ invoke: jest.fn(async () => false) }))
jest.mock('../../services/tauriFetch', () => ({ tauriFetch: jest.fn() }))

import { useByokStore, BYOK_STORAGE_KEY } from '../byokStore'

/** O que outra janela teria escrito no disco. */
function writeFromAnotherWindow(state: Record<string, unknown>): string {
  const raw = JSON.stringify({ state, version: 0 })
  localStorage.setItem(BYOK_STORAGE_KEY, raw)
  return raw
}

/** O evento que o browser dispara nas OUTRAS janelas da mesma origem. */
function fireStorageEvent(newValue: string | null, key = BYOK_STORAGE_KEY): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
}

describe('byokStore — persistência', () => {
  beforeEach(() => {
    localStorage.clear()
    useByokStore.setState({ enabled: false, activeProvider: null, activeModel: null })
  })

  it('ligar o BYOK escreve mesmo no localStorage', () => {
    // Sanidade: se o lado da ESCRITA estivesse partido, o teste seguinte
    // passaria por vácuo e a conclusão seria a errada.
    useByokStore.getState().toggle(true)
    const raw = JSON.parse(localStorage.getItem(BYOK_STORAGE_KEY) ?? '{}')
    expect(raw.state.enabled).toBe(true)
  })

  it('a chave do listener é a MESMA do persist', () => {
    // Se divergirem, a sincronia deixa de disparar sem nenhum sinal.
    useByokStore.getState().toggle(true)
    expect(localStorage.getItem(BYOK_STORAGE_KEY)).not.toBeNull()
  })
})

describe('byokStore — sincronia entre janelas', () => {
  beforeEach(() => {
    localStorage.clear()
    useByokStore.setState({ enabled: false, activeProvider: null, activeModel: null })
  })

  it('adopta o enabled que outra janela gravou', async () => {
    expect(useByokStore.getState().enabled).toBe(false)

    const raw = writeFromAnotherWindow({
      enabled: true,
      activeProvider: 'anthropic',
      activeModel: 'claude-x',
      perProviderConfig: {},
    })
    fireStorageEvent(raw)
    // rehydrate() é assíncrono na API do zustand.
    await Promise.resolve()
    await Promise.resolve()

    expect(useByokStore.getState().enabled).toBe(true)
    expect(useByokStore.getState().activeProvider).toBe('anthropic')
  })

  it('depois de sincronizar, uma escrita LOCAL já não desfaz a outra janela', async () => {
    // Este é o teste que representa o bug de facto: o passo 3 da história.
    // Sem o listener, o `set` abaixo reescrevia a fatia com enabled:false.
    const raw = writeFromAnotherWindow({
      enabled: true, activeProvider: 'anthropic', activeModel: 'claude-x', perProviderConfig: {},
    })
    fireStorageEvent(raw)
    await Promise.resolve()
    await Promise.resolve()

    // Uma escrita qualquer, do género das que o loadProviders() faz.
    useByokStore.getState().markConfigured('ollama', true)

    const onDisk = JSON.parse(localStorage.getItem(BYOK_STORAGE_KEY) ?? '{}')
    expect(onDisk.state.enabled).toBe(true)
    expect(onDisk.state.activeProvider).toBe('anthropic')
  })

  it('ignora eventos de outras chaves e remoções', async () => {
    useByokStore.setState({ enabled: true })
    fireStorageEvent(JSON.stringify({ state: { enabled: false } }), 'outra-chave')
    fireStorageEvent(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(useByokStore.getState().enabled).toBe(true)
  })

  it('a rehidratação não apaga o estado que NÃO é persistido', async () => {
    // `providers` e `catalogLoaded` são de memória. Se o merge os limpasse,
    // sincronizar entre janelas apagava o catálogo e a UI ficava vazia.
    useByokStore.setState({
      providers: [{ id: 'x', name: 'X', enabled: true, defaultBaseURL: '', authHeader: '', authPrefix: '', apiShape: 'openai_compat', models: [] }],
      catalogLoaded: true,
    })
    const raw = writeFromAnotherWindow({ enabled: true, activeProvider: null, activeModel: null, perProviderConfig: {} })
    fireStorageEvent(raw)
    await Promise.resolve()
    await Promise.resolve()

    expect(useByokStore.getState().catalogLoaded).toBe(true)
    expect(useByokStore.getState().providers).toHaveLength(1)
  })
})
