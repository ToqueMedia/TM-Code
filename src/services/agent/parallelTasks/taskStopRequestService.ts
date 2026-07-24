/**
 * Canal CROSS-WINDOW de Stop (doutrina multi-janela: o disco é o único canal
 * entre processos — ver ARCHITECTURE.md).
 *
 * Dois grãos:
 *  1. **Por sessão** (`task-stop-requests.json`): runId de uma tarefa paralela
 *     vive só no processo dono; outra janela escreve o sessionId e o runner
 *     dono consome nos turn boundaries (rápido) e no heartbeat de 30s (teto).
 *  2. **Por projecto** (`project-agent-stop-request.json`): o botão Stop da
 *     sidebar só tem o path do projecto (não o sessionId). Cobre o main loop
 *     e qualquer project-run cujo dono ainda não tenha sessionId no pedido.
 *
 * Read-modify-write best-effort sem lock: a janela de corrida é ínfima e o
 * pior caso é o pedido perder-se — o user volta a clicar. Session-scoped
 * never kills the wrong task; project-scoped is F3-safe (one agent/project).
 */

import { invoke } from '@/utils/invokeMetrics'
import { getProjectSessionsDir, getProjectStateDir } from '../../projectStatePaths'

async function requestsPath(projectPath: string): Promise<string> {
  const dir = await getProjectSessionsDir(projectPath)
  return `${dir}/task-stop-requests.json`
}

async function projectStopPath(projectPath: string): Promise<string> {
  const dir = await getProjectStateDir(projectPath)
  return `${dir}/project-agent-stop-request.json`
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

/**
 * Sidebar project-level Stop: request that whichever agent owns this project
 * (main or parallel, any window) self-abort. Consumed + cleared by the owner.
 */
export async function requestProjectAgentStop(projectPath: string): Promise<void> {
  try {
    const path = await projectStopPath(projectPath)
    await invoke('write_file', {
      path,
      content: JSON.stringify({ requestedAt: Date.now() }),
    })
  } catch { /* best-effort */ }
}

/**
 * Owner (main heartbeat / parallel runner) consumes a project-level stop.
 * Returns true once (file removed) so a single click stops one run.
 * Stale requests older than 2 min are ignored and cleared (avoid surprise
 * kills long after the user clicked).
 */
export async function consumeProjectAgentStop(projectPath: string): Promise<boolean> {
  try {
    const path = await projectStopPath(projectPath)
    let raw: string
    try {
      raw = await invoke<string>('read_file', { path })
    } catch {
      return false
    }
    let requestedAt = 0
    try {
      const parsed = JSON.parse(raw) as { requestedAt?: number }
      requestedAt = typeof parsed?.requestedAt === 'number' ? parsed.requestedAt : 0
    } catch {
      requestedAt = 0
    }
    // Clear the flag either way so a corrupt/stale file does not stick.
    try {
      await invoke('delete_file_or_directory', { path })
    } catch {
      try { await invoke('write_file', { path, content: '{}' }) } catch { /* ignore */ }
    }
    if (!requestedAt) return false
    if (Date.now() - requestedAt > 120_000) return false
    return true
  } catch {
    return false
  }
}
