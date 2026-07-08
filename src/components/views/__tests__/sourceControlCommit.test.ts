import {
  TM_CODE_COMMIT_SIGNATURE,
  COMMIT_PROMPT_LIMITS,
  buildCommitPrompt,
  capDiffDetail,
  capLines,
  cleanGeneratedCommitMessage,
  ensureTmCodeCommitSignature,
  isNoisePath,
  selectTopChangedPaths,
  stripTmCodeCommitSignature,
} from '../sourceControlCommit'

describe('sourceControlCommit helpers', () => {
  it('appends the TM Code trailer at commit time', () => {
    expect(ensureTmCodeCommitSignature('fix: update source control')).toBe(
      `fix: update source control\n\n${TM_CODE_COMMIT_SIGNATURE}`,
    )
  })

  it('does not duplicate an existing TM Code trailer', () => {
    const signed = `fix: update source control\n\n${TM_CODE_COMMIT_SIGNATURE}`
    expect(ensureTmCodeCommitSignature(signed)).toBe(signed)
  })

  it('strips the TM Code trailer from generated textarea content', () => {
    expect(stripTmCodeCommitSignature(`fix: update source control\n\n${TM_CODE_COMMIT_SIGNATURE}`)).toBe(
      'fix: update source control',
    )
  })

  it('removes reasoning, labels, quotes and trailers from generated messages', () => {
    const raw = `<think>hidden</think>\nCommit message:\n"fix(source-control): commit staged files\n\n${TM_CODE_COMMIT_SIGNATURE}"`
    expect(cleanGeneratedCommitMessage(raw)).toBe('fix(source-control): commit staged files')
  })
})

describe('capLines', () => {
  it('returns short text untouched', () => {
    expect(capLines('a\nb', 10, 100)).toBe('a\nb')
  })

  it('truncates by line count with an omission note', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n')
    const out = capLines(text, 3, 10_000)
    expect(out).toContain('line2')
    expect(out).not.toContain('line3')
    expect(out).toContain('7 more line(s) omitted')
  })

  it('truncates by char budget on a line boundary', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n')
    const out = capLines(text, 1_000, 40)
    expect(out.length).toBeLessThan(text.length)
    expect(out).toContain('omitted')
  })
})

describe('capDiffDetail', () => {
  const fileDiff = (name: string, body: string) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${body}\n`

  it('returns diffs under budget untouched', () => {
    const raw = fileDiff('a.ts', '+one')
    expect(capDiffDetail(raw, 10_000)).toBe(raw)
  })

  it('drops whole files past the budget instead of cutting mid-hunk', () => {
    const raw = fileDiff('a.ts', '+aaa'.repeat(50)) + fileDiff('b.ts', '+bbb'.repeat(50)) + fileDiff('c.ts', '+ccc'.repeat(50))
    const out = capDiffDetail(raw, 500, 400)
    expect(out).toContain('diff --git a/a.ts')
    expect(out).toContain('more file(s) omitted')
    // No chunk should be cut mid-way without its own truncation marker
    expect(out.startsWith('diff --git')).toBe(true)
  })

  it('caps a single oversized file so it cannot eat the whole budget', () => {
    const raw = fileDiff('huge.ts', '+x'.repeat(5_000)) + fileDiff('tiny.ts', '+ok')
    const out = capDiffDetail(raw, 3_000, 1_000)
    expect(out).toContain("this file's diff truncated")
    expect(out).toContain('diff --git a/tiny.ts')
  })
})

describe('selectTopChangedPaths', () => {
  it('ranks by churn and skips renames, quotes and noise', () => {
    const numstat = [
      '10\t2\tsrc/small.ts',
      '500\t100\tsrc/big.ts',
      '900\t900\tpackage-lock.json',        // noise
      '50\t50\tsrc/{old => new}/moved.ts',  // rename composite
      '5\t1\tsrc/"weird".ts',               // embedded quote
      '-\t-\tassets/logo.png',              // binary
      '30\t0\tsrc/mid.ts',
    ].join('\n')
    expect(selectTopChangedPaths(numstat, 2)).toEqual(['src/big.ts', 'src/mid.ts'])
  })
})

describe('isNoisePath', () => {
  it('flags lockfiles, build output and minified bundles', () => {
    expect(isNoisePath('package-lock.json')).toBe(true)
    expect(isNoisePath('web/yarn.lock')).toBe(true)
    expect(isNoisePath('app/dist/index.js')).toBe(true)
    expect(isNoisePath('lib/bundle.min.js')).toBe(true)
    expect(isNoisePath('src/components/App.tsx')).toBe(false)
    expect(isNoisePath('src/distances.ts')).toBe(false)
  })
})

describe('buildCommitPrompt', () => {
  const baseSections = {
    fileList: 'modified: src/a.ts',
    nameStatus: 'M\tsrc/a.ts',
    numstat: '1\t1\tsrc/a.ts',
    diffStat: ' src/a.ts | 2 +-',
    diffDetail: 'diff --git a/src/a.ts b/src/a.ts\n+new',
    diffNotes: '',
  }

  it('assembles all sections for a small changeset', () => {
    const prompt = buildCommitPrompt(baseSections)
    expect(prompt).toContain('modified: src/a.ts')
    expect(prompt).toContain('diff --git a/src/a.ts')
    expect(prompt).toContain('conventional commits')
  })

  it('never exceeds the total budget even with massive sections', () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `M\tsrc/file-${i}.ts`).join('\n')
    const prompt = buildCommitPrompt({
      fileList: huge,
      nameStatus: huge,
      numstat: huge,
      diffStat: huge,
      diffDetail: `diff --git a/x b/x\n${'+line\n'.repeat(20_000)}`,
      diffNotes: '',
    })
    // Summaries are line-capped and the diff shrinks to the remaining room.
    expect(prompt.length).toBeLessThanOrEqual(COMMIT_PROMPT_LIMITS.totalChars + 2_000)
    expect(prompt).toContain('omitted')
  })

  it('shrinks the diff detail on the retry budget', () => {
    // Several ~2KB file diffs: the 12K budget admits more of them than the
    // 5K retry budget (a single file would hit the per-file cap in both).
    const detail = Array.from({ length: 8 }, (_, i) =>
      `diff --git a/f${i}.ts b/f${i}.ts\n${'+line\n'.repeat(330)}`
    ).join('')
    const full = buildCommitPrompt({ ...baseSections, diffDetail: detail })
    const retry = buildCommitPrompt({ ...baseSections, diffDetail: detail }, { detailBudget: COMMIT_PROMPT_LIMITS.detailCharsRetry })
    expect(retry.length).toBeLessThan(full.length)
  })
})
