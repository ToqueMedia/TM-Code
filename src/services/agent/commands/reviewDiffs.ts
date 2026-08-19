import { createTwoFilesPatch } from 'diff'
import { relativeToProjectPath } from '../../../utils/platform'
import { GLOB_ALIAS, GREP_ALIAS, LS_ALIAS, READ_ALIAS } from '../toolNames'
import { languageDirective } from './_languageInstruction'

/**
 * How many session files we pre-resolve into the review prompt. Cap is
 * about prompt size (cli-vaz injects the diff; it does not paginate
 * turns). 20 covers a busy session without dumping the repo.
 */
export const SESSION_FILE_CAP = 20

/** Soft ceiling for the injected patch (~15k tokens). */
export const DIFF_CHAR_BUDGET = 60_000

/** One oversized file must not eat the whole budget. */
export const DIFF_PER_FILE_CHAR_CAP = 8_000

export interface SessionDiffEntry {
  filePath: string
  before: string | null
  after: string | null
}

export interface AssembledDiffs {
  files: string[]
  patch: string
  /** True when we dropped files to honour SESSION_FILE_CAP. */
  capped: boolean
  /** True when a patch was cut to the char budget. */
  truncated: boolean
  originalCount: number
}

export function formatFileDiff(filePath: string, before: string | null, after: string | null): string {
  const oldName = before === null ? '/dev/null' : filePath
  const newName = after === null ? '/dev/null' : filePath
  return createTwoFilesPatch(
    oldName,
    newName,
    before ?? '',
    after ?? '',
    undefined,
    undefined,
    { context: 3 },
  )
}

export function clipText(text: string, max: number, label: string): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `${text.slice(0, max)}\n... [truncated ${label}: ${text.length - max} more chars]\n`,
    truncated: true,
  }
}

/**
 * Most-recent files first (checkpoint insertion order ≈ touch order).
 * Skips deletes and no-op pairs. Relativizes paths to the project root.
 */
export function assembleInjectedDiffs(
  entries: SessionDiffEntry[],
  opts: { projectPath: string; fileCap?: number; charBudget?: number; perFileCap?: number },
): AssembledDiffs {
  const fileCap = opts.fileCap ?? SESSION_FILE_CAP
  const charBudget = opts.charBudget ?? DIFF_CHAR_BUDGET
  const perFileCap = opts.perFileCap ?? DIFF_PER_FILE_CHAR_CAP

  const usable = entries.filter(e => e.after !== null && e.before !== e.after)
  const originalCount = usable.length
  const selected = [...usable].reverse().slice(0, fileCap)
  const capped = originalCount > fileCap

  const parts: string[] = []
  const files: string[] = []
  let used = 0
  let truncated = false

  for (const entry of selected) {
    const rel = relativeToProjectPath(entry.filePath, opts.projectPath)
    const per = clipText(formatFileDiff(rel, entry.before, entry.after), perFileCap, rel)
    if (per.truncated) truncated = true
    const patch = per.text
    if (used + patch.length > charBudget) {
      const remaining = charBudget - used
      if (remaining < 200) {
        truncated = true
        break
      }
      parts.push(clipText(patch, remaining, rel).text)
      files.push(rel)
      truncated = true
      break
    }
    parts.push(patch)
    files.push(rel)
    used += patch.length
  }

  return {
    files,
    patch: parts.join('\n'),
    capped,
    truncated,
    originalCount,
  }
}

export interface ReviewPromptScope {
  scope: { type: string; filePath?: string; description?: string }
  files: string[]
  patch: string
  capped: boolean
  truncated: boolean
  originalCount: number
}

function attachedDiff(resolved: ReviewPromptScope): string {
  if (!resolved.patch.trim()) return ''
  const notes: string[] = []
  if (resolved.capped) {
    notes.push(`${resolved.originalCount} files touched this session; the most recent ${resolved.files.length} are in the diff.`)
  }
  if (resolved.truncated) {
    notes.push('The diff was truncated to fit the review budget. Follow a finding with Read/Grep if you need more context.')
  }
  const noteBlock = notes.length > 0 ? `\n\n${notes.join(' ')}` : ''
  return `\n\n## Diff\n\n\`\`\`diff\n${resolved.patch}\n\`\`\`${noteBlock}`
}

/**
 * User-message payload for /review — same shape as cli-vaz `type: 'prompt'`.
 * Context is injected; the model is not walked through a numbered ritual.
 */
export function buildReviewPrompt(resolved: ReviewPromptScope): string {
  const { scope, files } = resolved
  const fileList = files.map(f => `- ${f}`).join('\n')
  const diff = attachedDiff(resolved)

  switch (scope.type) {
    case 'file':
      return `Review \`${files[0]}\`. Read it and follow references with ${READ_ALIAS}/${GREP_ALIAS} as needed.`

    case 'last_commit':
      return `Review the last commit (HEAD~1..HEAD). The unified diff is already below — review the delta, do not re-read every file.\n\n${fileList}${diff}`

    case 'description':
      return `Review this area: "${scope.description}"\n\nFind the relevant files with ${GREP_ALIAS} / ${GLOB_ALIAS} / ${LS_ALIAS}. Stay in scope.`

    case 'session':
    default:
      return `Review the files modified in this session. The unified diff is already below — review the delta, do not re-read every file.\n\n${fileList}${diff}`
  }
}

export function buildReviewSystemPrompt(projectPath: string): string {
  return `You are an expert code reviewer with no prior chat history — only the code on disk and the request below. Isolation is intentional: do not defend decisions you did not make.

Find real defects, not cosmetic preferences. Surprising code that works as designed is not a bug. An unfamiliar pattern is not wrong until you check how the project actually uses it.

${languageDirective()}

Project: ${projectPath}

When a unified diff is attached, review that delta. Use ${READ_ALIAS} / ${GREP_ALIAS} / ${GLOB_ALIAS} only to verify a finding. TMS.md often documents deliberate choices.

Rank by impact: correctness and security first, then maintainability. Skip style and missing tests unless the user asked or the file under review is a test. If nothing is serious, say so — do not pad.

You are read-only. Recommendations are directional, not implementations. Keep the review concise but thorough, with file:line on each finding.`
}
