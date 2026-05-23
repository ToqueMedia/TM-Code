/**
 * Memory tools — save_memory, forget_memory, read_memory, distill_memory.
 *
 * Extracted from toolExecutor.ts as part of the SOLID decomposition.
 * These tools manage the persistent memory system (memdir) across
 * user and project scopes.
 */

import { invoke } from '@/utils/invokeMetrics'
import { useProjectStore } from '../../../stores/projectStore'
import type { ToolRegistrationContext } from './context'

export function registerMemoryTools(ctx: ToolRegistrationContext): void {

  // === save_memory ===
  ctx.tools.set('save_memory', {
    definition: {
      name: 'save_memory',
      description:
        'Persist a long-lived memory the model should see in future turns and future sessions. Use when you learn a fact about the developer (their role, preferences), get explicit feedback ("don\'t do X" / "yes exactly, do X"), discover a project-specific decision worth keeping (initiative, deadline, ownership), or want to remember where to look up external info (Linear project, Grafana board). DO NOT save: code patterns/conventions derivable from the repo, git-blame style "who changed what", debugging recipes (the fix is in the code), or anything already in CLAUDE.md. The entry is written to disk and travels with the project (project/reference types) or the IDE installation (user/feedback types).',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short kebab-case slug identifying this memory. Used both as the filename and to update or link the entry later. Example: "no-emojis", "rename-tm-code", "auth-proxy-pattern".',
          },
          type: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
            description: 'Closed taxonomy: `user` (developer role/profile/skills), `feedback` (explicit correction OR validated approach, with Why + How), `project` (ongoing initiative/decision/bug context for the current project), `reference` (where to look for X in external systems).',
          },
          description: {
            type: 'string',
            description: 'One-line summary (≤150 chars) shown in MEMORY.md to decide if this memory is relevant to a future task. Be specific — "user is data scientist focused on logging observability" beats "user is a data scientist".',
          },
          body: {
            type: 'string',
            description: 'Full memory content. For `feedback` and `project` types, structure as: Lead with the rule/fact, then a `**Why:**` line (the motivation — incident or strong preference) and a `**How to apply:**` line (when/where this kicks in). For `user` and `reference` types, plain prose is fine. Use [[other-name]] to link related memories.',
          },
        },
        required: ['name', 'type', 'description', 'body'],
      },
    },
    execute: async (input) => {
      const { defaultScopeForType, memoryFilenameFor, buildMemoryFileContent, loadMemoryIndex } =
        await import('../memdir')
      const name = String(input.name || '').trim()
      const type = String(input.type || '').trim() as 'user' | 'feedback' | 'project' | 'reference'
      const description = String(input.description || '').trim()
      const body = String(input.body || '').trim()

      if (!name) return 'save_memory failed: `name` is required and cannot be empty.'
      if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
        return `save_memory failed: \`type\` must be one of user/feedback/project/reference (got "${type}").`
      }
      if (!description) return 'save_memory failed: `description` is required (one-line summary for the index).'
      if (description.length > 200) return 'save_memory failed: `description` must be ≤200 chars (it goes on a single line in MEMORY.md).'
      if (!body) return 'save_memory failed: `body` is required (the actual memory content).'

      const scope = defaultScopeForType(type)
      const filename = memoryFilenameFor(type, name)
      const projectPath = useProjectStore.getState().currentProject?.path
      if (scope === 'project' && !projectPath) {
        return 'save_memory failed: project-scope memories require an open project. Try `type: "user"` for a cross-project fact.'
      }

      // Write the topic file first — if this fails the index isn't
      // touched, so MEMORY.md never points at a missing entry.
      try {
        await invoke('write_memory_file', {
          scope,
          projectPath: scope === 'project' ? projectPath : null,
          filename,
          content: buildMemoryFileContent({ name, type, description }, body),
        })
      } catch (err) {
        return `save_memory failed to write topic file: ${err instanceof Error ? err.message : String(err)}`
      }

      // Update MEMORY.md — read existing, replace the line for this
      // name if present, otherwise append.
      try {
        const existingIndex = await loadMemoryIndex(scope, projectPath)
        const lineToWrite = `- [${name}](${filename}) — ${description}`
        let lines = (existingIndex.content ?? '').split('\n')
        const warningIdx = lines.findIndex(l => l.startsWith('> ⚠️ MEMORY.md'))
        if (warningIdx >= 0) lines = lines.slice(0, warningIdx).filter(l => l.length > 0)
        const headerLines = lines[0]?.startsWith('# ') ? [lines[0]] : ['# Memory Index']
        const entryLines = lines
          .slice(headerLines.length)
          .filter(l => l.trim().length > 0 && !l.includes(`(${filename})`))
        entryLines.push(lineToWrite)
        entryLines.sort((a, b) => a.localeCompare(b))
        const merged = [...headerLines, '', ...entryLines, ''].join('\n')
        await invoke('write_memory_file', {
          scope,
          projectPath: scope === 'project' ? projectPath : null,
          filename: 'MEMORY.md',
          content: merged,
        })
      } catch (err) {
        console.warn('[save_memory] index update failed:', err)
      }

      import('../../fsVersion').then(m => m.bumpFsVersion(`save_memory:${name}`)).catch(() => {})
      import('../memorySelector').then(m => m.invalidateMemorySelectorCache()).catch(() => {})
      import('../memoryProposalsStore').then(m =>
        m.markProposalSaved(projectPath ?? null, name, type),
      ).catch(() => { /* noop */ })
      import('../memoryWriteTracker').then(async (m) => {
        const { useChatStore } = await import('../../../stores/chatStore')
        const sessionId = useChatStore.getState().activeSessionId
        if (sessionId) m.recordMemoryWrite(sessionId)
      }).catch(() => { /* noop */ })

      return `Memory saved: ${scope}/${filename} (${type}). It will appear in the persistent-memory section of every future prompt for this ${scope === 'project' ? 'project' : 'IDE installation'}.`
    },
  })

  // === forget_memory ===
  ctx.tools.set('forget_memory', {
    definition: {
      name: 'forget_memory',
      description: 'Remove a previously-saved memory. Use when a memory turns out to be wrong, outdated, or no longer applies (developer changed their preference, project moved off the approach, fact was learned to be incorrect). Specify the same `name` you used when saving.',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The kebab-case slug used at save time.',
          },
          type: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
            description: 'The type used at save time — needed to construct the filename. If you forget the type, list_directory the memory dir to find the right one.',
          },
        },
        required: ['name', 'type'],
      },
    },
    execute: async (input) => {
      const { defaultScopeForType, memoryFilenameFor, loadMemoryIndex } = await import('../memdir')
      const name = String(input.name || '').trim()
      const type = String(input.type || '').trim() as 'user' | 'feedback' | 'project' | 'reference'

      if (!name) return 'forget_memory failed: `name` is required.'
      if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
        return `forget_memory failed: \`type\` must be one of user/feedback/project/reference (got "${type}").`
      }

      const scope = defaultScopeForType(type)
      const filename = memoryFilenameFor(type, name)
      const projectPath = useProjectStore.getState().currentProject?.path

      // Delete the topic file (idempotent).
      try {
        await invoke('delete_memory_file', {
          scope,
          projectPath: scope === 'project' ? projectPath : null,
          filename,
        })
      } catch (err) {
        return `forget_memory failed: ${err instanceof Error ? err.message : String(err)}`
      }

      // Strip the line from MEMORY.md.
      try {
        const existingIndex = await loadMemoryIndex(scope, projectPath)
        if (existingIndex.content) {
          let lines = existingIndex.content.split('\n')
          const warningIdx = lines.findIndex(l => l.startsWith('> ⚠️ MEMORY.md'))
          if (warningIdx >= 0) lines = lines.slice(0, warningIdx)
          const filtered = lines.filter(l => !l.includes(`(${filename})`))
          await invoke('write_memory_file', {
            scope,
            projectPath: scope === 'project' ? projectPath : null,
            filename: 'MEMORY.md',
            content: filtered.join('\n'),
          })
        }
      } catch (err) {
        console.warn('[forget_memory] index update failed:', err)
      }

      import('../../fsVersion').then(m => m.bumpFsVersion(`forget_memory:${name}`)).catch(() => {})
      import('../memorySelector').then(m => m.invalidateMemorySelectorCache()).catch(() => {})
      import('../memoryWriteTracker').then(async (m) => {
        const { useChatStore } = await import('../../../stores/chatStore')
        const sessionId = useChatStore.getState().activeSessionId
        if (sessionId) m.recordMemoryWrite(sessionId)
      }).catch(() => { /* noop */ })
      return `Memory forgotten: ${scope}/${filename}.`
    },
  })

  // === read_memory ===
  ctx.tools.set('read_memory', {
    definition: {
      name: 'read_memory',
      description: 'Read the full body of a memory entry referenced in MEMORY.md. The system prompt injects only the one-line summaries (the indexes); call this when you need the Why / How to apply detail behind a feedback or project entry.',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The kebab-case slug from MEMORY.md.',
          },
          type: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
            description: 'The memory type (also encoded in the filename prefix shown in MEMORY.md).',
          },
        },
        required: ['name', 'type'],
      },
    },
    execute: async (input) => {
      const { defaultScopeForType, memoryFilenameFor, loadMemoryFile } = await import('../memdir')
      const name = String(input.name || '').trim()
      const type = String(input.type || '').trim() as 'user' | 'feedback' | 'project' | 'reference'

      if (!name) return 'read_memory failed: `name` is required.'
      if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
        return `read_memory failed: \`type\` must be one of user/feedback/project/reference (got "${type}").`
      }

      const scope = defaultScopeForType(type)
      const filename = memoryFilenameFor(type, name)
      const projectPath = useProjectStore.getState().currentProject?.path
      const { loadMemoryMtimes } = await import('../memdir')
      const { memoryAgeWarning } = await import('../memoryAge')
      const [file, mtimes] = await Promise.all([
        loadMemoryFile(scope, filename, projectPath),
        loadMemoryMtimes(scope, projectPath),
      ])
      if (!file) {
        return `Memory not found: ${scope}/${filename}. Check MEMORY.md for the current list of names + types.`
      }
      const body = file.body || `[Memory ${filename} is empty]`
      const warning = memoryAgeWarning(mtimes.get(filename) ?? 0)
      return warning + body
    },
  })

  // === distill_memory ===
  ctx.tools.set('distill_memory', {
    definition: {
      name: 'distill_memory',
      description:
        'Review the full persistent memory (user + project scopes) and propose hygiene actions: merge near-duplicates, delete stale/superseded entries, rewrite imprecise bodies. Returns proposals for review — does NOT apply them. Use periodically when the developer asks for memory cleanup, or when you notice contradictions / duplicates while reading the catalog. After this returns, surface the proposals to the developer in plain language, get explicit approval for each one, then call `save_memory` (for merges and rewrites) or `forget_memory` (for deletes) to apply.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    execute: async () => {
      const [
        { distillMemories },
        { loadMemoryFile, loadMemoryIndex, parseIndexEntries, memoryFilenameFor },
      ] = await Promise.all([
        import('../memoryDistiller'),
        import('../memdir'),
      ])

      const projectPath = useProjectStore.getState().currentProject?.path

      const [userIdx, projectIdx] = await Promise.all([
        loadMemoryIndex('user'),
        projectPath
          ? loadMemoryIndex('project', projectPath)
          : Promise.resolve({ content: null } as { content: string | null }),
      ])

      const userEntries = userIdx.content ? parseIndexEntries(userIdx.content) : []
      const projectEntries = projectIdx.content ? parseIndexEntries(projectIdx.content) : []

      const files: import('../memdir').MemoryFile[] = []
      const loadOps: Promise<unknown>[] = []
      for (const e of userEntries) {
        loadOps.push(
          loadMemoryFile('user', memoryFilenameFor(e.type, e.name)).then(f => {
            if (f) files.push(f)
          }),
        )
      }
      for (const e of projectEntries) {
        loadOps.push(
          loadMemoryFile('project', memoryFilenameFor(e.type, e.name), projectPath).then(f => {
            if (f) files.push(f)
          }),
        )
      }
      await Promise.all(loadOps)

      if (files.length === 0) {
        return 'No memories saved yet — nothing to distill. Run `save_memory` first when you learn facts worth persisting; come back here once the catalog has accumulated.'
      }

      if (files.length < 8) {
        return `Only ${files.length} memory entries exist — too few to meaningfully distill. Distillation pays off once the catalog has 8+ entries with overlap. Skipping for now.`
      }

      const result = await distillMemories({ files })
      if (!result) {
        return 'Distillation failed (network / side-car model unavailable). Try again later — the memdir is unchanged.'
      }

      void import('../../analytics').then(({ trackEvent }) =>
        trackEvent('memory_distiller_run', {
          input_files: files.length,
          input_bytes: result.inputBytes,
          input_truncated: result.inputTruncated,
          proposals: result.proposals.length,
          latency_ms: result.latencyMs,
        }),
      ).catch(() => { /* noop */ })

      if (result.proposals.length === 0) {
        return `Distilled ${files.length} memory entries — no hygiene actions needed. The catalog looks clean (no obvious duplicates, contradictions, or stale entries).`
      }

      const lines: string[] = [
        `Distilled ${files.length} memory entries — ${result.proposals.length} hygiene proposal${result.proposals.length === 1 ? '' : 's'} below.`,
        '',
        'Review each with the developer, get explicit approval, then apply:',
        '- **merge** / **rewrite** → call `save_memory(name, type, description, body)` with the proposed name/description/body. Then `forget_memory` any obsolete original names.',
        '- **delete** → call `forget_memory(name, type)` for each target.',
        '',
        '---',
        '',
      ]
      for (const [i, p] of result.proposals.entries()) {
        lines.push(`### Proposal ${i + 1}: \`${p.action}\``)
        lines.push(`**Targets:** ${p.targets.map(t => `\`${t}\``).join(', ')}`)
        lines.push(`**Why:** ${p.rationale}`)
        if (p.action !== 'delete') {
          lines.push(`**Proposed name:** \`${p.newName ?? p.targets[0]}\``)
          lines.push(`**Proposed description:** ${p.newDescription ?? ''}`)
          lines.push('**Proposed body:**')
          lines.push('```')
          lines.push(p.newBody ?? '')
          lines.push('```')
        }
        lines.push('')
      }
      if (result.inputTruncated) {
        lines.push(`> Note: the input was truncated to fit the model's window. Re-run distill_memory after applying a first batch — the remaining entries will be considered next time.`)
      }
      return lines.join('\n')
    },
  })
}
