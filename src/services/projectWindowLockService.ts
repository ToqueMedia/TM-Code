/**
 * Presença de janela por projecto — o guard de DUPLO-OPEN entre janelas.
 *
 * Cada janela TM Code é um processo OS independente; nada impede duas
 * janelas de abrirem o MESMO projecto (mesmo state dir → sessões
 * last-write-wins; mesma working tree → dois agentes a escrever). Este
 * serviço faz heartbeat de `window-lock.json` enquanto o projecto está
 * aberto NESTA janela; o openProject consulta `isProjectOpenElsewhere()` e
 * AVISA antes de abrir por cima.
 *
 * Deliberadamente um aviso, não um hard-lock: um lock rígido que sobrevive
 * a um crash trancava o utilizador fora do próprio projecto. A staleness
 * (STALE_MS, mesma janela do badge de agente) arbitra donos mortos, e o
 * WindowEvent::Destroyed liberta o lock no fecho gracioso.
 */

import { invoke } from '@/utils/invokeMetrics'
import { useProjectStore } from '@/stores/projectStore'
import { logger } from '@/utils/logger'

export interface ProjectWindowLock {
  pid: number
  updatedAt: number
}

const LOCK_HEARTBEAT_MS = 30_000
/** Um lock estrangeiro sem heartbeat há mais do que isto = dono morto. */
export const PROJECT_WINDOW_LOCK_STALE_MS = 90_000

let started = false
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heldPath: string | null = null

function acquire(path: string): void {
  invoke('acquire_project_window_lock', { projectPath: path }).catch(err => {
    logger.warn('project', 'acquire_project_window_lock failed:', err)
  })
}

function release(path: string): void {
  invoke('release_project_window_lock', { projectPath: path }).catch(() => {})
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat(path: string): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => acquire(path), LOCK_HEARTBEAT_MS)
}

/**
 * True quando OUTRA janela viva parece ter este projecto aberto. O comando
 * Rust já filtra o próprio pid (devolve null para lock nosso/ausente);
 * aqui só se arbitra a frescura do heartbeat.
 */
export async function isProjectOpenElsewhere(path: string): Promise<boolean> {
  try {
    const lock = await invoke<ProjectWindowLock | null>('check_project_window_lock', {
      projectPath: path,
    })
    if (!lock) return false
    return Date.now() - lock.updatedAt <= PROJECT_WINDOW_LOCK_STALE_MS
  } catch {
    return false // best-effort: sem Tauri (testes) ou erro de IO → não bloquear
  }
}

/** Idempotente — chamado uma vez no arranque da app (App.tsx). */
export function initProjectWindowLock(): void {
  if (started) return
  started = true

  useProjectStore.subscribe((state, prev) => {
    const prevPath = prev.currentProject?.path ?? null
    const newPath = state.currentProject?.path ?? null
    if (prevPath === newPath) return
    if (prevPath && heldPath === prevPath) {
      stopHeartbeat()
      release(prevPath)
      heldPath = null
    }
    if (newPath) {
      heldPath = newPath
      acquire(newPath)
      startHeartbeat(newPath)
    }
  })
}
