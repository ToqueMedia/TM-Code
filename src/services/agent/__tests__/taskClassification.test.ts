import { isMutableTask } from '../taskClassification'

describe('isMutableTask', () => {
  it('detects direct implementation/change requests', () => {
    expect(isMutableTask('Implementar o modal de billing')).toBe(true)
    expect(isMutableTask('Corrigir o bug do commit message')).toBe(true)
    expect(isMutableTask('Add a new settings dialog')).toBe(true)
  })

  it('detects the NIF regression scenario as mutable', () => {
    expect(isMutableTask(
      'Detectar se o user já adicionou o seu NIF, caso não encontre, abrir um modal para o user inserir o seu NIF.',
    )).toBe(true)
  })

  it('does not mark read-only inspection text as mutable', () => {
    expect(isMutableTask('Verifique onde o billing screen carrega os dados, sem editar.')).toBe(false)
  })
})
