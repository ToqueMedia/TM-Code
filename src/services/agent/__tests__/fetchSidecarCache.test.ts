/**
 * Cache de conteúdo por URL — porte do `URL_CACHE` do claude-vaz (15 min).
 *
 * Não a portei na primeira versão, e com o contrato novo ela passou a valer
 * MAIS do que valia: repetir um URL custava rede **e** uma chamada ao modelo.
 * Cacheia-se o CONTEÚDO, não a resposta — o mesmo `prompt` raramente se
 * repete, mas a mesma página sim (o agente volta ao mesmo doc com perguntas
 * diferentes), portanto a 2.ª pergunta poupa a rede e só paga o modelo.
 */
import { getCachedPageContent, cachePageContent, clearPageCache, answerFromPageViaSidecar } from '../fetchSidecar'
import { logger } from '../../../utils/logger'

const URL_A = 'https://x.test/a'
const URL_B = 'https://x.test/b'

describe('cache de páginas', () => {
  beforeEach(() => {
    clearPageCache()
    jest.useRealTimers()
  })

  it('devolve o que foi guardado', () => {
    cachePageContent(URL_A, 'conteúdo da página')
    expect(getCachedPageContent(URL_A)).toBe('conteúdo da página')
    expect(getCachedPageContent(URL_B)).toBeNull()
  })

  it('expira aos 15 minutos', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-31T10:00:00Z'))
    cachePageContent(URL_A, 'fresco')
    jest.setSystemTime(new Date('2026-07-31T10:14:00Z'))
    expect(getCachedPageContent(URL_A)).toBe('fresco')
    jest.setSystemTime(new Date('2026-07-31T10:16:00Z'))
    expect(getCachedPageContent(URL_A)).toBeNull()
  })

  it('não guarda páginas enormes — a memória é do editor do developer', () => {
    cachePageContent(URL_A, 'x'.repeat(400_001))
    expect(getCachedPageContent(URL_A)).toBeNull()
  })

  it('despeja as entradas mais antigas acima do tecto', () => {
    for (let i = 0; i < 30; i++) cachePageContent(`https://x.test/${i}`, `p${i}`)
    // As primeiras saíram; as últimas ficaram.
    expect(getCachedPageContent('https://x.test/0')).toBeNull()
    expect(getCachedPageContent('https://x.test/29')).toBe('p29')
  })

  it('um acerto renova a posição — LRU, não FIFO', () => {
    for (let i = 0; i < 24; i++) cachePageContent(`https://x.test/${i}`, `p${i}`)
    // Tocar na entrada 0 põe-na no fim da ordem de despejo…
    expect(getCachedPageContent('https://x.test/0')).toBe('p0')
    // …portanto a próxima inserção despeja a 1, não a 0.
    cachePageContent('https://x.test/novo', 'novo')
    expect(getCachedPageContent('https://x.test/0')).toBe('p0')
    expect(getCachedPageContent('https://x.test/1')).toBeNull()
  })
})

describe('sidecar — nenhuma saída silenciosa', () => {
  // Em produção o sidecar devolveu texto bruto sem UMA linha no console:
  // as saídas antecipadas estavam fora do try e sem log, portanto "não
  // correu" e "correu e desistiu" eram indistinguíveis. Pior, uma excepção
  // no pré-voo propagava para o caller, que a engolia — sintoma idêntico.
  // É o mesmo defeito que corrigi no editDiagnostics horas antes.
  const seen: string[] = []
  beforeEach(() => {
    seen.length = 0
    jest.spyOn(logger, 'info').mockImplementation((_c, m) => { seen.push(String(m)) })
    jest.spyOn(logger, 'warn').mockImplementation((_c, m) => { seen.push(String(m)) })
  })
  afterEach(() => jest.restoreAllMocks())

  it('sem prompt: devolve null E diz porquê', async () => {
    expect(await answerFromPageViaSidecar('conteúdo', '   ', 'https://x.test')).toBeNull()
    expect(seen.join(' ')).toMatch(/sem conteúdo ou sem prompt/)
  })

  it('run abortado: devolve null E diz porquê', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await answerFromPageViaSidecar('conteúdo', 'pergunta', 'https://x.test', ac.signal)).toBeNull()
    expect(seen.join(' ')).toMatch(/run já abortado/)
  })

  it('pré-voo a rebentar NÃO propaga — o caller não pode engolir a causa', async () => {
    // Sem o try no pré-voo, esta excepção subia ao toolExecutor e morria no
    // catch dele: texto bruto, zero rasto, causa perdida.
    await expect(
      answerFromPageViaSidecar('conteúdo', 'pergunta', 'https://x.test'),
    ).resolves.toBeNull()
    expect(seen.length).toBeGreaterThan(0)
  })
})
