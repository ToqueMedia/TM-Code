import {
  coalesceLogLines,
  MAX_COALESCED_LINES,
} from '../devServerLogCoalesce'

describe('coalesceLogLines', () => {
  // ── single-line lifecycle ────────────────────────────────────────
  it('leaves standalone lines unmerged', () => {
    const r = coalesceLogLines(['hello', 'world', 'three'])
    expect(r.map((e) => e.text)).toEqual(['hello', 'world', 'three'])
  })

  it('drops empty lines between standalone entries', () => {
    const r = coalesceLogLines(['hello', '', '  ', 'world'])
    expect(r.map((e) => e.text)).toEqual(['hello', 'world'])
  })

  // ── multi-line console.log({obj}) (the BugHunterKimi case) ──────
  it('coalesces an indented JSON-like object dump into ONE entry', () => {
    const lines = [
      'payload: {',
      "  name: 'SendOut SMS',",
      "  picture: 'https://lh3.googleusercontent.com/a/x'",
      "  iss: 'https://securetoken.google.com/dev-studio-projects',",
      "  email: 'appsendout@gmail.com'",
      '}',
    ]
    const r = coalesceLogLines(lines)
    expect(r).toHaveLength(1)
    expect(r[0].text).toBe(lines.join('\n'))
    expect(r[0].rawLines).toEqual(lines)
  })

  it('coalesces an array dump (continuation via leading whitespace)', () => {
    const lines = [
      'items: [',
      "  'one',",
      "  'two',",
      "  'three'",
      ']',
    ]
    const r = coalesceLogLines(lines)
    expect(r).toHaveLength(1)
    expect(r[0].text.split('\n')).toHaveLength(5)
  })

  // ── stack traces ────────────────────────────────────────────────
  it('coalesces an Error + "  at ..." stack trace into one entry', () => {
    const lines = [
      'Error: something broke',
      '    at fn (/path/to/file.ts:10:5)',
      '    at caller (/path/to/other.ts:42:1)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ]
    const r = coalesceLogLines(lines)
    expect(r).toHaveLength(1)
    expect(r[0].level).toBe('error')
    expect(r[0].rawLines).toHaveLength(4)
  })

  // ── concurrently / turbo prefix handling ────────────────────────
  it('coalesces lines with the SAME concurrently prefix', () => {
    const lines = [
      '[server] payload: {',
      "[server]   name: 'X',",
      "[server]   token: 'abc'",
      '[server] }',
    ]
    const r = coalesceLogLines(lines)
    expect(r).toHaveLength(1)
    expect(r[0].text.split('\n')).toHaveLength(4)
  })

  it('does NOT merge across different concurrently workers', () => {
    const lines = [
      '[server] starting object: {',
      '[client]   not-mine',  // continuation-looking but different worker
    ]
    const r = coalesceLogLines(lines)
    expect(r).toHaveLength(2)
    expect(r[0].text).toBe('[server] starting object: {')
    expect(r[1].text).toBe('[client]   not-mine')
  })

  it('preserves the role prefix in the coalesced text', () => {
    const r = coalesceLogLines([
      '[0] outer: {',
      '[0]   inner: 1',
      '[0] }',
    ])
    expect(r[0].text).toContain('[0]')
  })

  // ── continuation signal: open bracket + comma ───────────────────
  it('coalesces when the previous line ends with an open bracket', () => {
    // No leading whitespace on continuation lines, but the bracket signals it.
    const r = coalesceLogLines([
      'config = {',
      'foo: 1',  // no indent, but prev ends with {
      'bar: 2',  // prev ends with digit — should NOT continue
    ])
    // The bracket pulls "foo: 1" in. After "foo: 1" (no opener at end), the
    // next line "bar: 2" is at column 0 with no continuation cue → new entry.
    expect(r).toHaveLength(2)
    expect(r[0].text).toBe('config = {\nfoo: 1')
    expect(r[1].text).toBe('bar: 2')
  })

  it('coalesces a function-call continuation (trailing comma)', () => {
    const r = coalesceLogLines([
      'callFn(arg1,',
      '       arg2,',
      '       arg3)',
    ])
    expect(r).toHaveLength(1)
    expect(r[0].rawLines).toHaveLength(3)
  })

  // ── separation between unrelated logs ───────────────────────────
  it('does NOT merge two separate console.log calls at column 0', () => {
    const r = coalesceLogLines([
      'first message',
      'second message',
      'third message',
    ])
    expect(r).toHaveLength(3)
  })

  it('does NOT merge a header line that has no opener with an indented follow-up that comes after a blank line', () => {
    const r = coalesceLogLines([
      'header',
      '',
      '  indented but separated by blank',
    ])
    expect(r).toHaveLength(2)
  })

  // ── level detection ─────────────────────────────────────────────
  it('uses the MAX severity across the block', () => {
    const r = coalesceLogLines([
      'Error: oops',
      '    at fn ()',
      '    warning: oops',  // ← would be 'warn' if seen alone
    ])
    expect(r[0].level).toBe('error')
  })

  it('emits info level for plain blocks', () => {
    const r = coalesceLogLines(['payload: {', '  ok: true', '}'])
    expect(r[0].level).toBe('info')
  })

  it('detects warn when the first line is npm warn', () => {
    const r = coalesceLogLines([
      'npm warn deprecated foo@1.0.0',
      '  please upgrade',
    ])
    expect(r[0].level).toBe('warn')
  })

  // ── safety cap ──────────────────────────────────────────────────
  it('caps a runaway block at MAX_COALESCED_LINES', () => {
    const huge = ['header: {']
    for (let i = 0; i < MAX_COALESCED_LINES + 50; i++) huge.push(`  line ${i}`)
    const r = coalesceLogLines(huge)
    // First entry caps at MAX, remainder spills into subsequent entries.
    expect(r[0].rawLines.length).toBe(MAX_COALESCED_LINES)
    // The overflow lines still appear in later entries — none are dropped.
    const total = r.reduce((acc, e) => acc + e.rawLines.length, 0)
    expect(total).toBe(huge.length)
  })

  // ── ANSI codes ──────────────────────────────────────────────────
  it('handles ANSI color codes around the role prefix', () => {
    const lines = [
      '\x1b[34m[server]\x1b[0m payload: {',
      '\x1b[34m[server]\x1b[0m   name: x',
      '\x1b[34m[server]\x1b[0m }',
    ]
    const r = coalesceLogLines(lines)
    // Both lines have the same role prefix (after ANSI strip), the indented
    // body signals continuation.
    expect(r).toHaveLength(1)
    expect(r[0].rawLines).toHaveLength(3)
  })

  it('detects error level even when wrapped in ANSI red', () => {
    const r = coalesceLogLines(['\x1b[31mError: bad\x1b[0m'])
    expect(r[0].level).toBe('error')
  })

  // ── BugHunterKimi exact reproduction ────────────────────────────
  it('reproduces the user-reported screenshot exactly', () => {
    // From /var/folders/.../clipboard-2026-05-11... — the payload from
    // GoogleSignInButton + Identity Toolkit decoded JWT.
    const lines = [
      '[0] payload: {',
      "[0]   name: 'SendOut SMS',",
      "[0]   picture: 'https://lh3.googleusercontent.com/a/xyz',",
      "[0]   iss: 'https://securetoken.google.com/dev-studio-projects',",
      "[0]   aud: 'dev-studio-projects',",
      '[0]   auth_time: 1778446061,',
      "[0]   user_id: 'Lun0Hft3IcgZ5KjQQijimgoel173',",
      "[0]   sub: 'Lun0Hft3IcgZ5KjQQijimgoel173',",
      '[0]   iat: 1778446061,',
      '[0]   exp: 1778449661,',
      "[0]   email: 'appsendout@gmail.com',",
      '[0] }',
    ]
    const r = coalesceLogLines(lines)
    expect(r).toHaveLength(1)
    expect(r[0].rawLines).toHaveLength(12)
    // The agent should now receive the WHOLE payload when "send to agent"
    // is clicked — not just `email: 'appsendout@gmail.com',` in isolation.
    expect(r[0].text).toContain('payload: {')
    expect(r[0].text).toContain("email: 'appsendout@gmail.com',")
  })
})
