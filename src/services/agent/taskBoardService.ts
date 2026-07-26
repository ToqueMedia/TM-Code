/**
 * Shared multi-writer **item** board (Fase 6b residual).
 *
 * Per-session trackers already live in agentStore + tasks-<sid>.json.
 * This module mirrors the *open* items (non-terminal) + claims into a
 * single disk file under the project state dir so other windows can see
 * who claimed what without sharing Zustand.
 *
 * File: `<project-state>/task-board.json`
 * Channel: disk only (same multi-window doctrine as agent-status.json).
 */

import { invoke } from '@/utils/invokeMetrics'
import type { AgentTask } from '@/stores/agentStore'
import { getProjectStateDir } from '@/services/projectStatePaths'
import { logger } from '@/utils/logger'

export interface TaskBoardItem {
  id: string
  description: string
  status: string
  claimedBy?: string | null
  claimedAt?: number | null
  sessionId: string
}

export interface TaskBoardSnapshot {
  updatedAt: number
  /** Writing process (diagnostics). */
  pid: number
  items: TaskBoardItem[]
}

const BOARD_FILE = 'task-board.json'
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function boardPath(projectPath: string): Promise<string> {
  const dir = await getProjectStateDir(projectPath)
  return `${dir}/${BOARD_FILE}`
}

async function readBoardFile(projectPath: string): Promise<TaskBoardSnapshot | null> {
  try {
    const path = await boardPath(projectPath)
    const raw = await invoke<string>('read_file', { path })
    const parsed = JSON.parse(raw) as TaskBoardSnapshot
    if (!parsed || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Mirror open items for one session into the project board.
 * Merges with other sessions' items already on disk.
 * Best-effort — never throws into the tool path.
 */
export async function mirrorTaskBoard(
  projectPath: string,
  sessionId: string,
  tasks: ReadonlyArray<AgentTask>,
): Promise<void> {
  if (!projectPath || !sessionId) return
  try {
    const openItems: TaskBoardItem[] = tasks
      .filter((t) => !TERMINAL.has(t.status))
      .map((t) => ({
        id: t.id,
        description: t.description,
        status: t.status,
        claimedBy: t.claimedBy ?? null,
        claimedAt: t.claimedAt ?? null,
        sessionId,
      }))

    const prev = await readBoardFile(projectPath)
    const kept = (prev?.items ?? []).filter((i) => i.sessionId !== sessionId)
    // Best-effort pid for diagnostics (browser/tests may lack process).
    let pid = 0
    try {
      // Tauri exposes process id via OS only in Rust; leave 0 in pure web.
      if (typeof process !== 'undefined' && typeof process.pid === 'number') {
        pid = process.pid
      }
    } catch { /* */ }

    const snapshot: TaskBoardSnapshot = {
      updatedAt: Date.now(),
      pid,
      items: [...kept, ...openItems],
    }

    const path = await boardPath(projectPath)
    await invoke('write_file', {
      path,
      content: JSON.stringify(snapshot),
    })
  } catch (err) {
    logger.warn('agent', 'mirrorTaskBoard failed:', err)
  }
}

/** Read-only poll for UI / diagnostics (other windows). */
export async function readTaskBoard(
  projectPath: string,
): Promise<TaskBoardSnapshot | null> {
  if (!projectPath) return null
  return readBoardFile(projectPath)
}
