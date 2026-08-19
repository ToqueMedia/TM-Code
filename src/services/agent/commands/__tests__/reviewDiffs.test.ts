import {
  assembleInjectedDiffs,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  clipText,
  formatFileDiff,
} from '../reviewDiffs'
import { buildDebugPrompt } from '../debugPrompt'
import { buildE2EPrompt } from '../e2ePrompt'

/** Numbered ritual steps (`1. Do X`) — not "HEAD~1" or "file:line". */
const NUMBERED_STEP = /^\s*\d+\.\s+\S/m

jest.mock('../../../../i18n', () => ({
  t: (key: string) => key,
}))

jest.mock('../../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ agentLanguage: 'en' }),
  },
}))

function sessionScope(patch: string, files: string[], extra: Partial<Parameters<typeof buildReviewPrompt>[0]> = {}) {
  return buildReviewPrompt({
    scope: { type: 'session' },
    files,
    patch,
    capped: false,
    truncated: false,
    originalCount: files.length,
    ...extra,
  })
}

describe('review diffs', () => {
  it('formatFileDiff emits a unified patch with the relative path', () => {
    const patch = formatFileDiff('src/a.ts', 'const a = 1\n', 'const a = 2\n')
    expect(patch).toContain('--- src/a.ts')
    expect(patch).toContain('+++ src/a.ts')
    expect(patch).toContain('-const a = 1')
    expect(patch).toContain('+const a = 2')
  })

  it('assembleInjectedDiffs prefers recent files, skips deletes, relativizes', () => {
    const assembled = assembleInjectedDiffs(
      [
        { filePath: '/proj/src/old.ts', before: 'a\n', after: 'b\n' },
        { filePath: '/proj/src/gone.ts', before: 'x\n', after: null },
        { filePath: '/proj/src/new.ts', before: null, after: 'hello\n' },
      ],
      { projectPath: '/proj' },
    )
    expect(assembled.files).toEqual(['src/new.ts', 'src/old.ts'])
    expect(assembled.patch).toContain('+++ src/new.ts')
    expect(assembled.patch).toContain('+++ src/old.ts')
    expect(assembled.patch).not.toContain('gone.ts')
    expect(assembled.capped).toBe(false)
    expect(assembled.originalCount).toBe(2)
  })

  it('assembleInjectedDiffs honours the file cap (most recent kept)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      filePath: `/proj/f${i}.ts`,
      before: 'a\n',
      after: `b${i}\n`,
    }))
    const assembled = assembleInjectedDiffs(entries, { projectPath: '/proj', fileCap: 2 })
    expect(assembled.files).toEqual(['f4.ts', 'f3.ts'])
    expect(assembled.capped).toBe(true)
    expect(assembled.originalCount).toBe(5)
  })

  it('clipText marks truncation', () => {
    const clipped = clipText('abcdefghij', 4, 'x')
    expect(clipped.truncated).toBe(true)
    expect(clipped.text.startsWith('abcd')).toBe(true)
    expect(clipped.text).toContain('truncated x')
  })
})

describe('review / debug / te2e prompts', () => {
  it('/review session prompt injects the diff as markdown, without a numbered ritual', () => {
    const prompt = sessionScope('--- a\n+++ b\n+added\n', ['src/a.ts'])
    expect(prompt).toContain('## Diff')
    expect(prompt).toContain('+added')
    expect(prompt).toMatch(/do not re-read every file/)
    expect(prompt).not.toMatch(NUMBERED_STEP)
    expect(prompt).not.toMatch(/<protocol>|<role>|<constraints>/)
    expect(prompt).not.toMatch(/Reasoning is forced/)
  })

  it('/review system prompt is prose, not a numbered constitution', () => {
    const sys = buildReviewSystemPrompt('/proj')
    expect(sys).toMatch(/expert code reviewer/i)
    expect(sys).not.toMatch(NUMBERED_STEP)
    expect(sys).not.toMatch(/<protocol>|<role>|<severity_tiers>/)
    expect(sys).not.toMatch(/Found: <N>/)
    expect(sys).not.toMatch(/maxTurns/)
  })

  it('/review notes a truncated patch', () => {
    const prompt = sessionScope('patch', ['src/a.ts'], { truncated: true })
    expect(prompt).toContain('truncated to fit the review budget')
  })

  it('/debug is prose and does not claim thinking is forced', () => {
    const prompt = buildDebugPrompt('button does nothing', '/proj')
    expect(prompt).toContain('button does nothing')
    expect(prompt).toContain('start_dev_server')
    expect(prompt).not.toMatch(NUMBERED_STEP)
    expect(prompt).not.toMatch(/Reasoning is forced/)
    expect(prompt).not.toMatch(/Form 2–3 hypotheses/)
    expect(prompt.length).toBeLessThan(1600)
  })

  it('/te2e is a smoke check in prose, not a numbered QA matrix', () => {
    const prompt = buildE2EPrompt('login flow', '/proj')
    expect(prompt).toContain('login flow')
    expect(prompt).toContain('browser_snapshot')
    expect(prompt).not.toMatch(NUMBERED_STEP)
    expect(prompt).not.toMatch(/Reasoning is forced/)
    expect(prompt).not.toMatch(/scenario matrix/)
    expect(prompt).not.toMatch(/PHASE 1/)
    expect(prompt).not.toMatch(/Found: <N>/)
    expect(prompt.length).toBeLessThan(2000)
  })
})
