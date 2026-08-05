import { create } from 'zustand'
import { usePersonaStore, type Persona } from './personaStore'

/**
 * Atribuições das PERSONAS pelo admin — modelId E janela de contexto por
 * persona. Fonte real-time: `system/aiPersonas` (onSnapshot no firebaseAuth).
 * Substituiu o doc de modelo único (05-08, sem compat); a janela entrou no
 * doc na mesma data (bug: "a janela das personas não é respeitada" — só o
 * modelId viajava e os clientes caíam na janela do perfil).
 *
 * Resolução: X-TM-Model/X-Model-Context-Window servidos MANDAM; estas
 * entradas são o fallback pré-primeira-resposta pela persona SELECIONADA.
 * ATT: ids nunca aparecem na UI. Sem side-effects.
 */
export interface PersonaModelEntry {
  modelId: string
  contextWindow?: number
}

interface ActiveModelState {
  personaModels: Partial<Record<Persona, PersonaModelEntry>>
  setPersonaModels: (map: Partial<Record<Persona, PersonaModelEntry>>) => void
}

export const useActiveModelStore = create<ActiveModelState>((set) => ({
  personaModels: {},
  setPersonaModels: (map) => set({ personaModels: map }),
}))

/** Modelo de fallback da persona SELECIONADA (uso fora de React). */
export function getPersonaFallbackModelId(): string | null {
  const persona = usePersonaStore.getState().selected
  return useActiveModelStore.getState().personaModels[persona]?.modelId ?? null
}

/** Janela de contexto escolhida pelo admin para a persona SELECIONADA. */
export function getPersonaFallbackContextWindow(): number | null {
  const persona = usePersonaStore.getState().selected
  return useActiveModelStore.getState().personaModels[persona]?.contextWindow ?? null
}
