// The hero diff revealed in scene 5. Line structure mirrors the real TM Code
// TerminalStructuredDiff renderer (hunk header, gutter line numbers, +/− rows).

import type { DiffSpec } from './diffData'

export const heroDiff: DiffSpec = {
  filePath: 'src/components/Hero.tsx',
  summary: 'Added 9 lines',
  lines: [
    { kind: 'hunk', text: '@@ -8,1 +8,11 @@' },
    { kind: 'context', lineNo: 8, text: "import './hero.css'" },
    { kind: 'add', lineNo: 9, text: 'export function Hero() {' },
    { kind: 'add', lineNo: 10, text: '  return (' },
    { kind: 'add', lineNo: 11, text: '    <section className="hero">' },
    { kind: 'add', lineNo: 12, text: '      <h1>Build your SaaS faster</h1>' },
    { kind: 'add', lineNo: 13, text: '      <p>Launch your idea with AI-assisted development.</p>' },
    { kind: 'add', lineNo: 14, text: '      <button className="cta">Join waitlist</button>' },
    { kind: 'add', lineNo: 15, text: '    </section>' },
    { kind: 'add', lineNo: 16, text: '  )' },
    { kind: 'add', lineNo: 17, text: '}' },
  ],
}

/** Indices into heroDiff.lines to emphasize in scene 5 (the <h1> + waitlist button). */
export const HERO_FOCUS = [5, 7] as const
