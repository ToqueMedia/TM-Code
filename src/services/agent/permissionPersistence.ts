/**
 * Per-project permission grants persistence.
 *
 * The `permissionStore.approvedScopes` Set tracks which tool scopes
 * (`'core'` and/or `'mcp'`) the user clicked "Accept All" on. Without
 * persistence, every app restart drops these grants — the user has to
 * re-approve the same tools on every reopen, training them to click
 * fast through dialogs (and eventually approving things they shouldn't
 * because the friction taught them prompts are noise).
 *
 * The grants live at `<project>/.toquemedia/permissions.json` —
 * **project-scoped on purpose**: trust scales with the project, not
 * with the IDE installation. Trusting "all core tools" on Project A
 * does not imply trusting them on Project B. Opening a new project
 * starts with an empty grant set; the prompts fire again until the
 * user re-approves.
 *
 * `autoApproveDiffs` is intentionally NOT persisted here — it stays in
 * `localStorage` because it's a cross-project user preference, not a
 * project trust grant. See `permissionStore.ts` for that path.
 */

import { invoke } from '@tauri-apps/api/core'

const PERMISSIONS_FILENAME = 'permissions.json'

export type ApprovedScope = 'core' | 'mcp'

interface PermissionsFileV1 {
  /** Schema version — bumped if the on-disk shape ever changes. */
  schemaVersion: 1
  /** ISO timestamp of the last write. */
  updatedAt: string
  /** Scopes the user has approved en-masse for this project. */
  approvedScopes: ApprovedScope[]
}

/**
 * Read the approved-scopes set for a project. Returns an empty set when
 * the file doesn't exist or is unparseable — first-open behaviour falls
 * back to the existing per-tool prompt flow.
 */
export async function loadPermissionsFromDisk(projectPath: string): Promise<Set<ApprovedScope>> {
  if (!projectPath) return new Set()
  try {
    const raw = await invoke<string | null>('read_agent_state', {
      projectPath,
      filename: PERMISSIONS_FILENAME,
    })
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as Partial<PermissionsFileV1>
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.approvedScopes)) {
      console.warn('[permissionPersistence] permissions.json present but unrecognised shape; ignoring')
      return new Set()
    }
    return new Set(
      parsed.approvedScopes.filter((s): s is ApprovedScope => s === 'core' || s === 'mcp'),
    )
  } catch (err) {
    console.warn('[permissionPersistence] failed to read permissions.json:', err)
    return new Set()
  }
}

/**
 * Write the approved-scopes set to disk. Fire-and-forget — failures are
 * logged but do not interrupt the permission flow (the in-memory grant
 * remains live; the next mutation will retry the persist).
 */
export async function savePermissionsToDisk(
  projectPath: string,
  approvedScopes: Set<ApprovedScope>,
): Promise<void> {
  if (!projectPath) return
  const payload: PermissionsFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    approvedScopes: Array.from(approvedScopes),
  }
  try {
    await invoke('write_agent_state', {
      projectPath,
      filename: PERMISSIONS_FILENAME,
      content: JSON.stringify(payload, null, 2),
    })
  } catch (err) {
    console.warn('[permissionPersistence] failed to write permissions.json:', err)
  }
}
