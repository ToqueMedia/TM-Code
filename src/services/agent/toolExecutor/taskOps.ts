/**
 * Task and skill tools — update_tasks, read_skill, read_large_result.
 *
 * Extracted from toolExecutor.ts as part of the SOLID decomposition.
 * These tools operate on the task tracker and skill system, with
 * read_large_result reading from the shared largeResults map.
 */

import type { ToolRegistrationContext } from './context'

export function registerTaskTools(ctx: ToolRegistrationContext): void {
  // === update_tasks ===
  ctx.tools.set('update_tasks', {
    definition: {
      name: 'update_tasks',
      description: 'Update the task tracker. Call after completing a unit of work (test pass, endpoint wired, etc.). The task list is persisted and survives compaction — always mark a task completed immediately when the work is verified (not just when the files exist). Task statuses: pending | in_progress | completed.',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique task ID' },
                description: { type: 'string', description: 'What needs to be done (for the developer)' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: 'IDs of tasks that must complete first' },
                blockedBy: { type: 'array', items: { type: 'string' }, description: 'IDs of blocking tasks' },
                files: { type: 'array', items: { type: 'string' }, description: 'Files involved in this task' },
              },
              required: ['id', 'description', 'status'],
            },
            description: 'The complete task list (replaces the previous one)',
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

      const prev = useAgentStore.getState().tasks
      const prevCompletedIds = new Set(prev.filter(t => t.status === 'completed').map(t => t.id))

      const tasks = (input.tasks as Array<{ id: string; description: string; status: string; dependsOn?: string[]; blockedBy?: string[]; files?: string[] }>)
        .map(t => ({
          id: t.id,
          description: t.description,
          status: t.status as 'pending' | 'in_progress' | 'completed',
          dependsOn: t.dependsOn ?? [],
          blockedBy: t.blockedBy ?? [],
          files: t.files ?? [],
        }))

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

      const completed = tasks.filter(t => t.status === 'completed').length
      const newlyCompletedIds = tasks
        .filter(t => t.status === 'completed' && !prevCompletedIds.has(t.id))
        .map(t => t.id)

      // Batch-completion guard — soft warning, not a block.
      const wasSeed = prev.length === 0
      const jumpSize = newlyCompletedIds.length
      if (!wasSeed && jumpSize > 1) {
        return (
          `Task list updated: ${completed}/${tasks.length} completed.\n\n` +
          `⚠️ Batch-completion warning: ${jumpSize} tasks flipped to \`completed\` in this single call ` +
          `(IDs: ${newlyCompletedIds.join(', ')}). Each \`completed\` is a claim that THAT task's ` +
          `acceptance was verified — test passed, endpoint smoked, diff approved AND behaviour confirmed. ` +
          `If you batch-marked them by inferring "files exist → tasks done", revert the over-claim: ` +
          `set the non-verified ones back to \`in_progress\` on your next update_tasks call.`
        )
      }

      return `Task list updated: ${completed}/${tasks.length} completed.`
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
      const content = ctx.largeResults.get(id)
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
