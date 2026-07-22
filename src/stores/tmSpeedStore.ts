import { create } from 'zustand'

/**
 * Família de modelos onde o TM Speed existe. O speed é uma variante do MiMo
 * V2.5 Pro (`mimo-v2.5-pro-ultraspeed`); se o admin publicar OUTRO modelo na
 * config ativa (minimax, qwen, ...), o `/speed` deixa de fazer sentido e é
 * OCULTADO (decisão de produto 2026-06-11). O prefixo cobre o modelo base e a
 * variante ultraspeed — assim o comando continua visível enquanto o speed
 * está a ser servido.
 */
const SPEED_MODEL_PREFIX = 'mimo-v2.5-pro'

/**
 * Kill-switch: /speed foi RETIRADO da UI em 2026-07-16 (registo do comando +
 * badge da titlebar desligados; implementação mantida como código morto para
 * reativação futura). Enquanto true, updateFromProfile ignora o flag
 * `users/{uid}.tmSpeedEnabled` — sem isto, quem tivesse ligado o speed no
 * passado continuaria a enviar X-TM-Speed (cobrança 3x no worker) SEM nenhuma
 * UI para o desligar. Reativar = false + descomentar o registo no
 * slashCommandRegistry + remontar o TmSpeedIndicator na MinimalTitleBar.
 */
export const TM_SPEED_RETIRED = true

/**
 * Elegibilidade por modelo. `null` (id ainda desconhecido — antes da primeira
 * resposta do worker) é FAIL-OPEN: esconder à partida impediria um user
 * pro/max de ligar o speed antes do primeiro turno; o worker degrada de
 * qualquer forma se o speed não se aplicar.
 */
export function isSpeedModelEligible(modelId: string | null): boolean {
  if (modelId === null) return true
  return modelId.toLowerCase().startsWith(SPEED_MODEL_PREFIX)
}

interface TmSpeedState {
  /** Toggle do utilizador (`/speed`), persistido em users/{uid}.tmSpeedEnabled. */
  enabled: boolean
  /** O worker confirmou speed na última resposta (`X-TM-Speed-Applied: true`)?
   * Pode divergir de `enabled`: toggle ligado mas speedModel não publicado ou
   * plano não elegível ⇒ enabled=true, applied=false. A UI usa `enabled` para
   * o badge (intenção do utilizador); `applied` indica serviço real (e cobrança 3x). */
  applied: boolean
  /** Id do modelo ativo reportado pelo worker (`X-TM-Model`) na última
   * resposta. Fonte do gate de visibilidade do `/speed` por modelo. */
  activeModelId: string | null
  isLoaded: boolean
  setEnabled: (enabled: boolean) => void
  setApplied: (applied: boolean) => void
  setActiveModelId: (modelId: string | null) => void
  updateFromProfile: (profile: Record<string, unknown> | null | undefined) => void
  reset: () => void
}

export const useTmSpeedStore = create<TmSpeedState>((set) => ({
  enabled: false,
  applied: false,
  activeModelId: null,
  isLoaded: false,

  setEnabled: (enabled) => set({ enabled, isLoaded: true }),

  setApplied: (applied) => set({ applied }),

  setActiveModelId: (modelId) => set({ activeModelId: modelId }),

  updateFromProfile: (profile) => {
    set({
      enabled: !TM_SPEED_RETIRED && profile?.tmSpeedEnabled === true,
      isLoaded: true,
    })
  },

  reset: () => set({ enabled: false, applied: false, activeModelId: null, isLoaded: false }),
}))
