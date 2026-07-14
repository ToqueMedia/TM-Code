import {
  decideRemove,
  sanitizeWorktreeName,
  worktreeBranch,
  WORKTREES_REL_DIR,
} from '../toolExecutor/worktrees'

describe('worktrees helpers', () => {
  describe('sanitizeWorktreeName', () => {
    it('slugifies usable names', () => {
      expect(sanitizeWorktreeName('Fix Login Bug')).toBe('fix-login-bug')
      expect(sanitizeWorktreeName('feat/team_v2')).toBe('feat-team_v2')
      expect(sanitizeWorktreeName('  spaced  ')).toBe('spaced')
    })

    it('rejects unusable input so the caller generates a name', () => {
      expect(sanitizeWorktreeName(undefined)).toBeNull()
      expect(sanitizeWorktreeName(42 as never)).toBeNull()
      expect(sanitizeWorktreeName('///')).toBeNull()
      expect(sanitizeWorktreeName('...')).toBeNull()
    })

    it('never produces path-traversal or hidden-dir shapes', () => {
      expect(sanitizeWorktreeName('../../etc')).toBe('etc')
      expect(sanitizeWorktreeName('.hidden')).toBe('hidden')
      const long = sanitizeWorktreeName('x'.repeat(120))
      expect(long).toHaveLength(40)
    })
  })

  it('worktreeBranch namespaces the branch', () => {
    expect(worktreeBranch('fix-1')).toBe('worktree/fix-1')
    expect(WORKTREES_REL_DIR).toBe('.toquemedia/worktrees')
  })

  describe('decideRemove', () => {
    it('allows removal of a clean worktree', () => {
      expect(decideRemove('', 0, false)).toEqual({ proceed: true })
      expect(decideRemove('  \n ', 0, false).proceed).toBe(true)
    })

    it('refuses when there are uncommitted changes, listing them', () => {
      const d = decideRemove(' M src/a.ts\n?? b.txt', 0, false)
      expect(d.proceed).toBe(false)
      expect(d.refusal).toContain('uncommitted changes')
      expect(d.refusal).toContain('M src/a.ts')
      expect(d.refusal).toContain('discard_changes: true')
    })

    it('refuses when there are unmerged commits', () => {
      const d = decideRemove('', 3, false)
      expect(d.proceed).toBe(false)
      expect(d.refusal).toContain('3 commit(s) not on the original branch')
    })

    it('discard_changes overrides both refusals', () => {
      expect(decideRemove(' M src/a.ts', 2, true).proceed).toBe(true)
    })
  })
})
