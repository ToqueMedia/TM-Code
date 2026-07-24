import { useReasoningEffortStore } from '@/stores/reasoningEffortStore'

/**
 * Reasoning-effort escolhido pelo user — VALOR NATIVO do provider (redesenho
 * 07-23). O store guarda só a ESCOLHA (`selected`); as opções vêm do modelo
 * ativo (agentStore.reasoningEffortOptions, header X-Model-Reasoning-Efforts).
 * `selected = null` → usar o default do modelo. Persistido em localStorage.
 */
describe('reasoningEffortStore', () => {
  beforeEach(() => {
    try { localStorage.clear() } catch { /* jsdom */ }
    useReasoningEffortStore.setState({ selected: null })
  })

  it('arranca com selected = null (segue o default do modelo)', () => {
    expect(useReasoningEffortStore.getState().selected).toBeNull()
  })

  it('setSelected guarda o valor nativo e persiste em localStorage', () => {
    useReasoningEffortStore.getState().setSelected('xhigh')
    expect(useReasoningEffortStore.getState().selected).toBe('xhigh')
    expect(localStorage.getItem('tm_reasoning_effort_selected')).toBe('xhigh')
  })

  it('setSelected(null) limpa a escolha e remove do localStorage', () => {
    useReasoningEffortStore.getState().setSelected('low')
    expect(localStorage.getItem('tm_reasoning_effort_selected')).toBe('low')
    useReasoningEffortStore.getState().setSelected(null)
    expect(useReasoningEffortStore.getState().selected).toBeNull()
    expect(localStorage.getItem('tm_reasoning_effort_selected')).toBeNull()
  })

  it('aceita qualquer valor nativo (on/off dos modelos booleanos)', () => {
    useReasoningEffortStore.getState().setSelected('off')
    expect(useReasoningEffortStore.getState().selected).toBe('off')
  })
})
