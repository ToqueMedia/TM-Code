/**
 * Normalização de caminhos de tarefas isoladas — módulo PURO (testável).
 * Ver makeTaskPathNormalizer para o racional (bug real 2026-07-17: o modelo
 * prefixava caminhos com `.toquemedia/worktrees/<name>/` e os ficheiros
 * aninhavam dentro do próprio worktree).
 */

import { WORKTREES_REL_DIR } from '../toolExecutor/worktrees'

export interface TaskWorktreePathInfo {
  path: string
  name: string
}

export const PATH_INPUT_KEYS = ['file_path', 'path', 'old_path', 'new_path', 'source', 'destination', 'directory', 'cwd'] as const

/**
 * Normaliza caminhos vindos do MODELO para o referencial do worktree.
 * Observado em produção (2026-07-17): o modelo prefixava caminhos com
 * `.toquemedia/worktrees/<name>/...` (relativos à RAIZ DO PROJECTO) — como o
 * executor resolve relativos contra o CWD (o worktree), os ficheiros
 * aterravam ANINHADOS dentro do próprio worktree, e os claims de propriedade
 * não batiam com os das outras tarefas. Aceita e corrige as três formas:
 * absoluto-no-worktree (fica), absoluto/relativo com o prefixo do worktree
 * (strip, em loop — defensivo contra duplo prefixo), relativo limpo (fica).
 */
export function makeTaskPathNormalizer(worktree: TaskWorktreePathInfo | null, projectPath: string) {
  if (!worktree) return (input: Record<string, unknown>) => input
  const relPrefix = `${WORKTREES_REL_DIR}/${worktree.name}/`
  const absPrefix = `${worktree.path}/`
  const rootPrefixed = `${projectPath}/${relPrefix}`
  const worktreesDir = `${WORKTREES_REL_DIR}/`
  const fixOne = (raw: string): string => {
    let v = raw.trim()
    if (v.startsWith(absPrefix) && !v.slice(absPrefix.length).startsWith(relPrefix)) return raw
    if (v.startsWith(rootPrefixed)) v = v.slice(projectPath.length + 1)
    if (v.startsWith(absPrefix)) v = v.slice(absPrefix.length)
    if (v.startsWith('./')) v = v.slice(2)
    while (v.startsWith(relPrefix)) v = v.slice(relPrefix.length)
    // Absoluto no CHECKOUT PRINCIPAL (o prompt menciona a raiz do projecto e
    // o modelo às vezes usa-a): o trabalho da tarefa pertence ao worktree —
    // remapeia para relativo, EXCETO caminhos de outros worktrees (esses são
    // alheios; a guarda de acesso trata deles).
    if (v.startsWith(`${projectPath}/`)) {
      const rest = v.slice(projectPath.length + 1)
      if (!rest.startsWith(worktreesDir)) v = rest
    }
    return v === raw.trim() ? raw : v
  }
  return (input: Record<string, unknown>): Record<string, unknown> => {
    let changed = false
    const out: Record<string, unknown> = { ...input }
    for (const key of PATH_INPUT_KEYS) {
      const v = out[key]
      if (typeof v === 'string' && v.trim()) {
        const fixed = fixOne(v)
        if (fixed !== v) {
          out[key] = fixed
          changed = true
        }
      }
    }
    return changed ? out : input
  }
}

