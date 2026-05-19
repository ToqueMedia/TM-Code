/**
 * Persistent agent memory — loads & writes memory files for the system prompt.
 *
 * Ported from claude-vaz's `memdir/`. Two scopes coexist:
 *
 *   - **User memory** (`~/.toquemedia-studio/memory/`) — cross-project facts:
 *     who the developer is, validated approaches, IDE-wide preferences.
 *     Survives project switches. Holds `user_*.md` and `feedback_*.md`
 *     entries (and the global `MEMORY.md` index).
 *
 *   - **Project memory** (`<project>/.toquemedia/memory/`) — project-bound
 *     facts: initiatives in flight, where to find X in this repo, project-
 *     specific conventions. Committable so the memory travels with the
 *     project to another machine / contributor. Holds `project_*.md` and
 *     `reference_*.md` entries.
 *
 * Closed taxonomy (mirrors claude-vaz's auto-memory contract):
 *   - `user`      — developer profile (role, expertise, working style)
 *   - `feedback`  — explicit corrections OR validated approaches (with Why + How)
 *   - `project`   — ongoing work / facts about the current project
 *   - `reference` — where to look for X in external systems (Linear, Slack, etc.)
 *
 * Each memory file has YAML frontmatter:
 *
 *     ---
 *     name: feedback-no-outlines
 *     description: User dislikes outline/focus rings on UI components
 *     metadata:
 *       type: feedback
 *     ---
 *
 *     Body — the rule itself, plus **Why:** and **How to apply:** lines
 *     for `feedback`/`project` types.
 *
 * `MEMORY.md` is the index — one-line entry per memory file. Loaded in full
 * on every prompt build (capped at 200 lines / 25KB); individual memory
 * files are loaded on-demand via `read_memory_file` when the agent needs
 * the full body.
 */

import { invoke } from '@tauri-apps/api/core'

export type MemoryScope = 'user' | 'project'
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const MEMORY_INDEX_FILENAME = 'MEMORY.md'
/** Index byte cap — claude-vaz parity. Beyond this the warning footer is
 *  appended so the model knows to consult individual files via read_memory. */
export const MAX_ENTRYPOINT_BYTES = 25_000
export const MAX_ENTRYPOINT_LINES = 200

export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
}

export interface MemoryFile {
  scope: MemoryScope
  filename: string
  frontmatter: MemoryFrontmatter | null
  body: string
}

export interface MemoryIndexResult {
  /** Raw content of MEMORY.md (after truncation), or null when missing. */
  content: string | null
  /** Number of lines actually included (post-truncation). */
  lineCount: number
  /** Bytes of `content` after truncation. */
  byteCount: number
  /** True iff the original file exceeded MAX_ENTRYPOINT_LINES. */
  wasLineTruncated: boolean
  /** True iff the original file exceeded MAX_ENTRYPOINT_BYTES. */
  wasByteTruncated: boolean
}

/**
 * Parsed view of a single MEMORY.md index entry — the markdown line
 * `- [name](file.md) — description` decomposed into structured fields
 * the relevance selector can reason about.
 *
 * The `type` is inferred from the filename prefix (`user_*` → `user`,
 * `feedback_*` → `feedback`, etc.) because the index file itself doesn't
 * carry the type explicitly. Filenames not matching the convention get
 * the catch-all type `project` (the most common default) and a warning
 * is logged once at parse time.
 */
export interface MemoryIndexEntry {
  name: string
  type: MemoryType
  description: string
  /** Original line in MEMORY.md, preserved verbatim for re-emission when
   *  the selector picks this entry. */
  rawLine: string
}

const INDEX_LINE_REGEX = /^-\s+\[([^\]]+)\]\(([^)]+\.md)\)\s+—\s+(.+)$/

function inferTypeFromFilename(filename: string): MemoryType {
  if (filename.startsWith('user_')) return 'user'
  if (filename.startsWith('feedback_')) return 'feedback'
  if (filename.startsWith('reference_')) return 'reference'
  return 'project'
}

/**
 * Parse the bullet lines of MEMORY.md into a structured entry array.
 * Tolerates leading header lines (`#`, blanks) and any truncation
 * warning footer appended by `loadMemoryIndex`. Lines that don't match
 * the canonical `- [name](file.md) — description` shape are silently
 * skipped — they're either headers or future format extensions, neither
 * is the selector's job to validate.
 */
export function parseIndexEntries(indexContent: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = []
  for (const line of indexContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>')) continue
    const m = trimmed.match(INDEX_LINE_REGEX)
    if (!m) continue
    const [, name, filename, description] = m
    entries.push({
      name,
      type: inferTypeFromFilename(filename),
      description: description.trim(),
      rawLine: line,
    })
  }
  return entries
}

/**
 * Reconstruct an index slice containing only the entries whose names are
 * in `keepNames`. Preserves the header (everything before the first
 * bullet line) and the truncation warning (if present) so the section
 * still reads as a valid MEMORY.md to the model.
 */
export function projectIndexEntries(
  indexContent: string,
  keepNames: Set<string>,
): string {
  const lines = indexContent.split('\n')
  const out: string[] = []
  let pastHeader = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('>')) {
      // Truncation warning — always keep at the end.
      out.push(line)
      continue
    }
    const m = trimmed.match(INDEX_LINE_REGEX)
    if (m) {
      pastHeader = true
      if (keepNames.has(m[1])) {
        out.push(line)
      }
      continue
    }
    // Headers + blank lines: keep until the first bullet line is seen,
    // skip after (avoids re-emitting trailing blanks between dropped entries).
    if (!pastHeader) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * Read a scope's index file. Returns the post-truncation content + stats.
 * When the file doesn't exist, returns `content: null` — caller skips the
 * section rather than emitting an empty block in the prompt.
 */
export async function loadMemoryIndex(
  scope: MemoryScope,
  projectPath?: string,
): Promise<MemoryIndexResult> {
  try {
    const raw = await invoke<string | null>('read_memory_file', {
      scope,
      projectPath: scope === 'project' ? projectPath : null,
      filename: MEMORY_INDEX_FILENAME,
    })
    if (!raw) {
      return {
        content: null,
        lineCount: 0,
        byteCount: 0,
        wasLineTruncated: false,
        wasByteTruncated: false,
      }
    }
    return truncateIndex(raw)
  } catch (err) {
    console.warn('[memdir] failed to load index:', err)
    return {
      content: null,
      lineCount: 0,
      byteCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
    }
  }
}

/**
 * Apply the line + byte caps with a named warning footer (claude-vaz's
 * named-truncation pattern — the model learns the cap empirically). Lines
 * are bounded first because a 1KB file with 500 short lines is still over
 * cap by line count even if it fits byte-wise.
 */
function truncateIndex(raw: string): MemoryIndexResult {
  const lines = raw.split('\n')
  let wasLineTruncated = false
  let wasByteTruncated = false
  let working = lines

  if (lines.length > MAX_ENTRYPOINT_LINES) {
    wasLineTruncated = true
    working = lines.slice(0, MAX_ENTRYPOINT_LINES)
  }

  let joined = working.join('\n')
  if (joined.length > MAX_ENTRYPOINT_BYTES) {
    wasByteTruncated = true
    joined = joined.slice(0, MAX_ENTRYPOINT_BYTES)
  }

  if (wasLineTruncated || wasByteTruncated) {
    const reason = [
      wasLineTruncated && `MAX_ENTRYPOINT_LINES (${MAX_ENTRYPOINT_LINES}) exceeded`,
      wasByteTruncated && `MAX_ENTRYPOINT_BYTES (${MAX_ENTRYPOINT_BYTES.toLocaleString()}) exceeded`,
    ].filter(Boolean).join(' AND ')
    joined +=
      `\n\n> ⚠️ MEMORY.md ${reason}. Only part of it was loaded. ` +
      `Keep index entries to one line under ~150 chars; move detail into topic files.`
  }

  return {
    content: joined,
    lineCount: working.length,
    byteCount: joined.length,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/**
 * Read a single memory file by filename. Used by the `read_memory` tool
 * when the agent wants the full body of an entry it saw in the index.
 */
export async function loadMemoryFile(
  scope: MemoryScope,
  filename: string,
  projectPath?: string,
): Promise<MemoryFile | null> {
  try {
    const raw = await invoke<string | null>('read_memory_file', {
      scope,
      projectPath: scope === 'project' ? projectPath : null,
      filename,
    })
    if (!raw) return null
    const { frontmatter, body } = parseFrontmatter(raw)
    return { scope, filename, frontmatter, body }
  } catch (err) {
    console.warn(`[memdir] failed to load ${filename}:`, err)
    return null
  }
}

/**
 * Write a memory file's content (frontmatter + body assembled by caller).
 * Used by the `save_memory` tool. The Rust layer enforces filename safety;
 * this layer composes the on-disk shape.
 */
export async function writeMemoryFile(
  scope: MemoryScope,
  filename: string,
  content: string,
  projectPath?: string,
): Promise<void> {
  await invoke('write_memory_file', {
    scope,
    projectPath: scope === 'project' ? projectPath : null,
    filename,
    content,
  })
}

/** Delete a memory file. Idempotent. */
export async function deleteMemoryFile(
  scope: MemoryScope,
  filename: string,
  projectPath?: string,
): Promise<void> {
  await invoke('delete_memory_file', {
    scope,
    projectPath: scope === 'project' ? projectPath : null,
    filename,
  })
}

/**
 * Minimal YAML frontmatter parser — handles the closed subset our memory
 * files use: `name:`, `description:`, `metadata: { type: ... }`. Returns
 * `null` frontmatter when the file has no `---` delimiter (legacy plain
 * markdown files still load with body = full content).
 */
export function parseFrontmatter(raw: string): { frontmatter: MemoryFrontmatter | null; body: string } {
  if (!raw.startsWith('---')) {
    return { frontmatter: null, body: raw }
  }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) {
    return { frontmatter: null, body: raw }
  }
  const yaml = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, '')

  // Hand-rolled tiny parser — fine for the closed schema. Order-tolerant.
  let name = ''
  let description = ''
  let type: MemoryType | '' = ''
  let inMetadata = false
  for (const line of yaml.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    if (/^metadata:\s*$/.test(trimmed)) {
      inMetadata = true
      continue
    }
    if (inMetadata) {
      const m = trimmed.match(/^\s+type:\s*(\S+)/)
      if (m && (MEMORY_TYPES as readonly string[]).includes(m[1])) {
        type = m[1] as MemoryType
        continue
      }
      // De-indent means we left the metadata block.
      if (!trimmed.startsWith(' ') && !trimmed.startsWith('\t')) {
        inMetadata = false
      }
    }
    const nameMatch = trimmed.match(/^name:\s*(.+)$/)
    if (nameMatch) {
      name = nameMatch[1].trim()
      continue
    }
    const descMatch = trimmed.match(/^description:\s*(.+)$/)
    if (descMatch) {
      description = descMatch[1].trim()
      continue
    }
  }

  if (!name || !description || !type) {
    return { frontmatter: null, body: raw }
  }
  return { frontmatter: { name, description, type }, body }
}

/**
 * Compose a memory file's on-disk content from a frontmatter + body pair.
 * Used by the `save_memory` tool path to guarantee a canonical shape on
 * disk regardless of how the model formatted its input.
 */
export function buildMemoryFileContent(frontmatter: MemoryFrontmatter, body: string): string {
  return [
    '---',
    `name: ${frontmatter.name}`,
    `description: ${frontmatter.description}`,
    'metadata:',
    `  type: ${frontmatter.type}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
}

/**
 * Translate a memory `name` (kebab-case slug) into the on-disk filename
 * convention: `<type>_<name>.md`. Matches the claude-vaz pattern, so a
 * memory file's prefix tells you its category at a glance.
 */
export function memoryFilenameFor(type: MemoryType, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${type}_${slug}.md`
}

/**
 * Which scope owns each memory type by default? Per claude-vaz convention:
 *   - `user` and `feedback` → user scope (cross-project)
 *   - `project` → project scope
 *   - `reference` → project scope (where to look for X in THIS project's stack)
 *
 * Callers can override (e.g. `feedback` about a specific project) but
 * this default keeps the directory tree predictable.
 */
export function defaultScopeForType(type: MemoryType): MemoryScope {
  if (type === 'user' || type === 'feedback') return 'user'
  return 'project'
}
