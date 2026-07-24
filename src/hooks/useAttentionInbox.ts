/**
 * Unified attention inbox (Antigravity-style): one place for everything that
 * waits on the developer, across ALL projects in this process.
 *
 * Aggregates:
 *  - interactive prompts: permissions (current + queue), questions, credentials
 *    — including when the focused project is NOT the one that asked (F2 MDI);
 *  - finished parallel tasks whose result has not been opened yet.
 *
 * Each item carries the project it belongs to so the titlebar bell can deep-link
 * into that project when the user is working elsewhere.
 */

import { useMemo } from 'react'
import { usePermissionStore } from '@/stores/permissionStore'
import { useAskUserQuestionStore } from '@/stores/askUserQuestionStore'
import { useCredentialRequestStore } from '@/stores/credentialRequestStore'
import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { useProjectStore } from '@/stores/projectStore'

export type AttentionKind = 'permission' | 'question' | 'credentials' | 'task_done' | 'task_error'

export interface AttentionItem {
  id: string
  kind: AttentionKind
  /** Short line for the list (tool / question / task). */
  label: string
  /** Project folder name when known (cross-project notification). */
  projectName?: string
  /** Absolute path of the project that needs attention. */
  projectPath?: string
  /** Chat session to open (parallel tasks). */
  sessionId?: string
  taskId?: string
  createdAt: number
}

function projectNameFromPath(path: string | undefined | null): string | undefined {
  if (!path) return undefined
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

function resolveProjectMeta(projectId?: string | null): { projectPath?: string; projectName?: string } {
  if (!projectId) return {}
  const grants = usePermissionStore.getState().byProject[projectId]
  const pathFromGrants = grants?.projectPath || undefined
  const recents = useProjectStore.getState().recentProjects
  const fromList =
    recents.find(p => p.id === projectId)
    || (pathFromGrants ? recents.find(p => p.path === pathFromGrants) : undefined)
  const projectPath = pathFromGrants || fromList?.path
  const projectName = fromList?.name || projectNameFromPath(projectPath)
  return { projectPath, projectName }
}

export function useAttentionInbox(): AttentionItem[] {
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const permissionQueue = usePermissionStore(s => s.permissionQueue)
  const pendingQuestions = useAskUserQuestionStore(s => s.pending)
  const pendingCredentials = useCredentialRequestStore(s => s.pending)
  const runs = useParallelTaskStore(s => s.runs)
  // Re-render when workspace projects change (name lookup) or focus changes.
  const recentProjects = useProjectStore(s => s.recentProjects)
  const focusedPath = useProjectStore(s => s.currentProject?.path)

  return useMemo(() => {
    const items: AttentionItem[] = []
    const sessionIdForTask = (taskId: string | undefined): string | undefined => {
      if (!taskId) return undefined
      for (const r of runs.values()) if (r.id === taskId) return r.sessionId
      return undefined
    }
    const pathForTask = (taskId: string | undefined): string | undefined => {
      if (!taskId) return undefined
      for (const r of runs.values()) if (r.id === taskId) return r.projectPath
      return undefined
    }

    const permissions = pendingPermission
      ? [pendingPermission, ...permissionQueue]
      : [...permissionQueue]
    for (const perm of permissions) {
      const fromOrigin = resolveProjectMeta(perm.projectId ?? perm.origin?.projectId)
      const taskPath = pathForTask(perm.origin?.taskId)
      const projectPath = fromOrigin.projectPath || taskPath
      const projectName =
        fromOrigin.projectName
        || projectNameFromPath(projectPath)
        || (projectPath ? undefined : projectNameFromPath(focusedPath))
      // Project-bound main run stamps origin.taskId as `project:{id}` with the
      // folder name as label — use the tool name as the item body so the row
      // reads "my-app · write_file", not "my-app · my-app".
      const isProjectBoundMain = !!perm.origin?.taskId?.startsWith('project:')
      const toolLabel = isProjectBoundMain
        ? perm.toolName
        : (perm.origin?.label ?? perm.toolName)
      const displayProjectName = projectName
        || (isProjectBoundMain ? perm.origin?.label : undefined)
        || projectNameFromPath(projectPath)
      items.push({
        id: `perm-${perm.id}`,
        kind: 'permission',
        label: toolLabel,
        projectName: displayProjectName,
        projectPath: projectPath || focusedPath || undefined,
        sessionId: perm.origin?.sessionId ?? sessionIdForTask(perm.origin?.taskId),
        taskId: perm.origin?.taskId,
        createdAt: Date.now(),
      })
    }

    for (const [id, entry] of pendingQuestions) {
      const fromOrigin = resolveProjectMeta(entry.origin?.projectId)
      const taskPath = pathForTask(entry.origin?.taskId)
      const projectPath = fromOrigin.projectPath || taskPath || focusedPath || undefined
      items.push({
        id: `ask-${id}`,
        kind: 'question',
        label: entry.origin?.label ?? entry.questions[0]?.header ?? 'question',
        projectName: fromOrigin.projectName || projectNameFromPath(projectPath),
        projectPath,
        sessionId: sessionIdForTask(entry.origin?.taskId),
        taskId: entry.origin?.taskId,
        createdAt: Date.now(),
      })
    }

    for (const [id, entry] of pendingCredentials) {
      const fromOrigin = resolveProjectMeta(entry.origin?.projectId)
      const taskPath = pathForTask(entry.origin?.taskId)
      const projectPath = fromOrigin.projectPath || taskPath || focusedPath || undefined
      items.push({
        id: `cred-${id}`,
        kind: 'credentials',
        label: entry.origin?.label ?? entry.serviceName,
        projectName: fromOrigin.projectName || projectNameFromPath(projectPath),
        projectPath,
        sessionId: sessionIdForTask(entry.origin?.taskId),
        taskId: entry.origin?.taskId,
        createdAt: Date.now(),
      })
    }

    for (const run of runs.values()) {
      const finished = run.status === 'completed' || run.status === 'error'
      if (!finished || run.resultSeen) continue
      items.push({
        id: `task-${run.id}`,
        kind: run.status === 'completed' ? 'task_done' : 'task_error',
        label: run.description,
        projectName: projectNameFromPath(run.projectPath),
        projectPath: run.projectPath,
        sessionId: run.sessionId,
        taskId: run.id,
        createdAt: run.endedAt ?? run.createdAt,
      })
    }

    // Interactive prompts first (block agents), then finished-task results.
    const weight = (k: AttentionKind) => (k === 'task_done' || k === 'task_error' ? 1 : 0)
    return items.sort((a, b) => weight(a.kind) - weight(b.kind) || a.createdAt - b.createdAt)
  }, [
    pendingPermission,
    permissionQueue,
    pendingQuestions,
    pendingCredentials,
    runs,
    recentProjects,
    focusedPath,
  ])
}
