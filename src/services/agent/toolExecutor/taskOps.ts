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
  evidence?: string
}

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled'])

function isTerminalTask(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status as TaskStatus)
}

// Trivial affirmations that are NOT verification evidence — flipping a task
// to completed with one of these (or with nothing) is the filesystem-inference
// failure mode wearing a hat. Matched case-insensitively against the trimmed
// evidence string. A real acceptance signal ("tsc clean", "200 OK {id:…}",
// "12 tests green") never collapses to one of these tokens.
const NON_EVIDENCE_TOKENS = new Set([
  'done', 'ok', 'okay', 'yes', 'complete', 'completed', 'finished', 'fixed',
  'works', 'working', 'good', 'n/a', 'na', 'file created', 'created', 'wrote file',
])

/** Whether `evidence` is a usable verification signal (not empty, not a
 *  bare affirmation). Deliberately lenient on length — terse-but-real
 *  evidence ("200 OK") must pass; only obvious non-evidence is rejected. */
function isAdequateEvidence(evidence: string | undefined): boolean {
  if (!evidence) return false
  const trimmed = evidence.trim()
  if (trimmed.length < 4) return false
  return !NON_EVIDENCE_TOKENS.has(trimmed.toLowerCase())
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

Evidence rule: when you flip a task to "completed" you MUST include an "evidence" field stating how its acceptance criterion was verified — the actual signal you observed (test output "12 passed", "tsc --noEmit clean", "GET /users → 200 {id:…}", "build succeeded"). This is per-task accountability, not a formality: "files exist on disk", "done", "ok" are NOT evidence and are rejected — a completion without real evidence is reverted to in_progress. You may complete several tasks in one call, but each needs its own evidence; if you can't articulate the verification for a task, you haven't verified it — keep it in_progress.`,
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
                evidence: { type: 'string', description: 'How this task was verified (e.g. "tsc clean", "GET /users → 200"). REQUIRED when status is "completed"; filesystem existence does not count.' },
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

      type IncomingTask = { id: string; description?: string; status: string; dependsOn?: string[]; blockedBy?: string[]; files?: string[]; evidence?: string }
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
            ...(t.evidence !== undefined ? { evidence: t.evidence } : {}),
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
            ...(t.evidence ? { evidence: t.evidence } : {}),
          })
        }
      }

      const tasks = [...merged, ...newTasks]

      // Evidence guard — per-task accountability replaces the old blunt
      // count ceiling. Every task freshly flipped to `completed` must carry
      // verification evidence on its incoming entry. This targets the root
      // cause of the 2026-05-19 failure mode (batch-completing 12→23 because
      // files existed on disk) directly: marking N tasks done now requires
      // articulating HOW each was verified, which "files exist" cannot. Unlike
      // a per-call ceiling, it can't be bypassed by fractioning the call into
      // chunks of 2, and it never reverts a genuinely-verified completion.
      //
      // No seed exemption: a /plan seed is all-pending (zero completions, never
      // triggers this), so the only way to seed a `completed` task on an empty
      // tracker is to claim done — which, after `clearTasks` on a new session,
      // is exactly the inference path we must still gate. (Disk rehydration
      // goes through setTasks, not this tool, so it never hits the guard.)
      const evidenceById = new Map(incoming.map(t => [t.id, t.evidence] as const))
      const unverifiedIds = tasks
        .filter(t => t.status === 'completed' && !prevCompletedIds.has(t.id))
        .filter(t => !isAdequateEvidence(evidenceById.get(t.id)))
        .map(t => t.id)

      // Revert only the unverified completions to in_progress — verified ones
      // in the same call stick. Compute the final list BEFORE any write so the
      // unverified-completed state never reaches the store or disk.
      const revertSet = new Set(unverifiedIds)
      const finalTasks = revertSet.size === 0
        ? tasks
        : tasks.map(t => revertSet.has(t.id) ? { ...t, status: 'in_progress' as const } : t)

      useAgentStore.getState().setTasks(finalTasks)

      // Persist to tasks.json so the tracker survives restarts.
      const project = useProjectStore.getState().currentProject
      if (project?.path) {
        void import('../taskPersistence').then(({ saveTasksToDisk }) =>
          saveTasksToDisk(project.path, finalTasks),
        ).catch(() => { /* non-critical */ })
      }

      // Bump fsVersion to invalidate prompt cache
      void import('../../fsVersion').then(m => m.bumpFsVersion('update_tasks')).catch(() => { /* non-critical */ })

      // Mark planTasksSeeded after first update_tasks in plan mode
      if (ctx.getPlanMode() && ctx.getPlanFileWritten()) {
        ctx.setPlanTasksSeeded(true)
      }

      if (revertSet.size > 0) {
        return `BLOCKED: ${unverifiedIds.length} task(s) were marked completed without verification evidence (IDs: ${unverifiedIds.join(', ')}). A task is "completed" only when its acceptance criterion is verified — re-send each with an "evidence" field stating the signal you observed (e.g. "tsc --noEmit clean", "GET /users → 200 {id:…}", "14 tests pass"). "files exist on disk" / "done" do NOT count. These tasks have been reverted to in_progress.${unverifiedIds.length < (tasks.filter(t => t.status === 'completed' && !prevCompletedIds.has(t.id)).length) ? ' (Completions with valid evidence in this call were accepted.)' : ''}`
      }

      return formatTaskUpdateResult(finalTasks, resetArchivedList)
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
        // Remote fallback — the MoMenu payment skills are NOT bundled or on
        // disk; they live in a GitHub repo and are normally injected by the
        // /payments command. When the scaffolding-aware hint later tells the
        // agent to read_skill('mom-factura-*') (chatSections.ts), fetch it
        // FRESH from the same remote source so the hint actually resolves —
        // always the latest `main`, no app-side cache.
        const { isMomenuSkill, fetchMomenuSkill } = await import('../momenuSkills')
        if (isMomenuSkill(name)) {
          const remote = await fetchMomenuSkill(name)
          if (remote) {
            skillModule.trackInvokedSkill(remote.name, remote.content)
            return svc.formatSkillForReading(remote)
          }
          return `Error: skill "${name}" is a remote MoMenu skill that could not be fetched right now (offline, or the skill moved). Retry when online, or run /payments to integrate payments.`
        }
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
