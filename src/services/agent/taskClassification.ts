function normalizeTaskText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term))
}

export function isMutableTask(userMessage: string): boolean {
  const text = normalizeTaskText(userMessage)
  if (!text) return false

  const mutationTerms = [
    'implementar',
    'implementa',
    'corrigir',
    'corrige',
    'adicionar',
    'adiciona',
    'alterar',
    'altera',
    'modificar',
    'modifica',
    'remover',
    'remove',
    'criar',
    'cria',
    'abrir um modal',
    'abrir modal',
    'inserir',
    'guardar',
    'salvar',
    'actualizar',
    'atualizar',
    'fix ',
    'fix:',
    'implement ',
    'add ',
    'change ',
    'update ',
    'remove ',
    'create ',
    'build ',
  ]

  if (containsAny(text, mutationTerms)) return true

  return (
    containsAny(text, ['detectar se', 'detetar se', 'detect if']) &&
    containsAny(text, ['caso nao', 'se nao', 'if not', 'otherwise']) &&
    containsAny(text, ['modal', 'form', 'input', 'inserir', 'enter'])
  )
}
