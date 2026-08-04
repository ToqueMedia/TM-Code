import { create } from 'zustand'

/**
 * Persona do modelo escolhida pelo utilizador — Escolha do Modelo (2026-08-04).
 *
 * O produto NUNCA revela os modelos geridos (white-labeling, decisão
 * 2026-06-16): o selector expõe três PERSONAS — Standard, Expert, Master — e
 * o admin atribui a cada uma um modelo do catálogo + um multiplicador de
 * custo (painel Personas no Settings → control-plane → KV `persona:*`).
 *
 * A escolha viaja no header `X-TM-Persona` (buildExtraHeaders, managed-only;
 * BYOK fala directo com o provider e não passa pelo data-plane). O worker
 * roteia para a config da persona publicada; persona não publicada degrada
 * SILENCIOSAMENTE para a config ativa — por isso o selector pode existir na
 * UI antes de o admin publicar as três, sem partir nada.
 *
 * Preferência CROSS-PROJECT, em localStorage (mesmo padrão do
 * reasoningEffortStore).
 */

export const PERSONAS = ['standard', 'expert', 'master'] as const
export type Persona = (typeof PERSONAS)[number]

export const DEFAULT_PERSONA: Persona = 'standard'

const STORAGE_KEY = 'tm_model_persona'

function isPersona(value: unknown): value is Persona {
  return typeof value === 'string' && (PERSONAS as readonly string[]).includes(value)
}

function loadSelected(): Persona {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isPersona(raw) ? raw : DEFAULT_PERSONA
  } catch {
    return DEFAULT_PERSONA
  }
}

function saveSelected(value: Persona): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* storage unavailable — mantém em memória */
  }
}

interface PersonaStoreState {
  selected: Persona
  setSelected: (persona: Persona) => void
}

export const usePersonaStore = create<PersonaStoreState>((set) => ({
  selected: loadSelected(),
  setSelected: (persona) => {
    if (!isPersona(persona)) return
    saveSelected(persona)
    set({ selected: persona })
  },
}))
