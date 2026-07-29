import {
  clearReadRangeTracker,
  getReadRanges,
  recordReadRange,
} from '../toolExecutor/readRangeTracker'

/**
 * O que este módulo faz DEPOIS da limpeza de 2026-07-29.
 *
 * Os testes anteriores exercitavam `checkReadRangeOverlap` — a dedup de
 * intervalos sobrepostos que devolvia stubs e ESTREITAVA pedidos em silêncio.
 * Essa parte saiu com o resto da supressão de releituras (paridade claude-vaz;
 * causa medida na sessão katondo-queue: 175 read_file em 127 turnos, 12,36M
 * tokens de input, tarefa por acabar), e o código ficou aqui sem chamadores,
 * com textos de stub a mandar usar um `force: true` que já não existe no schema.
 *
 * Fica o REGISTO, que tem dois consumidores reais: o `contextManager` sugere
 * releituras depois de uma compactação (aí o conteúdo saiu de facto do contexto)
 * e a telemetria de request-usage exporta `readRanges`.
 */
describe('readRangeTracker (registo)', () => {
  beforeEach(() => {
    clearReadRangeTracker()
  })

  it('registra um intervalo e distingue leitura-até-ao-fim', () => {
    recordReadRange('/repo/a.ts', 1, undefined, 1, 1000)

    expect(getReadRanges()).toEqual([
      { path: '/repo/a.ts', offset: 1, limit: undefined, readToEnd: true },
    ])
  })

  it('registra intervalos limitados com o seu limite', () => {
    recordReadRange('/repo/a.ts', 30, 70, 1, 1000)

    expect(getReadRanges()).toEqual([
      { path: '/repo/a.ts', offset: 30, limit: 70, readToEnd: false },
    ])
  })

  it('acumula vários intervalos do mesmo ficheiro', () => {
    recordReadRange('/repo/a.ts', 1, 50, 1, 1000)
    recordReadRange('/repo/a.ts', 200, 50, 1, 1000)

    const ranges = getReadRanges().filter(r => r.path === '/repo/a.ts')
    expect(ranges).toHaveLength(2)
    expect(ranges.map(r => r.offset).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 200])
  })

  it('separa ficheiros diferentes', () => {
    recordReadRange('/repo/a.ts', 1, 10, 1, 1000)
    recordReadRange('/repo/b.ts', 1, 10, 1, 1000)

    expect(new Set(getReadRanges().map(r => r.path))).toEqual(
      new Set(['/repo/a.ts', '/repo/b.ts']),
    )
  })

  it('clearReadRangeTracker esvazia o registo', () => {
    recordReadRange('/repo/a.ts', 1, undefined, 1, 1000)
    clearReadRangeTracker()

    expect(getReadRanges()).toEqual([])
  })

  it('getReadRanges devolve uma cópia — mexer no resultado não corrompe o estado', () => {
    recordReadRange('/repo/a.ts', 1, undefined, 1, 1000)
    const first = getReadRanges()
    first.length = 0

    expect(getReadRanges()).toHaveLength(1)
  })
})
