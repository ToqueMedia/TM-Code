/**
 * Baseline de propriedade de ficheiros para tarefas paralelas.
 *
 * HISTÓRIA (auditoria 2026-07-28): este módulo era o isolamento OPT-IN de
 * tarefas em git worktrees (um agente por working tree + branch, merge
 * deliberado pelo developer). A F3 (2026-07-23) removeu os worktrees por
 * tarefa com o fan-out intra-projecto — passou a ser 1 agente por projecto,
 * sempre no checkout do projecto — e o runner deixou de os criar. O que ficou
 * aqui foram ~200 linhas de create/reuse/finalize/auto-merge sem um único
 * caller de produção, com o bloco de finalize no runner protegido por um
 * `if (worktree)` cuja condição era a constante `null`.
 *
 * Sobra o que continua VIVO: a lista de ficheiros com trabalho por commitar do
 * developer, que é a baseline da regra de propriedade (as tarefas não lhes
 * tocam). A máquina enter_worktree/exit_worktree que o AGENTE usa é outra e
 * vive em toolExecutor/worktrees.ts — essa está bem viva.
 */

import { invoke } from '@/utils/invokeMetrics'
import { formatError } from '../../../utils/errors'
import { hasOwnRepo } from '../../repoOwnership'

async function runGit(command: string, cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await invoke<{ stdout: string; stderr: string; exitCode: number; success: boolean }>(
      'execute_command',
      { command, cwd, timeoutSecs: 60 },
    )
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
    return { ok: r.success && r.exitCode === 0, out }
  } catch (e) {
    return { ok: false, out: formatError(e) }
  }
}

/** Ficheiros com alterações POR COMMITAR no checkout principal — trabalho em
 *  curso do developer. As tarefas não lhes tocam (regra de propriedade). */
export async function dirtyFilesInMainCheckout(projectRoot: string): Promise<Set<string>> {
  const files = new Set<string>()
  // Sem repo PRÓPRIO, o status viria do repo ANCESTRAL (WIP de outro
  // projecto, caminhos relativos ao pai) — baseline vazio é o honesto.
  if (!(await hasOwnRepo(projectRoot))) return files
  const status = await runGit('git status --porcelain', projectRoot)
  if (!status.ok) return files
  for (const line of status.out.split('\n')) {
    if (!line.trim()) continue
    // Formato: "XY caminho" | "XY antigo -> novo" (renames usam o novo).
    let rest = line.slice(3).trim()
    const arrow = rest.indexOf(' -> ')
    if (arrow >= 0) rest = rest.slice(arrow + 4)
    files.add(rest.replace(/^"|"$/g, ''))
  }
  return files
}
