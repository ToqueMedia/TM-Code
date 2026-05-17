import { buildCompactPrompt, formatCompactSummary } from '../compactPrompt'

describe('buildCompactPrompt', () => {
  it('produces a prompt that opens with the no-tools preamble', () => {
    const out = buildCompactPrompt()
    expect(out.startsWith('CRITICAL: Respond with TEXT ONLY')).toBe(true)
  })

  it('includes the 9 required output sections', () => {
    const out = buildCompactPrompt()
    // These are the section labels the model is told to emit, in order.
    // If any disappears the model loses a continuity anchor.
    expect(out).toContain('1. Primary Request and Intent')
    expect(out).toContain('2. Key Technical Concepts')
    expect(out).toContain('3. Files and Code Sections')
    expect(out).toContain('4. Errors and fixes')
    expect(out).toContain('5. Problem Solving')
    expect(out).toContain('6. All user messages')
    expect(out).toContain('7. Pending Tasks')
    expect(out).toContain('8. Current Work')
    expect(out).toContain('9. Optional Next Step')
  })

  it('mandates the <analysis> drafting wrapper', () => {
    const out = buildCompactPrompt()
    expect(out).toContain('wrap your analysis in <analysis> tags')
  })

  it('closes with the no-tools trailer reminder', () => {
    const out = buildCompactPrompt()
    expect(out.trimEnd().endsWith('Tool calls will be rejected and you will fail the task.')).toBe(true)
  })

  it('instructs to respond in the conversation language', () => {
    // This is what stops the summary from drifting from PT-PT to EN
    // (or vice versa) mid-session — important for users speaking in PT.
    const out = buildCompactPrompt()
    expect(out).toContain('Respond in the same language the conversation uses')
  })
})

describe('formatCompactSummary', () => {
  it('strips the <analysis> block', () => {
    const raw = '<analysis>\nthinking out loud\n</analysis>\n<summary>\nfinal\n</summary>'
    const out = formatCompactSummary(raw)
    expect(out).not.toContain('thinking out loud')
    expect(out).not.toContain('<analysis>')
  })

  it('unwraps the <summary> block and prefixes "Summary:"', () => {
    const raw = '<summary>\n1. Primary Request:\n   build a chat app\n</summary>'
    const out = formatCompactSummary(raw)
    expect(out).toMatch(/^Summary:/)
    expect(out).toContain('1. Primary Request:')
    expect(out).toContain('build a chat app')
    expect(out).not.toContain('<summary>')
    expect(out).not.toContain('</summary>')
  })

  it('handles the full claude-vaz output shape end-to-end', () => {
    const raw = `<analysis>
I traced through the messages...
The user wants X.
</analysis>

<summary>
1. Primary Request and Intent:
   User asked for X.

2. Key Technical Concepts:
   - React 19
   - Tauri 2

9. Optional Next Step:
   Run npm test.
</summary>`
    const out = formatCompactSummary(raw)
    expect(out).not.toContain('<analysis>')
    expect(out).not.toContain('I traced through the messages')
    expect(out).toMatch(/^Summary:/)
    expect(out).toContain('Primary Request and Intent')
    expect(out).toContain('Optional Next Step')
    expect(out).toContain('Run npm test')
  })

  it('passes through unchanged when neither tag is present (older model output)', () => {
    // Defensive: if the model didn't follow the template, we keep what it
    // returned rather than emit empty context to the next turn.
    const raw = '1. Some bullet point\n2. Another bullet\nDone.'
    const out = formatCompactSummary(raw)
    expect(out).toBe(raw.trim())
  })

  it('collapses 3+ consecutive blank lines left behind by the strip', () => {
    const raw = '<analysis>\nfoo\n</analysis>\n\n\n\n\n<summary>\nresult\n</summary>'
    const out = formatCompactSummary(raw)
    // Should not contain triple-blank gap — the analysis-strip leaves a
    // hole that the regex collapses.
    expect(out).not.toMatch(/\n{3,}/)
  })

  it('handles only-analysis (no <summary>) by returning the post-strip residue', () => {
    // Edge case: model emitted analysis but no summary. We return what's
    // left after stripping (which may be empty) rather than the raw text.
    const raw = '<analysis>drafting only</analysis>\nleftover prose'
    const out = formatCompactSummary(raw)
    expect(out).not.toContain('drafting only')
    expect(out).toContain('leftover prose')
  })

  it('handles only-summary (no <analysis>) by unwrapping cleanly', () => {
    const raw = '<summary>\njust the summary\n</summary>'
    const out = formatCompactSummary(raw)
    expect(out).toBe('Summary:\njust the summary')
  })

  it('handles an empty input', () => {
    expect(formatCompactSummary('')).toBe('')
  })
})
