import { useActiveModelStore } from '@/stores/activeModelStore'
import { useReasoningEffortStore } from '@/stores/reasoningEffortStore'

/**
 * O activeModelStore rastreia o modelo ativo (para lógica de effort) SEM
 * side-effects — o antigo reset-on-change (que apagava a preferência e tinha
 * race Firestore↔header) foi removido. A regra "na troca pega o default" é
 * resolvida por resolveEffectiveEffort, não por estado a repor.
 */
describe('activeModelStore', () => {
  beforeEach(() => {
    useActiveModelStore.setState({ activeModelId: null })
    useReasoningEffortStore.setState({ selected: 'max' })
  })

  it('setActiveModelId define o id', () => {
    useActiveModelStore.getState().setActiveModelId('grok-4.5')
    expect(useActiveModelStore.getState().activeModelId).toBe('grok-4.5')
  })

  it('trocar de modelo NÃO mexe na preferência de effort (sem reset-on-change)', () => {
    useActiveModelStore.getState().setActiveModelId('glm-5.2')
    useActiveModelStore.getState().setActiveModelId('grok-4.5')
    // A preferência 'max' fica intocada — a reconciliação é no ponto de uso.
    expect(useReasoningEffortStore.getState().selected).toBe('max')
  })

  it('mesmo id → no-op', () => {
    useActiveModelStore.getState().setActiveModelId('glm-5.2')
    let calls = 0
    const unsub = useActiveModelStore.subscribe(() => { calls++ })
    useActiveModelStore.getState().setActiveModelId('glm-5.2')
    unsub()
    expect(calls).toBe(0)
  })
})
