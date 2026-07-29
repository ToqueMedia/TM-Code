/**
 * Memory tools — persistent memory plus session memory.
 *
 * Extracted from toolExecutor.ts as part of the SOLID decomposition.
 * These tools manage the persistent memory system (memdir) across
 * user and project scopes.
 */

import { invoke } from '@/utils/invokeMetrics'
import { useProjectStore } from '../../../stores/projectStore'
import { READ_SESSION_MEMORY, UPDATE_SESSION_MEMORY } from '../toolNames'
import type { ToolRegistrationContext } from './context'

// ── Guarda anti-spam do update_session_memory ────────────────────────────
// Timestamp da última ESCRITA efetiva (module-level, como os trackers de
// leitura): duas escritas dentro desta janela indicam o padrão "task ticker"
// (chamadas por passo com mini-checklists) e o resultado passa a corrigir o
// modelo em vez de o elogiar. Só afeta a MENSAGEM devolvida — a escrita em
// si nunca é bloqueada.
const SESSION_MEMORY_SPAM_WINDOW_MS = 90_000
let lastSessionMemoryWrite: number | null = null

export function registerMemoryTools(ctx: ToolRegistrationContext): void {

  /**
   * Resolve memory scope for the current invocation.
   * Reads `_memoryScope` from the per-call input (set by ToolExecutor.execute()
   * when a sub-agent passes its agentType). Falls back to the ToolExecutor's
   * shared state for the main agent path.
   *
   * This per-invocation resolution prevents race conditions when multiple
   * sub-agents call memory tools concurrently — each invocation carries its
   * own scope rather than relying on shared mutable state.
   */
  function getMemoryScope(input: Record<string, unknown>): string | null {
    return (input._memoryScope as string | null) ?? ctx.getMemoryScopeAgentType()
  }

  /**
   * Projeto DESTE run — não o que o utilizador está a ver.
   *
   * As memórias resolviam o caminho por `useProjectStore.currentProject`, o
   * projeto FOCADO (auditoria 2026-07-28). Sob MDI, um run em background sobre
   * o projeto B enquanto o utilizador olha para o A escrevia as memórias de B
   * dentro do memdir de A — contaminação silenciosa entre projetos, e o
   * corredor paralelo liga explicitamente a memória persistente nas tarefas.
   * `ctx.getProjectRoot()` é a raiz ligada a ESTE executor (o runner faz
   * setProjectContext por tarefa); o store fica só como último recurso, para
   * caminhos que corram antes de haver raiz ligada.
   */
  function resolveRunProjectPath(): string | undefined {
    return ctx.getProjectRoot() || useProjectStore.getState().currentProject?.path
  }

  // === save_memory ===
  ctx.tools.set('save_memory', {
    definition: {
      name: 'save_memory',
      description:
        'Persist a long-lived memory the model should see in future turns and future sessions. Use when you learn a fact about the developer (their role, preferences), get explicit feedback ("don\'t do X" / "yes exactly, do X"), discover a project-specific decision worth keeping (initiative, deadline, ownership), or want to remember where to look up external info (Linear project, Grafana board). DO NOT save: code patterns/conventions derivable from the repo, git-blame style "who changed what", debugging recipes (the fix is in the code), or anything already in TMS.md. The entry is written to disk and travels with the project (project/reference types) or the IDE installation (user/feedback types).',
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
            description: 'One-line summary shown in MEMORY.md to decide if this memory is relevant to a future task. Hard limit 200 chars (the call is rejected above it); aim for ~150. Be specific — "user is data scientist focused on logging observability" beats "user is a data scientist".',
          },
          body: {
            type: 'string',
            description: 'Full memory content. For `feedback` and `project` types, structure as: Lead with the rule/fact, then a `**Why:**` line (the motivation — incident or strong preference) and a `**How to apply:**` line (when/where this kicks in). For `user` and `reference` types, plain prose is fine. Use [[other-name]] to link related memories.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional glob patterns for conditional activation. When set, this memory is only loaded when the agent has accessed files matching one of these patterns. Example: ["src/auth/**", "src/api/**"].',
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
      // `paths` era anunciado no schema e NUNCA lido (auditoria 2026-07-29): a
      // memória ficava gravada como incondicional e o modelo acreditava ter
      // pedido activação condicional. Toda a máquina a jusante já existia — o
      // frontmatter (buildMemoryFileContent), a coluna do índice
      // (INDEX_LINE_REGEX) e o filtro (matchesAccessedPaths no contextBuilder).
      // Só faltava esta ligação.
      const paths = Array.isArray(input.paths)
        ? (input.paths as unknown[])
            .map((p) => String(p ?? '').trim())
            // Uma vírgula parte a coluna do índice (é o separador da lista);
            // um `|` parte a própria linha. Rejeitar é mais honesto do que
            // gravar um padrão que o parser volta a ler ao contrário.
            .filter((p) => p.length > 0 && !p.includes(',') && !p.includes('|'))
            .slice(0, 12)
        : []

      if (!name) return 'save_memory failed: `name` is required and cannot be empty.'
      if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
        return `save_memory failed: \`type\` must be one of user/feedback/project/reference (got "${type}").`
      }
      if (!description) return 'save_memory failed: `description` is required (one-line summary for the index).'
      if (description.length > 200) return 'save_memory failed: `description` must be ≤200 chars (it goes on a single line in MEMORY.md).'
      if (!body) return 'save_memory failed: `body` is required (the actual memory content).'

      const scope = defaultScopeForType(type)
      const filename = memoryFilenameFor(type, name)
      const projectPath = resolveRunProjectPath()
      // Sub-agent memory isolation: reads scope from ToolExecutor state.
      // Safe because JS is single-threaded and the runner sets/clears
      // the scope synchronously around each agent turn.
      const memoryScope = getMemoryScope(input)
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
          content: buildMemoryFileContent(
            { name, type, description, ...(paths.length ? { paths } : {}) },
            body,
          ),
          subdirectory: memoryScope ?? undefined,
        })
      } catch (err) {
        return `save_memory failed to write topic file: ${err instanceof Error ? err.message : String(err)}`
      }

      // Update MEMORY.md — read existing, replace the line for this
      // name if present, otherwise append.
      try {
        const existingIndex = await loadMemoryIndex(scope, projectPath, memoryScope ?? undefined)
        // A coluna `| paths:` é o que o loadMemoryIndex volta a ler para
        // aplicar o filtro condicional — sem ela a memória carrega sempre.
        const lineToWrite = paths.length
          ? `- [${name}](${filename}) — ${description} | paths: ${paths.join(', ')}`
          : `- [${name}](${filename}) — ${description}`
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
          subdirectory: memoryScope ?? undefined,
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
        // Sessão do RUN, não a VISTA (auditoria 2026-07-28): um save_memory a
        // correr enquanto o utilizador olha para outra sessão marcava a errada
        // e o skip-gate do extractor disparava (ou deixava de disparar) na
        // sessão errada. Mesmo padrão do fix do snapshot BYOK.
        const chat = useChatStore.getState()
        const sessionId = chat.streamingSessionId ?? chat.activeSessionId
        if (sessionId) m.recordMemoryWrite(sessionId)
      }).catch(() => { /* noop */ })

      // A confirmação diz qual dos dois regimes ficou de facto gravado: com
      // `paths`, a memória só entra no prompt quando o agente tocar em
      // ficheiros que casem — dizer "todos os prompts futuros" seria falso.
      const where = scope === 'project' ? 'project' : 'IDE installation'
      return paths.length
        ? `Memory saved: ${scope}/${filename} (${type}), CONDITIONAL on paths [${paths.join(', ')}] — it enters the prompt only in turns where accessed files match one of them.`
        : `Memory saved: ${scope}/${filename} (${type}). It will appear in the persistent-memory section of every future prompt for this ${where}.`
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
      const projectPath = resolveRunProjectPath()
      const memoryScope = getMemoryScope(input)

      // Delete the topic file (idempotent).
      try {
        await invoke('delete_memory_file', {
          scope,
          projectPath: scope === 'project' ? projectPath : null,
          subdirectory: memoryScope ?? undefined,
          filename,
        })
      } catch (err) {
        return `forget_memory failed: ${err instanceof Error ? err.message : String(err)}`
      }

      // Strip the line from MEMORY.md.
      try {
        const existingIndex = await loadMemoryIndex(scope, projectPath, memoryScope ?? undefined)
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
            subdirectory: memoryScope ?? undefined,
          })
        }
      } catch (err) {
        console.warn('[forget_memory] index update failed:', err)
      }

      import('../../fsVersion').then(m => m.bumpFsVersion(`forget_memory:${name}`)).catch(() => {})
      import('../memorySelector').then(m => m.invalidateMemorySelectorCache()).catch(() => {})
      import('../memoryWriteTracker').then(async (m) => {
        const { useChatStore } = await import('../../../stores/chatStore')
        // Sessão do RUN, não a VISTA (auditoria 2026-07-28): um save_memory a
        // correr enquanto o utilizador olha para outra sessão marcava a errada
        // e o skip-gate do extractor disparava (ou deixava de disparar) na
        // sessão errada. Mesmo padrão do fix do snapshot BYOK.
        const chat = useChatStore.getState()
        const sessionId = chat.streamingSessionId ?? chat.activeSessionId
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
      const projectPath = resolveRunProjectPath()
      const memoryScope = getMemoryScope(input)
      const { loadMemoryMtimes } = await import('../memdir')
      const { memoryAgeWarning } = await import('../memoryAge')
      const [file, mtimes] = await Promise.all([
        loadMemoryFile(scope, filename, projectPath, memoryScope ?? undefined),
        loadMemoryMtimes(scope, projectPath, memoryScope ?? undefined),
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
    execute: async (input: Record<string, unknown>) => {
      const [
        { distillMemories },
        { loadMemoryFile, loadMemoryIndex, parseIndexEntries, memoryFilenameFor },
      ] = await Promise.all([
        import('../memoryDistiller'),
        import('../memdir'),
      ])

      const projectPath = resolveRunProjectPath()

      const memoryScopeDistill = getMemoryScope(input)
      const [userIdx, projectIdx] = await Promise.all([
        loadMemoryIndex('user'),
        projectPath
          ? loadMemoryIndex('project', projectPath, memoryScopeDistill ?? undefined)
          : Promise.resolve({ content: null } as { content: string | null }),
      ])

      const userEntries = userIdx.content ? parseIndexEntries(userIdx.content) : []
      const projectEntries = projectIdx.content ? parseIndexEntries(projectIdx.content) : []

      const memoryScope = getMemoryScope(input)
      const files: import('../memdir').MemoryFile[] = []
      const loadOps: Promise<unknown>[] = []
      for (const e of userEntries) {
        loadOps.push(
          loadMemoryFile('user', memoryFilenameFor(e.type, e.name), undefined, memoryScope ?? undefined).then(f => {
            if (f) files.push(f)
          }),
        )
      }
      for (const e of projectEntries) {
        loadOps.push(
          loadMemoryFile('project', memoryFilenameFor(e.type, e.name), projectPath, memoryScope ?? undefined).then(f => {
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

  // === update_session_memory ===
  ctx.tools.set(UPDATE_SESSION_MEMORY, {
    definition: {
      name: UPDATE_SESSION_MEMORY,
      description: 'Update session-scoped memory notes that survive context compaction but do not persist across sessions. Use for: in-progress work state, decisions made this session, partial results, things to remember after compact. The notes are injected into the system prompt after compaction so you can resume without loss. Write in bullet-point markdown. Each call REPLACES the previous notes (not appends). This is NOT a task tracker: do not call it per step to tick items — use update_tasks for checklist progress and update session memory only when the recorded state materially changes (typically once per task phase).',
      input_schema: {
        type: 'object',
        properties: {
          notes: {
            type: 'string',
            description: 'Complete session memory notes in markdown. Replaces previous. Include: current task status, key decisions, files being worked on, pending next steps, any blockers.',
          },
        },
        required: ['notes'],
      },
    },
    execute: async (args) => {
      const notes = String(args.notes || '').trim()
      if (!notes) return 'update_session_memory failed: `notes` is required.'

      try {
        const { useChatStore } = await import('../../../stores/chatStore')
        const store = useChatStore.getState()
        // Sessão do RUN, não a que está no ecrã: comparar com as notas de
        // outra sessão dava "unchanged" errado e escondia a escrita.
        const previous = store.getRunSession()?.sessionMemory ?? ''

        // Guardas anti-spam (observado 2026-07-13: 5 chamadas seguidas com
        // mini-checklists de 29–80 chars — o modelo usava isto como task
        // ticker por passo, queimando tool calls sem valor: notas desse
        // tamanho nem servem para recuperação pós-compactação). O guardrail
        // do fim de run (query.ts, reconciliação) não cobre o meio do run,
        // e a mensagem de sucesso antiga até REFORÇAVA o padrão. A escrita
        // nunca é bloqueada (last-write-wins é o contrato) — o resultado é
        // que passa a treinar o modelo para o uso certo.
        if (notes === previous) {
          return 'Session memory unchanged (identical notes already stored). '
            + 'Do not re-call this tool to "confirm" state — it replaces, not appends. '
            + 'For step-by-step checklist progress use update_tasks instead.'
        }

        store.setSessionMemory(notes)

        const nowMs = Date.now()
        const rapidRecall = lastSessionMemoryWrite !== null
          && nowMs - lastSessionMemoryWrite < SESSION_MEMORY_SPAM_WINDOW_MS
        lastSessionMemoryWrite = nowMs

        if (rapidRecall) {
          return `Session memory updated (${notes.length} chars) — but you already updated it seconds ago. `
            + 'This tool REPLACES the notes and exists for post-compaction recovery, not per-step progress ticking. '
            + 'Track checklist state with update_tasks; update session memory only when the recorded state materially changes.'
        }
        return `Session memory updated (${notes.length} chars). These notes will survive context compaction.`
      } catch {
        return 'update_session_memory failed: could not access chat store.'
      }
    },
  })

  // === read_session_memory ===
  ctx.tools.set(READ_SESSION_MEMORY, {
    definition: {
      name: READ_SESSION_MEMORY,
      description: 'Read the current session memory notes. Use to check what was recorded earlier in this session — especially useful after compaction when earlier conversation context was summarized.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    execute: async () => {
      try {
        const { useChatStore } = await import('../../../stores/chatStore')
        const session = useChatStore.getState().getRunSession()
        if (!session?.sessionMemory) {
          return '(no session memory recorded yet — call update_session_memory to start tracking session state)'
        }
        return session.sessionMemory
      } catch {
        return 'read_session_memory failed: could not access chat store.'
      }
    },
  })
}
