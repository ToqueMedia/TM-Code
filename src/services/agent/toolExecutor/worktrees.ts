// Worktree session helpers — pure logic for the enter_worktree/exit_worktree
// tools (claude-vaz EnterWorktree/ExitWorktree parity). The git plumbing runs
// in the executor via execute_command; everything decidable without I/O lives
// here so it is unit-testable.
//
// Contract (mirrors claude-vaz):
// - enter_worktree ONLY when the user explicitly says "worktree". Creates an
//   isolated git worktree under <project>/.toquemedia/worktrees/<name> with a
//   fresh branch off HEAD and switches the AGENT session's working root to it
//   (the app/project itself does not move — the developer keeps viewing the
//   main checkout in the editor).
// - exit_worktree restores the original root. action "keep" leaves the
//   worktree+branch on disk; "remove" deletes both, REFUSING when there is
//   unmerged work unless discard_changes is true.

/** Where worktrees live, relative to the project root. Inside the repo so the
 *  path-scope clamp (project root) keeps applying without changes; excluded
 *  from git status via .git/info/exclude (repo-local, never versioned). */
export const WORKTREES_REL_DIR = '.toquemedia/worktrees'

export interface WorktreeState {
  /** The original project root the session returns to on exit. */
  originalRoot: string
  /** Absolute path of the worktree directory (the session root while active). */
  path: string
  branch: string
  name: string
  /** HEAD at creation — used to detect unmerged commits on exit. */
  baseRef: string
}

/** Sanitize a user/model-provided worktree name into a safe dir/branch slug.
 *  Returns null for unusable input (caller generates a name instead). */
export function sanitizeWorktreeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
  return slug.length >= 1 ? slug : null
}

/** Branch name for a worktree session. */
export function worktreeBranch(name: string): string {
  return `worktree/${name}`
}

export interface ExitDecision {
  /** True when exit may proceed (for action=remove: deletion is allowed). */
  proceed: boolean
  /** The refusal message when proceed=false. */
  refusal?: string
}

/**
 * Decide whether an exit_worktree(action="remove") may delete the worktree.
 * `statusPorcelain` is `git status --porcelain` output inside the worktree;
 * `aheadCount` is `git rev-list --count baseRef..HEAD`. Any unmerged work
 * blocks deletion unless the caller explicitly discards.
 */
export function decideRemove(
  statusPorcelain: string,
  aheadCount: number,
  discardChanges: boolean,
): ExitDecision {
  const dirty = statusPorcelain.trim().length > 0
  const ahead = Number.isFinite(aheadCount) && aheadCount > 0
  if (!dirty && !ahead) return { proceed: true }
  if (discardChanges) return { proceed: true }

  const parts: string[] = []
  if (dirty) {
    const files = statusPorcelain
      .trim()
      .split('\n')
      .slice(0, 15)
      .map((l) => `  ${l}`)
      .join('\n')
    parts.push(`uncommitted changes:\n${files}`)
  }
  if (ahead) parts.push(`${aheadCount} commit(s) not on the original branch`)
  return {
    proceed: false,
    refusal:
      `Refusing to remove the worktree — it has ${parts.join(' and ')}.\n` +
      `Preserve the work (merge/cherry-pick it, or exit with action: "keep"), ` +
      `or confirm with the user and re-invoke with discard_changes: true to delete it anyway.`,
  }
}

export const ENTER_WORKTREE_DESCRIPTION =
  'Create an isolated git worktree and switch THIS agent session into it. ' +
  'Use ONLY when the user explicitly says "worktree" (e.g. "work in a worktree", "create a worktree"). ' +
  'Do NOT use for ordinary branch work — use git commands for branches. ' +
  `Requires a git repository and no active worktree session. Creates ${WORKTREES_REL_DIR}/<name> with a new branch off HEAD; ` +
  'all file tools and shell commands then resolve inside the worktree until exit_worktree. ' +
  'The developer keeps seeing the MAIN checkout in their editor — tell them where the worktree lives.'

export const EXIT_WORKTREE_DESCRIPTION =
  'Exit the worktree session created by enter_worktree and restore the original project root. ' +
  'No-op when no worktree session is active. ' +
  'action "keep" leaves the worktree directory and branch on disk (work resumable later); ' +
  'action "remove" deletes both — it REFUSES if there is uncommitted or unmerged work unless discard_changes is true ' +
  '(confirm with the user before discarding). Only operates on the worktree this session created.'
