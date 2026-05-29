/**
 * Per-project permission grants persistence.
 *
 * Tracks two kinds of trust:
 *  - **Scopes** (`'core'` / `'mcp'`): user clicked "Approve All" for a scope.
 *  - **Tools** (e.g. `'execute_command'`): user clicked "Always allow" for a
 *    specific tool in this project.
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

export interface PermissionsFileV2 {
  schemaVersion: 2
  updatedAt: string
  approvedScopes: ApprovedScope[]
  /** Tool names the user clicked "Always allow in this project" for. */
  approvedTools: string[]
}

export interface LoadedPermissions {
  scopes: Set<ApprovedScope>
  tools: Set<string>
}

/**
 * Read the approved-scopes and approved-tools sets for a project.
 * Returns empty sets when the file doesn't exist or is unparseable —
 * first-open behaviour falls back to the existing per-tool prompt flow.
 *
 * Backward compat: v1 files (no `approvedTools`) load with an empty
 * tool set. The next save will upgrade the file to v2.
 */
export async function loadPermissionsFromDisk(projectPath: string): Promise<LoadedPermissions> {
  const empty: LoadedPermissions = { scopes: new Set(), tools: new Set() }
  if (!projectPath) return empty
  try {
    const raw = await invoke<string | null>('read_agent_state', {
      projectPath,
      filename: PERMISSIONS_FILENAME,
    })
    if (!raw) return empty
    // Use a loose shape — the discriminated union of v1/v2 makes
    // Partial<...> collapse to `never` on shared keys with different
    // literal types. Parse generically then branch on schemaVersion.
    const parsed = JSON.parse(raw) as { schemaVersion?: number; approvedScopes?: unknown; approvedTools?: unknown }

    // v2 file — preferred
    if (parsed.schemaVersion === 2 && Array.isArray(parsed.approvedScopes)) {
      return {
        scopes: new Set(
          (parsed.approvedScopes as string[]).filter((s): s is ApprovedScope => s === 'core' || s === 'mcp'),
        ),
        tools: new Set(Array.isArray(parsed.approvedTools) ? (parsed.approvedTools as string[]) : []),
      }
    }

    // v1 file — backward compat (no approvedTools)
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.approvedScopes)) {
      return {
        scopes: new Set(
          (parsed.approvedScopes as string[]).filter((s): s is ApprovedScope => s === 'core' || s === 'mcp'),
        ),
        tools: new Set(),
      }
    }

    console.warn('[permissionPersistence] permissions.json present but unrecognised shape; ignoring')
    return empty
  } catch (err) {
    console.warn('[permissionPersistence] failed to read permissions.json:', err)
    return empty
  }
}

/**
 * Write the approved-scopes and approved-tools sets to disk.
 * Fire-and-forget — failures are logged but do not interrupt the
 * permission flow (the in-memory grants remain live; the next
 * mutation will retry the persist).
 */
export async function savePermissionsToDisk(
  projectPath: string,
  approvedScopes: Set<ApprovedScope>,
  approvedTools: Set<string>,
): Promise<void> {
  if (!projectPath) return
  const payload: PermissionsFileV2 = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    approvedScopes: Array.from(approvedScopes),
    approvedTools: Array.from(approvedTools),
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
