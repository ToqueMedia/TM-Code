import { create } from 'zustand'

/**
 * Reasoning-effort escolhido pelo utilizador — o VALOR NATIVO do provider
 * (ex.: 'xhigh', 'low', 'medium', 'on', 'off'), não um low/high/max normalizado
 * (redesenho 07-23: expor cada valor real do modelo). As OPÇÕES disponíveis não
 * vivem aqui — vêm do modelo ativo via header `X-Model-Reasoning-Efforts`
 * (agentStore.reasoningEffortOptions). Este store só guarda a ESCOLHA do user.
 *
 * O valor é enviado no header `X-TM-Reasoning-Effort` (buildExtraHeaders,
 * managed-only); o worker VALIDA-o contra as options do modelo e ignora-o se
 * não pertencer (ex.: 'xhigh' do GLM enviado a um Grok → cai no default). Por
 * isso a IDE pode persistir uma escolha e reusá-la entre modelos onde o valor
 * existe (ex.: 'low', 'high').
 *
 * `selected = null` → usar o default do modelo (não envia o header).
 * Preferência CROSS-PROJECT, em localStorage.
 */

/** Opções de effort de um modelo, vindas do header X-Model-Reasoning-Efforts
 *  (serializado pelo worker a partir da config KV). `param` diz à IDE se é
 *  graded (lista de valores) ou boolean (['off','on']). */
export interface ReasoningEffortOptions {
  param: 'reasoning_effort' | 'enable_thinking' | 'thinking_object'
  options: string[]
  default: string
}

const STORAGE_KEY = 'tm_reasoning_effort_selected'

function loadSelected(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw && raw.trim() ? raw : null
  } catch {
    return null
  }
}

function saveSelected(value: string | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — mantém em memória */
  }
}

interface ReasoningEffortState {
  /** Valor nativo escolhido, ou null = default do modelo. */
  selected: string | null
  setSelected: (value: string | null) => void
}

export const useReasoningEffortStore = create<ReasoningEffortState>((set) => ({
  selected: loadSelected(),
  setSelected: (value) => {
    saveSelected(value)
    set({ selected: value })
  },
}))
