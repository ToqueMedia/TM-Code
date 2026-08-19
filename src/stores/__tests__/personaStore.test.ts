import { usePersonaStore, DEFAULT_PERSONA, PERSONAS } from '../personaStore'

describe('personaStore', () => {
  beforeEach(() => {
    localStorage.clear()
    usePersonaStore.setState({ selected: DEFAULT_PERSONA })
  })

  it('default é standard', () => {
    expect(usePersonaStore.getState().selected).toBe('standard')
  })

  it('setSelected persiste em localStorage e aceita todas as personas', () => {
    for (const p of PERSONAS) {
      usePersonaStore.getState().setSelected(p)
      expect(usePersonaStore.getState().selected).toBe(p)
      expect(localStorage.getItem('tm_model_persona')).toBe(p)
    }
  })

  it('valor inválido é ignorado (o header nunca sai fora do enum)', () => {
    usePersonaStore.getState().setSelected('expert')
    // @ts-expect-error — valor fora do enum, de propósito
    usePersonaStore.getState().setSelected('wizard')
    expect(usePersonaStore.getState().selected).toBe('expert')
  })

  it('lockTm não persiste tm no storage público e unlock restaura', () => {
    usePersonaStore.getState().setSelected('expert')
    usePersonaStore.getState().lockTm()
    expect(usePersonaStore.getState().selected).toBe('tm')
    expect(localStorage.getItem('tm_model_persona')).toBe('expert')
    usePersonaStore.getState().unlockTm()
    expect(usePersonaStore.getState().selected).toBe('expert')
  })
})
