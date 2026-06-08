/**
 * Task and skill tools — update_tasks, read_skill, read_large_result.
 *
 * Extracted from toolExecutor.ts as part of the SOLID decomposition.
 * These tools operate on the task tracker and skill system, with
 * read_large_result reading from the shared largeResults map.
 */

import type { ToolRegistrationContext } from './context'

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
type StoredTask = {
  id: string
  description: string
  status: TaskStatus
  dependsOn?: string[]
  blockedBy?: string[]
  files?: string[]
}

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled'])

function isTerminalTask(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status as TaskStatus)
}

function formatTaskUpdateResult(tasks: StoredTask[], resetArchivedList: boolean): string {
  const completed = tasks.filter(t => t.status === 'completed').length
  const lines = [`Task list updated: ${completed}/${tasks.length} completed.`]
  const activeTasks = tasks.filter(t => !isTerminalTask(t.status))

  if (activeTasks.length === 0) return lines[0]

  lines.push(resetArchivedList ? 'New task list:' : 'Active tasks:')
  for (const task of activeTasks) {
    const marker = task.status === 'in_progress' ? '~' : ' '
    lines.push(`- [${marker}] ${task.id}: ${task.description}`)
  }
  return lines.join('\n')
}

export function registerTaskTools(ctx: ToolRegistrationContext): void {
  // === update_tasks ===
  ctx.tools.set('update_tasks', {
    definition: {
      name: 'update_tasks',
      description: `Update the task tracker. Call after completing a unit of work (test pass, endpoint wired, etc.). The task list is persisted and survives compaction — always mark a task completed immediately when the work is verified (not just when the files exist).

Task statuses: pending | in_progress | completed | failed | cancelled.
- Use "failed" when a task cannot be completed (dependency missing, API down, permission denied) — include the reason in the description.
- Use "cancelled" when the developer or agent explicitly skips a task.

Patch semantics: each entry in the tasks array is MERGED with the existing task by ID. To update only a status, send { id, status } — description is optional for existing tasks. New IDs (not in the current tracker) are appended. This prevents accidental task loss when the full list is not re-sent.

Batch-completion rule: marking more than 2 tasks as completed in a single call reverts them to in_progress. Complete tasks one at a time with verification evidence (test output, endpoint response, etc.).`,
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique task ID' },
                description: { type: 'string', description: 'What needs to be done (for the developer). Required for NEW tasks; optional when updating an existing task by ID.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'], description: 'Current status' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: 'IDs of tasks that must complete first' },
                blockedBy: { type: 'array', items: { type: 'string' }, description: 'IDs of blocking tasks' },
                files: { type: 'array', items: { type: 'string' }, description: 'Files involved in this task' },
              },
              required: ['id', 'status'],
            },
            description: 'Task updates — merged by ID with the existing tracker. New IDs are appended.',
          },
        },
        required: ['tasks'],
      },
    },
    execute: async (input) => {
      const { useAgentStore } = await import('../../../stores/agentStore')
      const { useProjectStore } = await import('../../../stores/projectStore')

      // Plan-mode gate: update_tasks must follow write_file (PLAN.md).
      if (ctx.getPlanMode() && !ctx.getPlanFileWritten()) {
        return 'Blocked in /plan mode: update_tasks must follow write_file — create PLAN.md first, then seed the task tracker.'
      }

      const prev = useAgentStore.getState().tasks as StoredTask[]
      const prevCompletedIds = new Set(prev.filter(t => t.status === 'completed').map(t => t.id))

      type IncomingTask = { id: string; description?: string; status: string; dependsOn?: string[]; blockedBy?: string[]; files?: string[] }
      const incoming = input.tasks as IncomingTask[]
      const prevAllTerminal = prev.length > 0 && prev.every(t => isTerminalTask(t.status))
      const incomingAddsNewTask = incoming.some(t => !prev.some(existing => existing.id === t.id))
      const resetArchivedList = prevAllTerminal && incomingAddsNewTask
      const baseTasks = resetArchivedList ? [] : prev

      // Patch-merge: start from the existing tracker, apply updates by ID,
      // append new tasks. This prevents accidental deletion when the model
      // sends a partial list (e.g. after context compression).
      //
      // Exception: if the previous tracker is already archival (every task is
      // terminal) and the agent adds new IDs, treat the call as a fresh task
      // list. This keeps new work visible instead of appending it under an
      // old completed plan that the UI correctly hides.
      const merged = [...baseTasks]
      const newTasks: StoredTask[] = []

      for (const t of incoming) {
        const status = t.status as TaskStatus
        const existingIdx = merged.findIndex(m => m.id === t.id)
        if (existingIdx !== -1) {
          // Patch existing task — description/dependsOn/blockedBy/files
          // are optional on update. Spread the incoming fields so they
          // replace (not merge) the existing arrays — an empty array
          // means "no dependencies", undefined means "keep existing".
          merged[existingIdx] = {
            ...merged[existingIdx],
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...(t.dependsOn !== undefined ? { dependsOn: t.dependsOn } : {}),
            ...(t.blockedBy !== undefined ? { blockedBy: t.blockedBy } : {}),
            ...(t.files !== undefined ? { files: t.files } : {}),
            status,
          }
        } else {
          // New task — description is required for seeding
          if (!t.description) {
            return `Error: task "${t.id}" is new but has no description. Provide a description for new tasks.`
          }
          newTasks.push({
            id: t.id,
            description: t.description,
            status,
            ...(t.dependsOn ? { dependsOn: t.dependsOn } : {}),
            ...(t.blockedBy ? { blockedBy: t.blockedBy } : {}),
            ...(t.files ? { files: t.files } : {}),
          })
        }
      }

      const tasks = [...merged, ...newTasks]

      useAgentStore.getState().setTasks(tasks)

      // Persist to tasks.json so the tracker survives restarts.
      const project = useProjectStore.getState().currentProject
      if (project?.path) {
        void import('../taskPersistence').then(({ saveTasksToDisk }) =>
          saveTasksToDisk(project.path, tasks),
        ).catch(() => { /* non-critical */ })
      }

      // Bump fsVersion to invalidate prompt cache
      void import('../../fsVersion').then(m => m.bumpFsVersion('update_tasks')).catch(() => { /* non-critical */ })

      // Mark planTasksSeeded after first update_tasks in plan mode
      if (ctx.getPlanMode() && ctx.getPlanFileWritten()) {
        ctx.setPlanTasksSeeded(true)
      }

      const newlyCompletedIds = tasks
        .filter(t => t.status === 'completed' && !prevCompletedIds.has(t.id))
        .map(t => t.id)

      // Batch-completion guard — HARD enforcement. When >2 tasks are flipped
      // to completed in one call (and it's not the initial seed), revert
      // them to in_progress and require one-at-a-time verification.
      // This prevents the 2026-05-19 failure mode (batch-completing 12→23
      // in two calls because files existed on disk).
      const wasSeed = prev.length === 0
      const jumpSize = newlyCompletedIds.length
      const BATCH_LIMIT = 2
      if (!wasSeed && jumpSize > BATCH_LIMIT) {
        // Revert the batch-completed tasks back to in_progress
        const revertedIds = new Set(newlyCompletedIds)
        const reverted = tasks.map(t =>
          revertedIds.has(t.id) ? { ...t, status: 'in_progress' as const } : t
        )
        useAgentStore.getState().setTasks(reverted)
        // Persist the reverted state
        if (project?.path) {
          void import('../taskPersistence').then(({ saveTasksToDisk }) =>
            saveTasksToDisk(project.path, reverted),
          ).catch(() => { /* non-critical */ })
        }
        return `BLOCKED: ${jumpSize} tasks were marked completed at once (IDs: ${newlyCompletedIds.join(', ')}). Batch completion is not allowed — complete tasks ONE AT A TIME with verification evidence (test output, endpoint response, etc.). The affected tasks have been reverted to in_progress. Pick the first one and verify it individually.`
      }

      return formatTaskUpdateResult(tasks, resetArchivedList)
    },
  })

  // === read_skill ===
  ctx.tools.set('read_skill', {
    definition: {
      name: 'read_skill',
      description: 'Load the full content of a skill (process, examples, install steps, verification) by its name. The system prompt lists each available skill with a one-line description; call this tool ONCE per skill when you decide it is relevant to the current task. Content stays in conversation history afterward — no need to re-read.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name (kebab-case, e.g. "auth-proxy", "publish-backend")' },
        },
        required: ['name'],
      },
      concurrencySafe: true,
    },
    execute: async (input) => {
      const name = (input.name as string)?.trim().toLowerCase()
      if (!name) return 'Error: `name` is required.'

      const skillModule = await import('../skillService')
      const svc = skillModule.default.getInstance()
      const skill = svc.getCachedSkillContent(name)

      if (!skill) {
        const available = svc.getCachedSkillNames()
        return `Error: skill "${name}" is not loaded for the current context. Available skills: ${available.join(', ') || '(none — check the "Skills available" section of the system prompt)'}.`
      }

      // Cache the skill body in module-level state so it survives context compression.
      skillModule.trackInvokedSkill(skill.name, skill.content)
      return svc.formatSkillForReading(skill)
    },
  })

  // === read_large_result ===
  ctx.tools.set('read_large_result', {
    definition: {
      name: 'read_large_result',
      description: 'Read a portion of a large tool result that was too big to return inline. Use the reference ID from the "Output too large" message. Specify offset and limit to read specific sections.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Reference ID (e.g., "large_result_1")' },
          offset: { type: 'number', description: 'Character offset to start reading from. Default: 0.' },
          limit: { type: 'number', description: 'Maximum characters to return. Default: 10000. Max: 25000 — read in 2–3 well-targeted pages instead of one giant slice; the suffix tells you exactly how many chars remain.' },
        },
        required: ['id'],
      },
      concurrencySafe: true,
    },
    execute: async (input) => {
      const id = input.id as string
      // L1: in-memory Map (fast path)
      let content: string | undefined = ctx.largeResults.get(id)
      // L2: disk fallback (survives session reload)
      if (!content) {
        const diskContent = await ctx.readLargeResultFromDisk(id)
        if (diskContent) {
          content = diskContent
          // Re-populate the Map so subsequent reads are fast
          ctx.largeResults.set(id, content)
        }
      }
      if (!content) {
        return `Error: Large result "${id}" not found. It may have been cleared from memory. Available results: ${Array.from(ctx.largeResults.keys()).join(', ') || 'none'}`
      }

      const offset = Math.max(0, (input.offset as number) || 0)
      const limit = Math.min((input.limit as number) || 10000, 25000)
      const end = Math.min(offset + limit, content.length)
      const slice = content.slice(offset, end)
      const remaining = content.length - end

      // S1: detect overlap with ranges already read in this session for
      // this large_result id, AND coalesce adjacent ranges so the list
      // stays small. trackShownRange returns the first range the new
      // read touches (or null on disjoint).
      ctx.trackShownRange(id, offset, end)

      const suffix = remaining > 0
        ? `\n\n[read_large_result: showing chars ${offset}–${end} of ${content.length}. ${remaining} chars remain — call again with offset: ${end}]`
        : ''

      return slice + suffix
    },
  })
}
