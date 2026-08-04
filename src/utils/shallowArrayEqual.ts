/**
 * Igualdade rasa de arrays por REFERÊNCIA dos elementos.
 *
 * Feita para comparadores de `memo` cujos props-array são RECONSTRUÍDOS a
 * cada render do pai mas cujos ELEMENTOS preservam identidade (ex.:
 * toolCalls — updateToolCallProgress troca só a referência do alvo, os
 * restantes mantêm-se).
 *
 * Task #14 (profile de 2026-08-04): durante o streaming, os lotes
 * (ExplorationBatch/ReadOutputBatch/ShellSessionBlock) recebiam arrays
 * novos por flush — o memo shallow default nunca segurava e a árvore
 * Chakra dos lotes re-renderizava inteira ~10×/s; o self-time das janelas
 * de 0.65-0.81s era dominado por resolução de props Chakra/Emotion
 * (simpleHash/registerStyles/splitProps). Com esta comparação, um lote
 * cujas calls já terminaram salta o re-render por completo.
 */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
