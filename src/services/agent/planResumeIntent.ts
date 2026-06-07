export type PendingPlanIntent = 'architect' | 'cancel'

function normalise(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Keep this deliberately narrow. Anything that is not an explicit short
 * cancellation goes back to the architect-model context, where the LLM can
 * interpret whether the user is asking to proceed, amend requirements, ask a
 * question, or pause.
 */
export function classifyPendingPlanIntent(input: string): PendingPlanIntent {
  const text = normalise(input)
  if (!text) return 'architect'

  const shortCancel = /^(cancel|cancelar|cancela|abort|abortar|aborta|stop|parar|pare|reject|rejeitar|rejeita|descartar|descarta|esquece|forget it|discard it|no|nao|não)$/
  if (shortCancel.test(text)) return 'cancel'

  const explicitDoNotProceed = /^(do not|dont|don't|nao|não)\s+(proceed|resume|go on|carry on|prosseguir|retomar|avancar|avançar)\b/
  if (explicitDoNotProceed.test(text)) return 'cancel'

  return 'architect'
}
