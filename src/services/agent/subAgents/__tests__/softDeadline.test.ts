import { createSoftDeadlineNotice, SOFT_DEADLINE_FRACTION } from '../softDeadline'

/**
 * O prazo suave existe para o corte duro do wall-clock nunca decapitar um
 * sub-agente a meio de uma frase (05-08: um Explore trabalhou 15 min e
 * entregou um mapeamento cortado). Estes testes fixam o contrato de tempo —
 * é o tipo de lógica que se degrada em silêncio.
 */
describe('prazo suave do sub-agente', () => {
  const FIFTEEN_MIN = 15 * 60 * 1000

  it('cala-se enquanto houver tempo', async () => {
    let clock = 0
    const collect = createSoftDeadlineNotice({ maxWallClockMs: FIFTEEN_MIN, now: () => clock })

    expect(await collect()).toBeNull()
    clock = FIFTEEN_MIN * SOFT_DEADLINE_FRACTION - 1
    expect(await collect()).toBeNull()
  })

  it('pede o fecho ao atingir a fracção do relógio', async () => {
    let clock = 0
    const collect = createSoftDeadlineNotice({ maxWallClockMs: FIFTEEN_MIN, now: () => clock })

    clock = FIFTEEN_MIN * SOFT_DEADLINE_FRACTION
    const notice = await collect()

    expect(notice).toContain('system-reminder')
    expect(notice).toContain('STOP exploring now')
    // Diz quanto tempo resta (20% de 15 min = 3 min) e pede as lacunas.
    expect(notice).toContain('3 minute(s)')
    expect(notice).toContain('could NOT cover')
  })

  it('entrega UMA vez só — repetir a cada turno seria ruído', async () => {
    let clock = FIFTEEN_MIN
    const collect = createSoftDeadlineNotice({
      maxWallClockMs: FIFTEEN_MIN,
      now: () => clock,
    })
    // O relógio já ia adiantado quando o coletor nasceu, por isso o prazo é
    // relativo ao arranque do RUN, não ao epoch.
    expect(await collect()).toBeNull()

    clock += FIFTEEN_MIN * SOFT_DEADLINE_FRACTION
    expect(await collect()).not.toBeNull()
    expect(await collect()).toBeNull()
    expect(await collect()).toBeNull()
  })

  it('arredonda para pelo menos 1 minuto em relógios curtos', async () => {
    let clock = 0
    const collect = createSoftDeadlineNotice({ maxWallClockMs: 30_000, now: () => clock })
    clock = 30_000
    expect(await collect()).toContain('1 minute(s)')
  })
})
