import { stripInlineReasoning } from '../../services/agent/completionText'

export const TM_CODE_COMMIT_SIGNATURE = 'Co-Authored-By: TM Code <tm.code@toquemedia.net>'

// The signature is invisible to the user and appended at commit time.
export function ensureTmCodeCommitSignature(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return ''
  if (/^Co-Authored-By:\s*TM Code\s*</im.test(trimmed)) return trimmed
  return `${trimmed}\n\n${TM_CODE_COMMIT_SIGNATURE}`
}

/** Strip any TM Code trailer the AI may still emit, so it never reaches the textarea. */
export function stripTmCodeCommitSignature(message: string): string {
  return message.replace(/\n*^Co-Authored-By:\s*TM Code\s*<[^>]*>\s*$/gim, '').trim()
}

/**
 * Strip chain-of-thought from the AI message. The commit-message call is
 * non-streaming, so reasoning models can emit `<think>...</think>` inline.
 */
/**
 * @deprecated Use `stripInlineReasoning` (services/agent/completionText) — a
 * cópia local só tratava `<think>`, e o strip passou a ser central para que
 * TODAS as one-shots fiquem cobertas, não só a geração de commits.
 */
export const stripReasoningBlocks = stripInlineReasoning

export function cleanGeneratedCommitMessage(message: string): string {
  const cleaned = stripReasoningBlocks(message)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(commit message:?\s*)/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
  return stripTmCodeCommitSignature(cleaned)
}

// ── Commit-prompt assembly (budgeted) ────────────────────────────────────
//
// The generate-commit-message call is non-streaming against the utility
// sidecar model, so the prompt MUST be bounded. The old assembly only capped
// the detailed diff — the file list, name-status, numstat and stat sections
// went in whole, so a changeset with hundreds/thousands of files produced a
// prompt of hundreds of KB: the worker rejected it (context overflow) or the
// request ran into the 90s timeout, and the retry re-sent the same payload.
// Every section is now head-truncated with an explicit omission note, and the
// whole prompt is guarded by a total budget.

export const COMMIT_PROMPT_LIMITS = {
  /** Max entries in the "Files changed" list. */
  fileListLines: 120,
  /** Max lines for each git summary section (name-status / numstat / stat). */
  summaryLines: 200,
  /** Max chars for each git summary section. */
  summaryChars: 6_000,
  /** Default budget for the detailed diff hunks. */
  detailChars: 12_000,
  /** Reduced detail budget used on the retry attempt (covers 400s caused by
   *  prompt size — retrying with an identical payload cannot succeed). */
  detailCharsRetry: 5_000,
  /** Per-file cap inside the detailed diff (one giant file can't eat it all). */
  detailPerFileChars: 2_500,
  /** Hard ceiling for the assembled prompt. */
  totalChars: 30_000,
  /** Above this many changed files, the detailed diff is fetched only for the
   *  top files by churn instead of the whole tree. */
  detailFileThreshold: 60,
  /** How many top-churn files get detailed hunks in that mode. */
  detailTopFiles: 30,
} as const

/** Head-truncate to at most maxLines/maxChars, noting what was dropped. */
export function capLines(text: string, maxLines: number, maxChars: number): string {
  if (!text) return ''
  let out = text
  let dropped = 0
  const lines = out.split('\n')
  if (lines.length > maxLines) {
    dropped = lines.length - maxLines
    out = lines.slice(0, maxLines).join('\n')
  }
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars)
    const lastNewline = cut.lastIndexOf('\n')
    const kept = lastNewline > 0 ? cut.slice(0, lastNewline) : cut
    dropped += out.slice(kept.length).split('\n').length - 1
    out = kept
  }
  return dropped > 0 ? `${out}\n[… ${dropped} more line(s) omitted]` : out
}

/**
 * Cap the detailed diff on `diff --git` boundaries instead of mid-hunk.
 * Whole per-file diffs are kept until the budget runs out; oversized single
 * files are truncated individually so one lockfile-sized diff cannot consume
 * the entire budget.
 */
export function capDiffDetail(
  rawDiff: string,
  budgetChars: number,
  perFileChars: number = COMMIT_PROMPT_LIMITS.detailPerFileChars,
): string {
  if (!rawDiff) return ''
  if (rawDiff.length <= budgetChars) return rawDiff
  const chunks = rawDiff.split(/^(?=diff --git )/m)
  const out: string[] = []
  let used = 0
  let omitted = 0
  for (const chunk of chunks) {
    if (!chunk) continue
    const piece = chunk.length > perFileChars
      ? `${chunk.slice(0, perFileChars)}\n[… this file's diff truncated]\n`
      : chunk
    if (used + piece.length > budgetChars) {
      omitted++
      continue
    }
    out.push(piece)
    used += piece.length
  }
  if (omitted > 0) {
    out.push(`\n[Diff hunks for ${omitted} more file(s) omitted — rely on the file summaries above for those.]`)
  }
  return out.join('')
}

/** Generated/vendored files whose hunks add noise, not signal, to a commit message. */
export function isNoisePath(path: string): boolean {
  return (
    /(^|\/)(node_modules|dist|build|out|\.next|coverage|target)\//.test(path) ||
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/.test(path) ||
    /\.(min\.(js|css)|map|lock|snap)$/.test(path)
  )
}

/**
 * Pick the files most worth showing detailed hunks for, by churn
 * (added + deleted lines from `git diff --numstat`). Skips renames (their
 * numstat path field is a `{old => new}` composite that is unsafe as a
 * pathspec), paths that would need shell escaping (the command is built as
 * a double-quoted string for `sh -c` / `cmd /C`, where `"`, `$` and
 * backticks are still live inside double quotes), binaries (`-` counts sort
 * last) and generated noise.
 */
export function selectTopChangedPaths(numstat: string, k: number): string[] {
  const scored: Array<{ path: string; churn: number }> = []
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parseInt(parts[0], 10)
    const deleted = parseInt(parts[1], 10)
    const path = parts.slice(2).join('\t').trim()
    if (!path || path.includes('=>') || /["$`\\]/.test(path)) continue
    if (isNoisePath(path)) continue
    const churn = (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0)
    scored.push({ path, churn })
  }
  scored.sort((a, b) => b.churn - a.churn)
  return scored.slice(0, k).map(s => s.path)
}

export interface CommitPromptSections {
  fileList: string
  nameStatus: string
  numstat: string
  diffStat: string
  diffDetail: string
  diffNotes: string
}

/** Assemble the commit-message prompt with per-section and total budgets. */
export function buildCommitPrompt(
  sections: CommitPromptSections,
  opts?: { detailBudget?: number },
): string {
  const L = COMMIT_PROMPT_LIMITS
  const detailBudget = opts?.detailBudget ?? L.detailChars

  const fileList = capLines(sections.fileList, L.fileListLines, L.summaryChars)
  const nameStatus = capLines(sections.nameStatus, L.summaryLines, L.summaryChars)
  const numstat = capLines(sections.numstat, L.summaryLines, L.summaryChars)
  const diffStat = capLines(sections.diffStat, L.summaryLines, L.summaryChars)

  const assemble = (detail: string) => `Generate a detailed git commit message for these changes using conventional commits format.

Base the message on the actual diff hunks and changed files below. Mention concrete modules, components, APIs, config, tests, and behavior changes when they are visible in the diff. Do not invent changes that are not supported by the diff.

Format:
<type>(<scope>): <subject line, max 72 chars>

<body: 6-12 bullet points explaining what changed, why, and the impact>

Rules:
- type: feat, fix, refactor, chore, docs, style, perf, test
- scope: the main area affected (component, service, worker endpoint, etc.)
- subject: imperative mood, lowercase, no period, specific to the main change
- body: each line starts with "- "
- be THOROUGH: cover every meaningful change visible in the diff — new functions/components, changed behavior, removed code, edge cases handled, UI/UX adjustments, config/dependency changes
- group related bullets by area (e.g. UI, service, worker) when multiple areas changed
- for each significant bullet, include the "why" or the user-visible effect, not just the "what"
- call out breaking changes or migrations explicitly with "BREAKING:" if the diff shows any
- do not pad with filler: every bullet must be backed by the diff, but do not omit real changes either
- do not add any signature, trailer, attribution, user name or email — the app appends those automatically
- Output ONLY the commit message, no quotes, no markdown, no explanation

Files changed:
${fileList}

Name/status:
${nameStatus}

Line changes:
${numstat}

Diff stat:
${diffStat}

Diff hunks:
${detail}

Diff collection notes:
${sections.diffNotes || 'none'}`

  const detail = capDiffDetail(sections.diffDetail, detailBudget)
    || '[Detailed diff unavailable; use file list, name/status, numstat, and stat only.]'
  let prompt = assemble(detail)

  // Total guard — if the summaries alone blew past the ceiling, hand the
  // remaining room to the diff and rebuild.
  if (prompt.length > L.totalChars) {
    const overhead = prompt.length - detail.length
    const room = Math.max(1_000, L.totalChars - overhead)
    prompt = assemble(capDiffDetail(sections.diffDetail, room)
      || '[Detailed diff unavailable; use file list, name/status, numstat, and stat only.]')
  }
  return prompt
}
