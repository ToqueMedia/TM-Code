/**
 * Per-project deploy-state persistence.
 *
 * The Publish flow runs on the TM Code Worker — the IDE polls / streams
 * status into `deployStore`. On reload, the in-memory store starts blank;
 * a deploy that was in flight (running for 30-60s, still building on the
 * worker) loses all visible context: the user reopens the IDE, sees "Idle"
 * deploy panel, and either re-clicks Publish (duplicate deploy, quota
 * waste) or thinks the deploy failed when it didn't.
 *
 * Disk snapshot: app-managed per-project state. One file per project — only
 * the latest deploy matters at any time (concurrent
 * deploys for the same project aren't supported by the worker contract).
 *
 * What's persisted: the FULL DeployRecord. The orchestration source of
 * truth is the worker; the IDE keeps the most recent IDE-visible state
 * (phase, currentStep, history, warnings, attemptId, urls) so on reopen
 * the user sees what was happening BEFORE the page re-polls or streams.
 *
 * Lifecycle:
 *   - Saved (debounced 300ms) on every meaningful deployStore mutation.
 *   - Read on project open → restored into the store.
 *   - Cleared when the user explicitly clears the record (`clear` action
 *     on the store, e.g. dismissing a completed-deploy banner).
 *
 * NOT gitignored on purpose — `deploy-state.json` is a useful project
 * artefact: it records WHEN this project was last published. Sensitive
 * data (TMDB tokens, service-account keys) never reaches the IDE-side
 * record, so committing is safe. If a project author wants to redact,
 * they can `git rm` it explicitly.
 */

import { invoke } from '@tauri-apps/api/core'
import type { DeployRecord } from '../stores/deployStore'
import { getLegacyProjectStateDir, getProjectStateDir } from './projectStatePaths'

const DEPLOY_FILENAME = 'deploy-state.json'

interface DeployStateFileV1 {
  schemaVersion: 1
  updatedAt: string
  record: DeployRecord
}

async function deployStatePath(projectPath: string): Promise<string> {
  return `${await getProjectStateDir(projectPath)}/${DEPLOY_FILENAME}`
}

function legacyDeployStatePath(projectPath: string): string {
  return `${getLegacyProjectStateDir(projectPath)}/${DEPLOY_FILENAME}`
}

export async function loadDeployStateFromDisk(
  projectPath: string,
): Promise<DeployRecord | null> {
  if (!projectPath) return null
  try {
    const path = await deployStatePath(projectPath)
    const raw = await invoke<string>('read_file', { path }).catch(() =>
      invoke<string>('read_file', { path: legacyDeployStatePath(projectPath) })
    )
    const parsed = JSON.parse(raw) as Partial<DeployStateFileV1>
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.record) return null
    return parsed.record
  } catch {
    return null
  }
}

export async function saveDeployStateToDisk(
  projectPath: string,
  record: DeployRecord,
): Promise<void> {
  if (!projectPath) return
  const payload: DeployStateFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    record,
  }
  try {
    await invoke('write_file', {
      path: await deployStatePath(projectPath),
      content: JSON.stringify(payload, null, 2),
    })
  } catch { /* swallow */ }
}

export async function clearDeployStateOnDisk(projectPath: string): Promise<void> {
  if (!projectPath) return
  try {
    await invoke('delete_file_or_directory', { path: await deployStatePath(projectPath) })
    await invoke('delete_file_or_directory', { path: legacyDeployStatePath(projectPath) }).catch(() => {})
  } catch { /* swallow */ }
}
