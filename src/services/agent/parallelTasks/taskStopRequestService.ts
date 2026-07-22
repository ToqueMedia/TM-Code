/**
 * Canal CROSS-WINDOW de Stop para tarefas paralelas (doutrina multi-janela:
 * o disco é o único canal entre processos — ver ARCHITECTURE.md).
 *
 * O runId de uma tarefa vive só no processo dono; outra janela não pode
 * abortar diretamente. Em vez disso escreve um PEDIDO (sessionId) em
 * `task-stop-requests.json` no state dir do projecto; o runner dono consome
 * nos turn boundaries (rápido em atividade) e no heartbeat de 30s (teto de
 * latência) e aborta-se a si próprio — o mesmo caminho do Stop local.
 *
 * Read-modify-write best-effort sem lock: a janela de corrida é ínfima e o
 * pior caso é o pedido perder-se — o user volta a clicar. Nunca pode matar
 * a tarefa errada: o pedido é por sessionId, consumido só pelo dono.
 */

import { invoke } from '@/utils/invokeMetrics'
import { getProjectSessionsDir } from '../../projectStatePaths'

async function requestsPath(projectPath: string): Promise<string> {
  const dir = await getProjectSessionsDir(projectPath)
  return `${dir}/task-stop-requests.json`
}

async function readIds(path: string): Promise<string[]> {
  try {
    const raw = await invoke<string>('read_file', { path })
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Outra janela pede o Stop da tarefa cuja sessão é `sessionId`. */
export async function requestTaskStop(projectPath: string, sessionId: string): Promise<void> {
  try {
    const path = await requestsPath(projectPath)
    const ids = await readIds(path)
    if (!ids.includes(sessionId)) ids.push(sessionId)
    await invoke('write_file', { path, content: JSON.stringify(ids) })
  } catch { /* best-effort — o user pode voltar a clicar */ }
}

/** O runner DONO pergunta se há pedido para a sua sessão; consome-o se sim. */
export async function consumeTaskStopRequest(projectPath: string, sessionId: string): Promise<boolean> {
  try {
    const path = await requestsPath(projectPath)
    const ids = await readIds(path)
    if (!ids.includes(sessionId)) return false
    await invoke('write_file', { path, content: JSON.stringify(ids.filter(i => i !== sessionId)) })
    return true
  } catch {
    return false
  }
}
