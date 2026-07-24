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
import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { useAgentStore } from '@/stores/agentStore'
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
/** Multi-slot (F2 MDI): a lock per project this window has focused OR is
 *  actively running an agent on — not just the focused one. A background
 *  project-run writes its tree, so it must keep guarding against a second
 *  window opening the same project unwarned. */
const heldPaths = new Set<string>()

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

function startHeartbeat(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    for (const p of heldPaths) acquire(p)
  }, LOCK_HEARTBEAT_MS)
}

/** The project the singleton main run is bound to (set while a main run is
 *  live, cleared when it ends) — survives a focus switch, unlike currentProject.
 *  Lazy require: toolExecutor pulls heavy deps we don't want at module load. */
function mainRunProjectPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ToolExecutor = require('./agent/toolExecutor').default as {
      getInstance: () => { getProjectContext: () => { projectPath: string } | null }
    }
    return ToolExecutor.getInstance().getProjectContext()?.projectPath ?? null
  } catch {
    return null
  }
}

/** Recompute the set of projects THIS window must lock: the focused project,
 *  the main run's bound project (if live), and every project with a live
 *  parallel/project run. Acquire the new, release the gone. */
function reconcile(): void {
  const desired = new Set<string>()
  const focused = useProjectStore.getState().currentProject?.path
  if (focused) desired.add(focused)
  const mainRun = mainRunProjectPath()
  if (mainRun) desired.add(mainRun)
  try {
    for (const r of useParallelTaskStore.getState().runs.values()) {
      if ((r.status === 'running' || r.status === 'queued') && r.projectPath) {
        desired.add(r.projectPath)
      }
    }
  } catch { /* store unavailable (tests) */ }

  for (const p of Array.from(heldPaths)) {
    if (!desired.has(p)) {
      release(p)
      heldPaths.delete(p)
    }
  }
  for (const p of desired) {
    if (!heldPaths.has(p)) {
      acquire(p)
      heldPaths.add(p)
    }
  }
  if (heldPaths.size > 0) startHeartbeat()
  else stopHeartbeat()
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

  // Reconcile the lock set on every signal that changes which projects this
  // window is holding: focus change, a project-run starting/ending, and the
  // main run starting/ending (agentStore.status is the proxy — the bound
  // project is read fresh from the executor in reconcile).
  useProjectStore.subscribe((state, prev) => {
    if (state.currentProject?.path !== prev.currentProject?.path) reconcile()
  })
  try {
    useParallelTaskStore.subscribe(() => reconcile())
  } catch { /* store unavailable (tests) */ }
  try {
    useAgentStore.subscribe((s, p) => { if (s.status !== p.status) reconcile() })
  } catch { /* store unavailable (tests) */ }
  reconcile()
}
