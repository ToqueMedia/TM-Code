import { formatCompactElapsed } from '../useCompactionProgress'

// A percentagem foi APAGADA a 2026-08-06 e os casos que a cobriam com ela.
// Era uma ease sobre o relógio: numa compactação real de ~15s ia a ~28% e
// desaparecia, e o developer leu "correu ou fingiu" sobre uma compactação que
// libertou 63% da janela. A referência (cli-vaz) não tem percentagem — tem um
// spinner com etiqueta. O que sobra aqui é o tempo decorrido, que é MEDIDO.
describe('formatCompactElapsed', () => {
  it('abaixo de um minuto conta segundos', () => {
    expect(formatCompactElapsed(0)).toBe('0s')
    expect(formatCompactElapsed(15_000)).toBe('15s')
    expect(formatCompactElapsed(59_999)).toBe('59s')
  })

  it('a partir de um minuto conta minutos e segundos', () => {
    expect(formatCompactElapsed(60_000)).toBe('1m 0s')
    expect(formatCompactElapsed(95_000)).toBe('1m 35s')
  })
})
