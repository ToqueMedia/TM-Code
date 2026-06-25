/**
 * Per-session persistence of the post-compaction skill-recovery payload.
 *
 * `skillService.invokedSkills` is a module-level Map that caches the full
 * body of every skill the agent read via `read_skill` during a session.
 * After microcompaction collapses the conversation history (and with it
 * the original tool-result containing the verbatim skill text), the map
 * is the ONLY source of authoritative skill content for re-injection
 * into the next API call.
 *
 * Without disk persistence, an IDE reload mid-session drops the map.
 * The next turn after the reload would have no record of which skills
 * applied here — the agent would fall back to its training prior, which
 * is the exact thing the `invokedSkills` design exists to prevent
 * (e.g. "use GoogleAuthProvider" when the auth-proxy skill forbids it).
 *
 * Storage: app per-project sessions dir, co-located with the rest of the
 * session's files but outside the user's project tree.
 */

import { invoke } from '@tauri-apps/api/core'
import { getProjectSessionsDir } from '../projectStatePaths'
import type { InvokedSkill } from './skillService'

interface InvokedSkillsFileV1 {
  schemaVersion: 1
  updatedAt: string
  sessionId: string
  skills: InvokedSkill[]
}

async function invokedSkillsPath(projectPath: string, sessionId: string): Promise<string> {
  return `${await getProjectSessionsDir(projectPath)}/${sessionId}.invoked-skills.json`
}

export async function loadInvokedSkillsFromDisk(
  projectPath: string,
  sessionId: string,
): Promise<InvokedSkill[]> {
  if (!projectPath || !sessionId) return []
  try {
    const raw = await invoke<string>('read_file', {
      path: await invokedSkillsPath(projectPath, sessionId),
    })
    const parsed = JSON.parse(raw) as Partial<InvokedSkillsFileV1>
    if (
      !parsed
      || parsed.schemaVersion !== 1
      || parsed.sessionId !== sessionId
      || !Array.isArray(parsed.skills)
    ) {
      return []
    }
    return parsed.skills.filter((s): s is InvokedSkill =>
      !!s
      && typeof s.name === 'string'
      && typeof s.content === 'string'
      && typeof s.invokedAt === 'number',
    )
  } catch {
    return []
  }
}

export async function saveInvokedSkillsToDisk(
  projectPath: string,
  sessionId: string,
  skills: InvokedSkill[],
): Promise<void> {
  if (!projectPath || !sessionId) return
  const path = await invokedSkillsPath(projectPath, sessionId)
  // Empty list → delete file. Avoids a permanent breadcrumb in
  // app state for sessions that never invoked a skill.
  if (skills.length === 0) {
    try {
      await invoke('delete_file_or_directory', { path })
    } catch { /* swallow */ }
    return
  }
  const payload: InvokedSkillsFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sessionId,
    skills,
  }
  try {
    await invoke('write_file', {
      path,
      content: JSON.stringify(payload, null, 2),
    })
  } catch { /* swallow */ }
}
