/**
 * Project instructions compat loader.
 *
 * TM Code's canonical project memory is TMS.md. Many repos only ship
 * AGENTS.md (Codex / multi-agent) or CLAUDE.md (Claude Code). Until /init
 * promotes those into TMS.md, the agent still needs to *see* them at runtime.
 *
 * Precedence (product policy):
 *   - TMS.md is canonical when present (full body in the static system prompt).
 *   - Foreign primary is first of: AGENTS.md → CLAUDE.md → .claude/CLAUDE.md.
 *   - Foreign is always discovered (for project.docs_full dual-case) but only
 *     used as the default prompt path when TMS is missing (full body, same static).
 *
 * I/O is best-effort via the same safeReadFile cache as contextBuilder.
 */

import { safeReadFile } from './contextBuilder/projectUtils'

export type ForeignInstructionKind = 'agents' | 'claude' | 'claude_dot'
export type InstructionSourceKind = 'tms' | ForeignInstructionKind

export interface InstructionSource {
  kind: InstructionSourceKind
  /** Absolute path on disk. */
  path: string
  /** Project-relative path for prompts (forward slashes). */
  relPath: string
  content: string
}

export type ForeignInstructionSource = InstructionSource & {
  kind: ForeignInstructionKind
}

export interface ProjectInstructionsBundle {
  /** Real TMS.md body only — injected full in the static system prompt. */
  tms: InstructionSource | null
  /**
   * Primary foreign instructions (AGENTS / CLAUDE). Always populated when
   * the file exists, even if TMS also exists (docs_full dual-case).
   */
  foreignPrimary: ForeignInstructionSource | null
  hasAny: boolean
}

/** Cap for full foreign body in project.docs_full (claude-vaz MAX_MEMORY). */
export const FOREIGN_DOCS_FULL_MAX_CHARS = 40_000

/**
 * Soft cap for TMS.md (or sole foreign file) in the static system prompt.
 * Matches claude-vaz MAX_MEMORY_CHARACTER_COUNT — named truncate, not silent.
 */
export const STATIC_PROJECT_INSTRUCTIONS_MAX_CHARS = 40_000

/** Cap for parallel-task inline inject (matches prior TMS truncate). */
export const FOREIGN_PARALLEL_TASK_MAX_CHARS = 8_000

/** Cap for permission-classifier project notes (existing TMS budget). */
export const PROJECT_NOTES_CHAR_BUDGET = 4_000

const FOREIGN_CANDIDATES: Array<{ relPath: string; kind: InstructionSourceKind }> = [
  { relPath: 'AGENTS.md', kind: 'agents' },
  { relPath: 'Agents.md', kind: 'agents' },
  { relPath: 'CLAUDE.md', kind: 'claude' },
  { relPath: '.claude/CLAUDE.md', kind: 'claude_dot' },
]

function joinProjectPath(projectPath: string, relPath: string): string {
  const root = projectPath.replace(/[\\/]+$/, '')
  return `${root}/${relPath}`
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/')
}

async function tryReadSource(
  projectPath: string,
  relPath: string,
  kind: InstructionSourceKind,
): Promise<InstructionSource | null> {
  const path = joinProjectPath(projectPath, relPath)
  const content = await safeReadFile(path)
  if (!content || !content.trim()) return null
  return {
    kind,
    path,
    relPath: normalizeRel(relPath),
    content,
  }
}

/**
 * Extract markdown heading lines (H1–H3) for stub indexes. Caps count so a
 * pathological file cannot bloat the system prompt.
 */
export function extractInstructionHeadings(content: string, max = 24): string[] {
  return content
    .split('\n')
    .filter(line => /^#{1,3}\s+/.test(line.trim()))
    .map(line => line.trim())
    .slice(0, max)
}

/**
 * Truncate with a named notice (never silent). Used for docs_full / parallel.
 */
export function truncateNamed(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) return content
  return (
    `${content.slice(0, maxChars).trimEnd()}\n\n` +
    `…[truncated ${label}: ${content.length} chars → ${maxChars}. Use Read for the full file.]`
  )
}

/**
 * Human label for a foreign source kind (prompt copy).
 */
export function foreignSourceLabel(kind: InstructionSourceKind): string {
  switch (kind) {
    case 'agents':
      return 'AGENTS.md'
    case 'claude':
      return 'CLAUDE.md'
    case 'claude_dot':
      return '.claude/CLAUDE.md'
    case 'tms':
      return 'TMS.md'
  }
}

/**
 * Load TMS + foreign project instructions from the project root.
 * Parallel best-effort reads; missing files yield null (never throws).
 */
export async function loadProjectInstructions(
  projectPath: string,
): Promise<ProjectInstructionsBundle> {
  if (!projectPath) {
    return { tms: null, foreignPrimary: null, hasAny: false }
  }

  const [tms, ...foreignResults] = await Promise.all([
    tryReadSource(projectPath, 'TMS.md', 'tms'),
    ...FOREIGN_CANDIDATES.map(c => tryReadSource(projectPath, c.relPath, c.kind)),
  ])

  // First non-null foreign wins. On case-insensitive FS, AGENTS.md and
  // Agents.md may resolve to the same file — content equality / path
  // normalization: prefer the first successful candidate order.
  let foreignPrimary: ForeignInstructionSource | null = null
  const seenNormalized = new Set<string>()
  for (const src of foreignResults) {
    if (!src || src.kind === 'tms') continue
    const key = src.path.replace(/\\/g, '/').toLowerCase()
    if (seenNormalized.has(key)) continue
    seenNormalized.add(key)
    if (!foreignPrimary) foreignPrimary = src as ForeignInstructionSource
  }

  return {
    tms,
    foreignPrimary,
    hasAny: !!(tms || foreignPrimary),
  }
}

export interface DocsFullInstructionsOptions {
  /**
   * Skip TMS.md body — already in the static system prompt. Default true for
   * request_context project.docs_full so we don't double-pay tokens.
   */
  omitTmsAlreadyInSystem?: boolean
  /**
   * Skip sole-foreign body when it is already the static inject (no TMS).
   * When TMS + foreign dual-case, foreign is NOT in static default path, so
   * it is still included. Default true.
   */
  omitForeignAlreadyInSystem?: boolean
}

/**
 * Build the instruction-files portion of project.docs_full.
 *
 * Default omits content already injected in the static system prompt (TMS full,
 * or sole AGENTS/CLAUDE). Dual-case still appends foreign as additional.
 */
export function buildInstructionsDocsFullPart(
  tms: InstructionSource | null,
  foreign: InstructionSource | null,
  opts: DocsFullInstructionsOptions = {},
): string | null {
  const omitTms = opts.omitTmsAlreadyInSystem !== false
  const omitForeignSole = opts.omitForeignAlreadyInSystem !== false
  const parts: string[] = []

  if (tms && !omitTms) {
    parts.push(`# TMS.md\n${tms.content}`)
  }

  if (foreign) {
    const label = foreignSourceLabel(foreign.kind)
    const body = truncateNamed(foreign.content, FOREIGN_DOCS_FULL_MAX_CHARS, label)
    if (tms) {
      // Dual-case: TMS is static; foreign is not — keep foreign here.
      parts.push(
        `# Additional project instructions (${foreign.relPath} — not canonical TM Code memory)\n${body}`,
      )
    } else if (!omitForeignSole) {
      parts.push(`# ${foreign.relPath}\n${body}`)
    }
  }

  return parts.length ? parts.join('\n\n') : null
}

/**
 * Content for permission classifier <project_notes>: TMS preferred, else foreign.
 */
export function buildProjectNotesFromBundle(
  bundle: ProjectInstructionsBundle,
  budget = PROJECT_NOTES_CHAR_BUDGET,
): string {
  const src = bundle.tms ?? bundle.foreignPrimary
  if (!src) return ''
  const label = src.kind === 'tms' ? 'TMS.md' : src.relPath
  const body = src.content.slice(0, budget)
  return (
    `The following are the developer's project notes (${label}). ` +
    `Treat them as part of the developer's intent when evaluating actions.\n` +
    `<project_notes>\n${body}\n</project_notes>\n\n`
  )
}

/**
 * Inline body for parallel-task fallback prompt (TMS || foreign, capped).
 */
export function buildParallelTaskInstructionsBody(
  bundle: ProjectInstructionsBundle,
  maxChars = FOREIGN_PARALLEL_TASK_MAX_CHARS,
): { heading: string; body: string } | null {
  const src = bundle.tms ?? bundle.foreignPrimary
  if (!src) return null
  const truncated = truncateNamed(src.content, maxChars, src.relPath)
  if (src.kind === 'tms') {
    return {
      heading: 'Project memory (TMS.md — conventions, commands, structure; follow it)',
      body: truncated,
    }
  }
  return {
    heading: `Project instructions (${src.relPath} — not TMS.md; follow them)`,
    body: truncated,
  }
}
