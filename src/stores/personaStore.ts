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
 *
 * `tm` NÃO entra na lista pública. Só o lock Toque Media a selecciona, e
 * nunca é persistida em `tm_model_persona`.
 */

export const SWITCHABLE_PERSONAS = ['standard', 'expert', 'master'] as const
export type SwitchablePersona = (typeof SWITCHABLE_PERSONAS)[number]
export const TM_LOCKED_PERSONA = 'tm' as const
export type Persona = SwitchablePersona | typeof TM_LOCKED_PERSONA
/** Alias usado pelos selectors — nunca inclui `tm`. */
export const PERSONAS = SWITCHABLE_PERSONAS

export const DEFAULT_PERSONA: SwitchablePersona = 'standard'

const STORAGE_KEY = 'tm_model_persona'
const BEFORE_TM_KEY = 'tm_model_persona_before_tm'

function isSwitchable(value: unknown): value is SwitchablePersona {
  return typeof value === 'string' && (SWITCHABLE_PERSONAS as readonly string[]).includes(value)
}

function isPersona(value: unknown): value is Persona {
  return isSwitchable(value) || value === TM_LOCKED_PERSONA
}

function loadSelected(): Persona {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isSwitchable(raw) ? raw : DEFAULT_PERSONA
  } catch {
    return DEFAULT_PERSONA
  }
}

function saveSelected(value: SwitchablePersona): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* storage unavailable — mantém em memória */
  }
}

function rememberBeforeTm(current: Persona): void {
  if (!isSwitchable(current)) return
  try {
    if (!localStorage.getItem(BEFORE_TM_KEY)) {
      localStorage.setItem(BEFORE_TM_KEY, current)
    }
  } catch {
    /* ignore */
  }
}

function takeBeforeTm(): SwitchablePersona {
  try {
    const raw = localStorage.getItem(BEFORE_TM_KEY)
    localStorage.removeItem(BEFORE_TM_KEY)
    return isSwitchable(raw) ? raw : DEFAULT_PERSONA
  } catch {
    return DEFAULT_PERSONA
  }
}

interface PersonaStoreState {
  selected: Persona
  setSelected: (persona: Persona) => void
  lockTm: () => void
  unlockTm: () => void
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    if (!isSwitchable(e.newValue)) return
    if (e.newValue !== usePersonaStore.getState().selected) {
      usePersonaStore.setState({ selected: e.newValue })
    }
  })
}

function bumpModelInfo(): void {
  void import('./agentStore').then(({ useAgentStore }) => {
    useAgentStore.getState().setModelInfo(null, null, null, null, null, { vision: null, search: null }, null)
  }).catch(() => {})
}

export const usePersonaStore = create<PersonaStoreState>((set, get) => ({
  selected: loadSelected(),
  setSelected: (persona) => {
    if (!isPersona(persona)) return
    if (persona === TM_LOCKED_PERSONA) {
      set({ selected: persona })
      bumpModelInfo()
      return
    }
    saveSelected(persona)
    set({ selected: persona })
    bumpModelInfo()
  },
  lockTm: () => {
    const current = get().selected
    if (current === TM_LOCKED_PERSONA) return
    rememberBeforeTm(current)
    set({ selected: TM_LOCKED_PERSONA })
    bumpModelInfo()
  },
  unlockTm: () => {
    if (get().selected !== TM_LOCKED_PERSONA) return
    const restored = takeBeforeTm()
    saveSelected(restored)
    set({ selected: restored })
    bumpModelInfo()
  },
}))
