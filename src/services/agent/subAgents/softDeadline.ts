/**
 * Prazo suave dos sub-agentes.
 *
 * PORQUÊ (2026-08-05): o `maxWallClockMs` era um corte SECO — aos 15 minutos o
 * AbortController matava o loop e o "resultado parcial" entregue ao agente
 * principal era o texto que tivesse sido transmitido até ao golpe, muitas
 * vezes a meio de uma frase. Numa sessão real (05-08) um Explore trabalhou ~15
 * min, foi decapitado, e o principal ficou com um mapeamento incompleto sem
 * saber o que faltava.
 *
 * Agora, a 80% do relógio, injecta-se UMA vez um lembrete a mandar fechar com
 * o que já se sabe. O corte duro fica como rede de segurança. Viaja pelo canal
 * de steering do loop (`collectQueuedSteering`), consumido nas fronteiras
 * entre turnos — não interrompe um turno a meio.
 *
 * Módulo próprio e puro (sem stores, sem Tauri) para ser testável: a lógica é
 * de tempo, e tempo silenciosamente errado não dá erro, dá trabalho perdido.
 */

/** Fracção do relógio a partir da qual se pede o fecho. */
export const SOFT_DEADLINE_FRACTION = 0.8

export interface SoftDeadlineOptions {
  maxWallClockMs: number
  /** Injectável nos testes. Por omissão, `Date.now`. */
  now?: () => number
}

/**
 * Devolve um coletor compatível com `QueryEngineOptions.collectQueuedSteering`:
 * `null` enquanto houver tempo, o lembrete UMA vez depois do prazo suave, e
 * `null` para sempre a seguir (não vale a pena repetir — ou o agente fecha, ou
 * o corte duro trata dele).
 */
export function createSoftDeadlineNotice(
  options: SoftDeadlineOptions,
): () => Promise<string | null> {
  const now = options.now ?? Date.now
  const deadlineAt = now() + Math.floor(options.maxWallClockMs * SOFT_DEADLINE_FRACTION)
  let delivered = false

  return async () => {
    if (delivered || now() < deadlineAt) return null
    delivered = true
    const remainingMin = Math.max(
      1,
      Math.round((options.maxWallClockMs * (1 - SOFT_DEADLINE_FRACTION)) / 60_000),
    )
    return [
      '<system-reminder>',
      `Time budget: about ${remainingMin} minute(s) left before this task is cut off.`,
      'STOP exploring now and write your final report with what you already know.',
      'Partial findings delivered on time are useful; a cut-off mid-sentence is not.',
      'State explicitly what you could NOT cover so the caller knows the gaps.',
      'If your report is already written, just stop — do not repeat it.',
      '</system-reminder>',
    ].join('\n')
  }
}
