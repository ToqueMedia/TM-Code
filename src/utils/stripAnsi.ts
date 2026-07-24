/**
 * Strip ANSI / terminal control sequences from text before rendering in
 * non-terminal UI (chat shell blocks, debug console, logs).
 *
 * Root cause of garbage like `[38;5;246m` / `[0m` in the UI: tools emit
 * SGR color codes (CSI … m). xterm interprets them; plain React `<Text>`
 * shows them as noise — especially when ESC (U+001B) is lost and only the
 * `[…m` tail remains.
 */

// Full CSI / OSC / single-char ESC sequences (ESC or 8-bit CSI).
// Covers 256-color (`38;5;N`), truecolor (`38;2;r;g;b`), cursor, erase, etc.
const ANSI_CSI_OSC =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

// After ESC is stripped or dropped by a partial sanitizer, orphan SGR tails
// like `[38;5;246m` and `[0m` remain. Match only digit/semicolon params so we
// don't eat legitimate `[error]` / `[ok]` tags.
const ORPHAN_SGR = /\[(?:\d{1,3};)*\d{1,3}m/g

// Residual C0 controls (keep \t \n \r \b — those are handled explicitly).
// eslint-disable-next-line no-control-regex
const C0_NOISE = /[\u0000-\u0007\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g

/**
 * Remove ANSI color/cursor sequences and common orphan tails.
 * Safe for multi-line tool output and debug console lines.
 */
export function stripAnsi(text: string): string {
  if (!text) return text
  return text
    .replace(ANSI_CSI_OSC, '')
    .replace(ORPHAN_SGR, '')
    .replace(C0_NOISE, '')
}

/**
 * Normalize terminal text for plain UI: strip ANSI, apply backspaces,
 * normalize newlines, trim trailing spaces per line.
 */
export function normalizeTerminalText(text: string): string {
  if (!text) return text
  // Apply backspaces BEFORE dropping residual C0 (so \b still works).
  const chars: string[] = []
  for (const ch of text) {
    if (ch === '\b') chars.pop()
    else chars.push(ch)
  }
  return stripAnsi(chars.join(''))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
}
