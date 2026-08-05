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
    // Trocar de persona invalida TUDO o que se sabia do modelo servido — o
    // X-TM-Model E os headers de capacidade/janela pertencem à persona
    // ANTERIOR. A 1ª versão só limpava name/provider (setModelInfo tem
    // semântica undefined=não-tocar) e a auditoria 05-08 apanhou 4 bugs daí:
    // imagem inline enviada a modelo cego (effectiveCapability(true,…) da
    // visão do modelo antigo), auto-compact com a janela da persona anterior
    // (estouro de contexto), prompt a anunciar pesquisa nativa inexistente, e
    // badge de thinking com o modo errado. `null` = "o servidor não declarou"
    // → tudo cai no perfil/fallback da persona até o X-TM-Model real chegar.
    // Import dinâmico para não criar ciclo estático entre stores.
    void import('./agentStore').then(({ useAgentStore }) => {
      useAgentStore.getState().setModelInfo(null, null, null, null, null, { vision: null, search: null })
    }).catch(() => {})
  },
}))
