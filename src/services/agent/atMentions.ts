/**
 * @-mention resolution — full port of claude-vaz's at-mention pipeline.
 *
 * What changed vs the old `<mentioned_files>` XML approach (attachmentService
 * `extractAndResolveMentions`, removed 2026-06): mentioned files used to be
 * inlined as XML inside the user's own prompt text, which (a) gave the
 * mentioned file the weight of a user instruction — anchoring the model on
 * the wrong file when the user mentioned one file but described a problem in
 * another, (b) bypassed the read-state bookkeeping (no dedup, no
 * read-before-write credit, no external-change detection), and (c) evaporated
 * from the conversation history after the turn (rebuildConversationHistory
 * only kept the display text).
 *
 * The claude-vaz mechanism (utils/attachments.ts `processAtMentionedFiles` →
 * `generateFileAttachment`; rendering in utils/messages.ts
 * `normalizeAttachmentForAPI` + `createToolUseMessage` /
 * `createToolResultMessage`):
 *
 *   1. Mentions are extracted with support for quoted paths (`@"my file.ts"`)
 *      and line ranges (`@file.ts#L10-20`); `#heading` fragments are stripped.
 *   2. Each mentioned file is read through the REAL read tool, so state
 *      effects (readFileState, readFileTimestamps, dedup) are identical to a
 *      model-initiated read_file call.
 *   3. The result is rendered as a synthetic tool-call transcript — two
 *      `<system-reminder>` blocks appended AFTER the user's prompt:
 *        "Called the read_file tool with the following input: {...}"
 *        "Result of calling the read_file tool:\n<content>"
 *      The model perceives a neutral "I already read this file" fact instead
 *      of a user instruction — soft anchoring, no "START there" bias.
 *   4. Files the model already has a fresh full view of render to NOTHING
 *      (claude-vaz `already_read_file` → []).
 *   5. Oversized files fall back to the first MAX_LINES_TO_READ lines plus a
 *      meta note telling the model it can read more — never the 256 KB error.
 *   6. Denied/missing/binary targets are dropped silently (claude-vaz returns
 *      null from generateFileAttachment for all of these).
 *   7. Directories render as a synthetic list_directory call (claude-vaz uses
 *      a synthetic Bash `ls`; list_directory is TM Code's equivalent tool).
 *
 * The external-modification sweep (`collectChangedFileContext`) is the
 * companion piece — claude-vaz's `getChangedFiles` — injected at turn start
 * (call sites) and between tool rounds (query.ts `collectInterTurnContext`).
 */

import ToolExecutor from './toolExecutor'
import { FILE_UNCHANGED_STUB } from './toolExecutor/readDedup'
import { resolveImageToDataUri } from '../attachmentService'
import type { OpenAIContentPart } from './types'

/** Truncated-read fallback for oversized files — claude-vaz MAX_LINES_TO_READ. */
export const MAX_LINES_TO_READ = 2000
/** Above this, @mention emits a compact file card instead of full contents. */
export const MAX_INLINE_MENTION_CHARS = 16_000
const MENTION_PREVIEW_CHARS = 4_000
const MAX_OUTLINE_ITEMS = 80

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
// Never readable as UTF-8 text — mentions of these drop silently, matching
// claude-vaz where FileReadTool.validateInput fails → attachment is null.
const BINARY_EXTENSIONS = new Set([
  'pdf', 'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
  'mp3', 'wav', 'flac', 'ogg', 'm4a',
  'mp4', 'mov', 'webm', 'mkv', 'avi',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'exe', 'dll', 'so', 'dylib', 'bin',
])

export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}

// ── Extraction (verbatim ports of claude-vaz utils/attachments.ts) ───────

/**
 * Extract filenames mentioned with @, including line-range syntax
 * (`@file.txt#L10-20`) and quoted paths for files with spaces
 * (`@"my/file with spaces.txt"`). Agent mentions (`@"name (agent)"`)
 * are skipped. Port of claude-vaz `extractAtMentionedFiles`.
 */
export function extractAtMentionedFiles(content: string): string[] {
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g

  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  let match: RegExpExecArray | null
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2])
    }
  }

  const regularMatchArray = content.match(regularAtMentionRegex) || []
  regularMatchArray.forEach(m => {
    const filename = m.slice(m.indexOf('@') + 1)
    // Don't include if it starts with a quote (already handled as quoted)
    if (!filename.startsWith('"')) {
      regularMatches.push(filename)
    }
  })

  return Array.from(new Set([...quotedMatches, ...regularMatches]))
}

export interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

/**
 * Parse mentions like "file.txt#L10-20", "file.txt#heading", or "file.txt".
 * Line ranges become offset/limit; non-line-range fragments are stripped.
 * Port of claude-vaz `parseAtMentionedFileLines`.
 */
export function parseAtMentionedFileLines(mention: string): AtMentionedFileLines {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)

  if (!match) {
    return { filename: mention }
  }

  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart

  return { filename: filename ?? mention, lineStart, lineEnd }
}

// ── Resolution ────────────────────────────────────────────────────────────

export interface MentionImagePart {
  /** "Called the read_file tool..." reminder rendered next to the image. */
  reminder: string
  dataUri: string
  displayPath: string
}

export interface MentionResolution {
  /** Rendered system-reminder blocks, newline-joined. '' when nothing resolved. */
  contextText: string
  /** Image mentions — appended as image_url parts on multimodal plans. */
  imageParts: MentionImagePart[]
  /**
   * Absolute paths of files whose CONTENT was frozen into contextText (the
   * read_file snapshots). rebuildConversationHistory uses these to detect when
   * a later tool call superseded the snapshot, so the stale body is replaced
   * with a pointer instead of contradicting the fresh tool result (context
   * pollution audit, 2026-06-12). Directory listings / images are excluded —
   * only file-content snapshots carry the contradiction risk.
   */
  resolvedPaths: string[]
}

const EMPTY_RESOLUTION: MentionResolution = { contextText: '', imageParts: [], resolvedPaths: [] }

type ResolvedBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; part: MentionImagePart }

/** The synthetic tool-call pair — claude-vaz `createToolUseMessage` +
 *  `createToolResultMessage` (utils/messages.ts:4308-4333), both wrapped in
 *  system-reminder by `wrapMessagesInSystemReminder`. The result uses the
 *  raw string (not JSON-escaped) — claude-vaz keeps newlines literal to
 *  avoid wasting ~1 token per line on `\n` escapes. */
function renderToolPair(toolName: string, input: Record<string, unknown>, result: string): ResolvedBlock[] {
  return [
    { kind: 'text', text: wrapInSystemReminder(`Called the ${toolName} tool with the following input: ${JSON.stringify(input)}`) },
    { kind: 'text', text: wrapInSystemReminder(`Result of calling the ${toolName} tool:\n${result}`) },
  ]
}

function getExtension(p: string): string {
  const name = p.replace(/\\/g, '/').split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function languageForExtension(ext: string): string {
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript React',
    js: 'JavaScript',
    jsx: 'JavaScript React',
    css: 'CSS',
    scss: 'SCSS',
    html: 'HTML',
    json: 'JSON',
    md: 'Markdown',
    py: 'Python',
    go: 'Go',
    rs: 'Rust',
    java: 'Java',
    kt: 'Kotlin',
    swift: 'Swift',
    php: 'PHP',
    rb: 'Ruby',
    cs: 'C#',
  }
  return map[ext] || (ext ? ext.toUpperCase() : 'text')
}

function previewHead(content: string): { text: string; lineCount: number; totalLines: number } {
  const totalLines = content.split('\n').length
  if (content.length <= MENTION_PREVIEW_CHARS) return { text: content, lineCount: totalLines, totalLines }
  const slice = content.slice(0, MENTION_PREVIEW_CHARS)
  const lastNewline = slice.lastIndexOf('\n')
  const text = lastNewline > 500 ? slice.slice(0, lastNewline) : slice
  return { text, lineCount: text.split('\n').length, totalLines }
}

function extractOutline(content: string, ext: string): string[] {
  const lines = content.split('\n')
  const out: string[] = []
  const codeLike = /^(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(ext)
  const patterns = codeLike
    ? [
        /\bexport\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/,
        /\bexport\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
        /\bfunction\s+([A-Za-z0-9_$]+)\s*\(/,
        /\b(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*[:=]/,
        /\b(?:export\s+)?(?:interface|type|class|enum)\s+([A-Za-z0-9_$]+)/,
        /\b(?:const|let|var)\s+([a-z][A-Za-z0-9_$]*(?:Handler|Hook|Store|Context|Provider))\s*[:=]/,
      ]
    : [
        /^#{1,6}\s+(.+)/,
        /\b(?:class|def)\s+([A-Za-z0-9_]+)/,
      ]

  for (let i = 0; i < lines.length && out.length < MAX_OUTLINE_ITEMS; i++) {
    const line = lines[i]
    for (const re of patterns) {
      const m = line.match(re)
      if (m?.[1]) {
        out.push(`L${i + 1}: ${m[1]} — ${line.trim().slice(0, 140)}`)
        break
      }
    }
  }
  return out
}

function renderLargeMentionSummary(absolutePath: string, content: string, ext: string): string {
  const preview = previewHead(content)
  const outline = extractOutline(content, ext)
  const outlineText = outline.length
    ? outline.map(item => `- ${item}`).join('\n')
    : '- No top-level symbols detected by the lightweight outline extractor.'
  const previewEndLine = preview.lineCount
  const hasMore = content.length > preview.text.length
  return [
    `@mention compact_reference (intentional summary — full file body was NOT inlined to save context tokens):`,
    `path: ${absolutePath}`,
    `language: ${languageForExtension(ext)}`,
    `size: ${content.length.toLocaleString()} chars, ${preview.totalLines.toLocaleString()} lines`,
    `kind: compact_reference — this is an on-demand outline, NOT a truncated_tool_result (a truncated_tool_result is a Read body cut by the byte cap; this is a deliberate summary).`,
    `edit guard: this compact_reference does NOT count as a full Read; call Read for the exact range before edit_file/write_file.`,
    `read guidance: the outline + preview below cover lines 1-${previewEndLine}. Use Read ONLY for the specific range you still need (offset/limit). Do NOT re-read ranges already covered by this preview or by a previous Read.`,
    ``,
    `outline:`,
    outlineText,
    ``,
    `preview (first ${preview.lineCount} lines / ${Math.min(content.length, preview.text.length).toLocaleString()} chars):`,
    preview.text,
    hasMore
      ? `\n[preview covers lines 1-${previewEndLine} of ${preview.totalLines}; call Read with offset:${previewEndLine + 1} to continue from here if needed]`
      : '',
  ].join('\n')
}

/** Blocks for one mention, plus the path whose file CONTENT they froze (if any). */
interface OneMention {
  blocks: ResolvedBlock[]
  /** Set only when a read_file body was rendered — the snapshot that can go stale. */
  contentPath?: string
}

const NO_MENTION: OneMention = { blocks: [] }

async function resolveOneMention(
  token: string,
  executor: ToolExecutor,
  pathMap?: Record<string, string>,
): Promise<OneMention> {
  try {
    const { filename, lineStart, lineEnd } = parseAtMentionedFileLines(token)
    // TM Code's autocomplete inserts a trailing '/' on directory mentions;
    // strip it (claude-vaz's regex already drops it via the \b boundary).
    const cleaned = filename.replace(/[\\/]+$/, '')
    if (!cleaned) return NO_MENTION

    // Name-only chips (2026-08): the composer inserts `@foo.ts` and keeps the
    // project-relative path in a side map — resolve through it when present.
    // Manual full-path mentions and legacy bubbles have no map entry and keep
    // resolving relative to the project root, exactly as before.
    const mapped = pathMap?.[cleaned]
    const absolutePath = executor.resolveMentionPath(mapped ?? cleaned)
    // Out-of-scope → silent drop, same outcome as claude-vaz's deny rules.
    if (!executor.isMentionPathAllowed(absolutePath)) return NO_MENTION

    const ext = getExtension(absolutePath)
    if (IMAGE_EXTENSIONS.has(ext)) {
      // claude-vaz inlines mentioned images as a Read tool result with an
      // image block. OpenAI-compatible tool results are text-only, so the
      // image ships as an image_url part in the user message instead; the
      // reminder line keeps the synthetic-tool-call framing.
      const dataUri = await resolveImageToDataUri({
        id: '', type: 'image', name: absolutePath.split('/').pop() || absolutePath, path: absolutePath,
      })
      if (!dataUri) return NO_MENTION
      return { blocks: [{
        kind: 'image',
        part: {
          reminder: wrapInSystemReminder(`Called the read_file tool with the following input: ${JSON.stringify({ file_path: absolutePath })}`),
          dataUri,
          displayPath: absolutePath,
        },
      }] }
    }
    if (BINARY_EXTENSIONS.has(ext)) return NO_MENTION

    // Trailing slash is authoritative in TM Code's autocomplete; otherwise
    // stat decides (claude-vaz does the same stat probe).
    let isDirectory = /[\\/]$/.test(filename)
    if (!isDirectory) {
      try {
        const { stat } = await import('@tauri-apps/plugin-fs')
        isDirectory = !!(await stat(absolutePath)).isDirectory
      } catch {
        // stat failure → fall through to the file path; a read failure
        // below drops the mention (claude-vaz fallthrough comment).
      }
    }

    if (isDirectory) {
      // claude-vaz renders directories as a synthetic Bash `ls` (direct
      // children only); list_directory with maxDepth 1 is TM Code's
      // equivalent. The rendered input MUST match the actual call so the
      // synthetic transcript is self-consistent.
      const input = { file_path: absolutePath, maxDepth: 1 }
      const listing = await executor.executeForMention('list_directory', input)
      // Directory listing — not a file-content snapshot, so no contentPath.
      return { blocks: renderToolPair('list_directory', input, listing) }
    }

    // Fresh full view already in context → render nothing
    // (claude-vaz `already_read_file` normalizes to []).
    if (lineStart === undefined && await executor.isFileFreshInContext(absolutePath)) return NO_MENTION

    const input: Record<string, unknown> = { file_path: absolutePath }
    if (lineStart !== undefined) {
      input.offset = lineStart
      if (lineEnd !== undefined) input.limit = lineEnd - lineStart + 1
    }

    const result = await executor.executeForMention('read_file', input)
    if (result === FILE_UNCHANGED_STUB) return NO_MENTION
    if (result.startsWith('File not found:')) return NO_MENTION
    if (result.startsWith('Blocked:')) return NO_MENTION

    if (/^Error: File is .+ exceeds the 256 KB read cap/.test(result)) {
      // Oversize → truncated read of the first MAX_LINES_TO_READ lines plus
      // a meta note — claude-vaz `readTruncatedFile` + the "too large" note
      // appended by normalizeAttachmentForAPI for truncated attachments.
      const truncatedInput = { file_path: absolutePath, offset: 1, limit: MAX_LINES_TO_READ }
      const truncated = await executor.executeForMention('read_file', truncatedInput)
      if (truncated.startsWith('Error:') || truncated.startsWith('File not found:')) return NO_MENTION
      return {
        blocks: [
          ...renderToolPair('read_file', truncatedInput, truncated),
          { kind: 'text', text: wrapInSystemReminder(`Note: The file ${absolutePath} was too large and has been truncated to the first ${MAX_LINES_TO_READ} lines. Don't tell the user about this truncation. Use Read to read more of the file if you need.`) },
        ],
        contentPath: absolutePath,
      }
    }
    if (result.startsWith('Error:')) return NO_MENTION

    if (result.length > MAX_INLINE_MENTION_CHARS) {
      const partialMarker = executor as unknown as { markMentionPathAsPartialView?: (path: string) => void }
      partialMarker.markMentionPathAsPartialView?.(absolutePath)
      const summary = renderLargeMentionSummary(absolutePath, result, ext)
      return { blocks: renderToolPair('read_file', input, summary), contentPath: absolutePath }
    }

    return { blocks: renderToolPair('read_file', input, result), contentPath: absolutePath }
  } catch {
    // Any failure (path scope, .env block, IPC error) drops the mention
    // silently — claude-vaz logs the error event and returns null.
    return NO_MENTION
  }
}

/**
 * Resolve every @-mention in `input` into synthetic tool-call context.
 *
 * Slash-command inputs are skipped — their expansion pipeline owns mention
 * extraction (claude-vaz gates the same way in processUserInput.ts:496-499).
 *
 * State effects are real: each resolved file lands in readFileState /
 * readFileTimestamps exactly as if the model had called read_file, so dedup,
 * read-before-write credit and the external-change sweep all see it.
 */
export async function resolveMentionContext(
  input: string,
  executorOverride?: ToolExecutor,
  /** Display-name → project-relative path for name-only chips (see chatStore.mentionPaths). */
  pathMap?: Record<string, string>,
): Promise<MentionResolution> {
  if (!input || input.trim().startsWith('/')) return EMPTY_RESOLUTION
  const mentions = extractAtMentionedFiles(input)
  if (mentions.length === 0) return EMPTY_RESOLUTION

  // MDI (auditoria 2026-07-28): uma TAREFA ligada a um projeto não-focado
  // resolvia @ficheiros contra o SINGLETON — scope e read-state do projeto
  // errado, e o crédito de leitura (dedup, read-before-write) ficava no
  // executor do main enquanto quem executava era o filho isolado da tarefa.
  // O runner passa agora o SEU executor; o singleton fica como default do
  // caminho interativo.
  const executor = executorOverride ?? ToolExecutor.getInstance()
  // Parallel resolution (claude-vaz uses Promise.all); flatten preserves
  // mention order so the transcript reads in the order the user wrote.
  const resolved = await Promise.all(mentions.map(m => resolveOneMention(m, executor, pathMap)))

  const textBlocks: string[] = []
  const imageParts: MentionImagePart[] = []
  const resolvedPaths: string[] = []
  for (const { blocks, contentPath } of resolved) {
    for (const block of blocks) {
      if (block.kind === 'text') textBlocks.push(block.text)
      else imageParts.push(block.part)
    }
    if (contentPath) resolvedPaths.push(contentPath)
  }
  return { contextText: textBlocks.join('\n'), imageParts, resolvedPaths }
}

// ── External-modification sweep ───────────────────────────────────────────

/**
 * Render the "Note: X was modified..." reminders for files the model has in
 * context that changed on disk outside the agent's tools. Wording is the
 * claude-vaz `edited_text_file` message verbatim (utils/messages.ts:3541).
 * Returns '' when nothing changed. Never throws — a sweep failure must not
 * break a turn.
 */
export async function collectChangedFileContext(): Promise<string> {
  try {
    const changed = await ToolExecutor.getInstance().collectExternallyChangedFiles()
    if (changed.length === 0) return ''
    return changed
      .map(({ path, snippet }) => wrapInSystemReminder(
        `Note: ${path} was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. Here are the relevant changes (shown with line numbers):\n${snippet}`,
      ))
      .join('\n')
  } catch {
    return ''
  }
}

// ── Application at the prompt boundary ────────────────────────────────────

export interface AppliedMentionResolution {
  userContent: string | OpenAIContentPart[]
  /** Text suffix persisted on the user ChatMessage (`mentionContext`) so
   *  rebuildConversationHistory re-emits it on follow-up turns — claude-vaz
   *  keeps attachment messages in the transcript; without this the context
   *  would evaporate after the first turn. Image parts are NOT persisted
   *  (same lifetime as pasted images: in-session only). */
  persistedContext: string
  /** Paths of file-content snapshots inside persistedContext — persisted as
   *  `mentionedPaths` so rebuild can void a snapshot a later tool superseded. */
  resolvedPaths: string[]
}

/**
 * Append a MentionResolution (+ optional changed-file context) to the
 * outgoing user content, claude-vaz ordering: the user's own message first,
 * attachment context after (processTextPrompt returns
 * `[userMessage, ...attachmentMessages]`; at the API boundary they merge
 * into the same user turn).
 */
export function applyMentionResolution(
  userContent: string | OpenAIContentPart[],
  resolution: MentionResolution,
  changedFileContext: string,
  supportsMultimodal: boolean,
): AppliedMentionResolution {
  const textPieces: string[] = []
  if (resolution.contextText) textPieces.push(resolution.contextText)

  let content = userContent
  if (resolution.imageParts.length > 0) {
    if (supportsMultimodal) {
      const parts: OpenAIContentPart[] = typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : [...content]
      for (const img of resolution.imageParts) {
        parts.push({ type: 'text', text: img.reminder })
        parts.push({ type: 'image_url', image_url: { url: img.dataUri } })
      }
      content = parts
    } else {
      for (const img of resolution.imageParts) {
        textPieces.push(wrapInSystemReminder(`Image referenced at ${img.displayPath} — the active model is text-only, so the image could not be shown.`))
      }
    }
  }

  if (changedFileContext) textPieces.push(changedFileContext)

  const suffix = textPieces.join('\n')
  if (suffix) {
    if (typeof content === 'string') {
      content = `${content}\n${suffix}`
    } else {
      content = [...content, { type: 'text', text: suffix }]
    }
  }

  return { userContent: content, persistedContext: suffix, resolvedPaths: resolution.resolvedPaths }
}
