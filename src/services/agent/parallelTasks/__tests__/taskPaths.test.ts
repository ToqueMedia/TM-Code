import { makeTaskPathNormalizer } from '../taskPaths'

export {}

const PROJECT = '/Users/dev/profile'
const NAME = 'task-1-mro2w439'
const WT = { path: `${PROJECT}/.toquemedia/worktrees/${NAME}`, name: NAME }

describe('makeTaskPathNormalizer', () => {
  const normalize = makeTaskPathNormalizer(WT, PROJECT)

  it('strips the project-root-relative worktree prefix (the observed bug)', () => {
    expect(normalize({ file_path: `.toquemedia/worktrees/${NAME}/web/src/lib/auth.ts` }))
      .toEqual({ file_path: 'web/src/lib/auth.ts' })
  })

  it('strips a doubled prefix (damage form) defensively', () => {
    expect(normalize({ path: `.toquemedia/worktrees/${NAME}/.toquemedia/worktrees/${NAME}/web/a.ts` }))
      .toEqual({ path: 'web/a.ts' })
  })

  it('keeps clean absolute paths inside the worktree (executor accepts absolutes)', () => {
    const input = { file_path: `${PROJECT}/.toquemedia/worktrees/${NAME}/src/App.tsx` }
    expect(normalize(input)).toBe(input)
  })

  it('normalizes the nested-absolute damage form', () => {
    expect(normalize({ file_path: `${WT.path}/.toquemedia/worktrees/${NAME}/src/App.tsx` }))
      .toEqual({ file_path: 'src/App.tsx' })
  })

  it('leaves clean relative and clean absolute-in-worktree paths untouched', () => {
    const cleanRel = { file_path: 'web/src/App.tsx' }
    expect(normalize(cleanRel)).toBe(cleanRel)
    const cleanAbs = { file_path: `${WT.path}/web/src/App.tsx` }
    expect(normalize(cleanAbs)).toBe(cleanAbs)
  })

  it('remaps absolute MAIN-checkout paths into the worktree (task work belongs there)', () => {
    expect(normalize({ file_path: `${PROJECT}/web/src/App.tsx` }))
      .toEqual({ file_path: 'web/src/App.tsx' })
  })

  it('leaves absolute paths of OTHER tasks\' worktrees untouched (access guard owns those)', () => {
    const other = { file_path: `${PROJECT}/.toquemedia/worktrees/task-2-zzz/a.ts` }
    expect(normalize(other)).toBe(other)
  })

  it('does not touch other tasks\' worktree paths', () => {
    const other = { file_path: '.toquemedia/worktrees/task-2-zzz/web/a.ts' }
    expect(normalize(other)).toBe(other)
  })

  it('normalizes every path-carrying key, including rename pairs and cwd', () => {
    expect(normalize({
      old_path: `.toquemedia/worktrees/${NAME}/a.ts`,
      new_path: `.toquemedia/worktrees/${NAME}/b.ts`,
      cwd: `.toquemedia/worktrees/${NAME}/web`,
      command: 'npm test',
    })).toEqual({ old_path: 'a.ts', new_path: 'b.ts', cwd: 'web', command: 'npm test' })
  })

  it('is a passthrough without a worktree', () => {
    const passthrough = makeTaskPathNormalizer(null, PROJECT)
    const input = { file_path: `.toquemedia/worktrees/${NAME}/web/a.ts` }
    expect(passthrough(input)).toBe(input)
  })
})
