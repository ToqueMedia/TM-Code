// The hero diff revealed inline in the chat (scene 4). Mirrors the real TM Code
// TerminalStructuredDiff renderer (hunk header, gutter, +/− rows).

import type { DiffSpec } from './diffData'

export const heroDiff: DiffSpec = {
  filePath: 'src/components/Hero.tsx',
  summary: 'Added 4 lines',
  lines: [
    { kind: 'hunk', text: '@@ -12,3 +12,9 @@' },
    { kind: 'context', lineNo: 12, text: '  return (' },
    { kind: 'context', lineNo: 13, text: '    <section className="hero">' },
    { kind: 'add', lineNo: 14, text: '      <h1>Lança a tua ideia mais rápido</h1>' },
    { kind: 'add', lineNo: 15, text: '      <p>Cria, valida e publica com ajuda da IA.</p>' },
    { kind: 'add', lineNo: 16, text: '      <WaitlistForm />' },
    { kind: 'add', lineNo: 17, text: '      <EmailPasswordAuth />' },
    { kind: 'context', lineNo: 18, text: '    </section>' },
  ],
}

/** Indices into heroDiff.lines to emphasize (the <h1> + the auth component). */
export const HERO_FOCUS = [3, 6] as const
