import { create } from 'zustand'
import { usePersonaStore, type Persona } from './personaStore'

/**
 * Modelos atribuídos às PERSONAS pelo admin. Fonte real-time: o documento
 * Firestore `system/aiPersonas` (uma entrada por persona publicada), lido UMA
 * vez com onSnapshot no firebaseAuth (fora de qualquer componente).
 *
 * SUBSTITUI o antigo `activeModelId` de modelo único (doc
 * `system/aiActiveModel`, abandonado 2026-08-05 SEM compatibilidade — decisão
 * do developer: com 3 personas um doc de modelo único não representa nada, e
 * era ele que fazia o selector de effort mostrar a escala do modelo errado).
 *
 * O fallback do selector/header de effort é o modelo DA PERSONA SELECIONADA —
 * trocar de persona muda a escala imediatamente, sem esperar pela primeira
 * resposta. O X-TM-Model servido (agentStore.modelName) continua a ter
 * prioridade quando existe (resolveEffortModelId, served-first desde 05-08).
 *
 * ATT (produto): os ids NUNCA são revelados ao user — servem só de lógica.
 *
 * NÃO tem side-effects (o "reset-on-change" antigo causava flip-flop e apagava
 * a preferência do user; `resolveEffectiveEffort` resolve sem estado).
 */
interface ActiveModelState {
  /** `{ standard: 'mimo-v2.5-pro', expert: 'glm-5.2', ... }` — só personas publicadas. */
  personaModels: Partial<Record<Persona, string>>
  setPersonaModels: (map: Partial<Record<Persona, string>>) => void
}

export const useActiveModelStore = create<ActiveModelState>((set) => ({
  personaModels: {},
  setPersonaModels: (map) => set({ personaModels: map }),
}))

/**
 * Modelo de fallback para a persona SELECIONADA (uso fora de React —
 * buildExtraHeaders, carimbos). Componentes devem subscrever os dois stores.
 */
export function getPersonaFallbackModelId(): string | null {
  const persona = usePersonaStore.getState().selected
  return useActiveModelStore.getState().personaModels[persona] ?? null
}
