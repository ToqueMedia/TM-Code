import { useActiveModelStore, getPersonaFallbackModelId } from '@/stores/activeModelStore'
import { usePersonaStore, DEFAULT_PERSONA } from '@/stores/personaStore'
import { useReasoningEffortStore } from '@/stores/reasoningEffortStore'

/**
 * Desde 2026-08-05 o store guarda o mapa persona→modelo (system/aiPersonas —
 * substituiu o doc de modelo único, sem compatibilidade) e o fallback do
 * effort resolve-se PELA persona selecionada. Continua SEM side-effects — a
 * regra "na troca pega o default" é resolvida por resolveEffectiveEffort no
 * ponto de uso, não por estado a repor.
 */
describe('activeModelStore (mapa por persona)', () => {
  beforeEach(() => {
    useActiveModelStore.setState({ personaModels: {} })
    usePersonaStore.setState({ selected: DEFAULT_PERSONA })
    useReasoningEffortStore.setState({ selected: 'max' })
  })

  it('setPersonaModels define o mapa e o fallback segue a persona selecionada', () => {
    useActiveModelStore.getState().setPersonaModels({
      standard: 'mimo-v2.5-pro',
      expert: 'glm-5.2',
      master: 'qwen3.8-max',
    })
    expect(getPersonaFallbackModelId()).toBe('mimo-v2.5-pro')

    // Trocar de persona muda o fallback IMEDIATAMENTE — era o bug reportado:
    // "a troca de persona não muda nada".
    usePersonaStore.setState({ selected: 'master' })
    expect(getPersonaFallbackModelId()).toBe('qwen3.8-max')
  })

  it('persona não publicada → fallback null (selector cai no servido/GLM)', () => {
    useActiveModelStore.getState().setPersonaModels({ standard: 'glm-5.2' })
    usePersonaStore.setState({ selected: 'expert' })
    expect(getPersonaFallbackModelId()).toBeNull()
  })

  it('actualizar o mapa NÃO mexe na preferência de effort (sem reset-on-change)', () => {
    useActiveModelStore.getState().setPersonaModels({ standard: 'glm-5.2' })
    useActiveModelStore.getState().setPersonaModels({ standard: 'grok-4.5' })
    expect(useReasoningEffortStore.getState().selected).toBe('max')
  })
})
