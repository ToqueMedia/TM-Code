/**
 * Coalesce raw dev-server stdout/stderr lines into logical blocks.
 *
 * The problem this solves: `console.log({obj})` in the user's app produces an
 * indented multi-line dump in stdout. The Rust capture splits on '\n' and the
 * frontend used to emit one DevServerLogEntry per line. Result: clicking the
 * "send to agent" button on any one of those lines sends only that fragment,
 * not the whole object. The agent loses context and chases noise.
 *
 * Heuristic: a line is a "continuation" of the previous one when, after
 * stripping the optional concurrently/turbo `[role]` prefix and ANSI codes,
 * it starts with whitespace OR the previous line ends with an opening bracket
 * (`{`, `[`, `(`) or a trailing comma. The block ends at the first non-
 * continuation line, at the safety cap, or at a different role prefix.
 *
 * Anti-cases (intentionally NOT coalesced):
 *  - Two separate `console.log('foo'); console.log('bar')` calls — neither is
 *    indented, brackets balanced, no continuation signal.
 *  - Lines from different concurrently workers (`[server]` then `[client]`).
 *  - A new error following the previous block at column 0.
 *
 * Exported so the unit test can target it without the dev-server lifecycle.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface CoalescedEntry {
  text: string
  level: LogLevel
  /** Raw lines that fed this entry. Surfaced so callers that still need
   *  per-line side-effects (URL probing, EADDRINUSE recovery) can iterate
   *  without re-splitting. */
  rawLines: string[]
}

/** Hard cap on lines folded into one entry. Prevents runaway merges if the
 *  app prints a 10k-line table — better to chunk than to crash the UI. */
export const MAX_COALESCED_LINES = 200

/** Strip ANSI color/cursor escapes so prefix detection sees plain text. */
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** Concurrently/turbo/npm prefix: `[server]`, `[0]`, `[client:dev]`, etc.
 *  Matches the leading `[...]` block plus EXACTLY one trailing space. */
const ROLE_PREFIX_REGEX = /^\[[^\]\n]+\]\s/

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '')
}

/** Strip the role prefix (if any) and return both the prefix and the rest.
 *  Returns ['', line] when no prefix is present. */
function splitRolePrefix(line: string): [string, string] {
  const plain = stripAnsi(line)
  const m = plain.match(ROLE_PREFIX_REGEX)
  if (!m) return ['', plain]
  return [m[0], plain.slice(m[0].length)]
}

function detectLevel(line: string): LogLevel {
  const plain = stripAnsi(line)
  const isWarn = /\bwarn(ing)?\b/i.test(plain) || /\bnpm warn\b/i.test(plain)
  if (isWarn) return 'warn'
  const isError =
    /\berror\b/i.test(plain) ||
    /\bERR[!_]/i.test(plain) ||
    /\bfailed\b/i.test(plain) ||
    /\bEADDRINUSE\b/.test(plain)
  return isError ? 'error' : 'info'
}

const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 }

function maxLevel(levels: LogLevel[]): LogLevel {
  return levels.reduce<LogLevel>((acc, l) => (LEVEL_RANK[l] > LEVEL_RANK[acc] ? l : acc), 'info')
}

/**
 * Naive bracket-balance counter that ignores characters inside string
 * literals. Used so a multi-line object dump whose closing `}` lands at
 * column 0 still gets coalesced — column-0 `}` isn't indented and the
 * previous line typically doesn't end in `,{[(`, so the whitespace/comma
 * heuristic alone fails. With balance tracking the close is recognised as
 * "still inside the open block".
 *
 * Imperfect (e.g. ignores comments, mistakes regex `/[/` for char classes),
 * but a continuation heuristic doesn't need a parser — false positives just
 * extend the block by a line or two, false negatives split user data.
 */
function bracketDelta(text: string): number {
  const plain = stripAnsi(text)
  let delta = 0
  let inString: false | "'" | '"' | '`' = false
  for (let k = 0; k < plain.length; k++) {
    const c = plain[k]
    if (inString) {
      if (c === '\\') { k++; continue }
      if (c === inString) inString = false
      continue
    }
    if (c === "'" || c === '"' || c === '`') { inString = c; continue }
    if (c === '{' || c === '[' || c === '(') delta++
    else if (c === '}' || c === ']' || c === ')') delta--
  }
  return delta
}

/**
 * Predicate: is `next` a continuation of the block whose first line is
 * `firstLine`, most recently appended is `prevLine`, and accumulated
 * bracket balance is `openBrackets`?
 *
 * Continuation when ANY of:
 *  - `openBrackets > 0` — we are inside an open `{` / `[` / `(` span that
 *    started earlier in the block. This catches column-0 close braces.
 *  - `next` (after prefix strip) starts with whitespace — indented dump.
 *  - `prevLine` ends with `{ [ ( ,` — opener / trailing comma cue.
 *
 * Anti-continuation when:
 *  - Role prefix differs from the block's first line (different worker).
 *  - `next` is empty AND we're not inside an open bracket span.
 */
function isContinuation(
  firstLine: string,
  prevLine: string,
  next: string,
  openBrackets: number,
): boolean {
  if (!next.trim()) return false
  const [firstPrefix] = splitRolePrefix(firstLine)
  const [nextPrefix, nextBody] = splitRolePrefix(next)
  if (firstPrefix !== nextPrefix) return false

  // Indent → continuation.
  if (/^[\s\t]/.test(nextBody)) return true

  // Previous line ends with opener / trailing comma → continuation.
  const [, prevBody] = splitRolePrefix(prevLine)
  if (/[{[(,]\s*$/.test(prevBody)) return true

  // Closing bracket at column 0 while we still have an open span → pull it
  // in so the multi-line object dump captures its own closer. We DON'T
  // unconditionally treat "anything while balance > 0" as a continuation:
  // a dangling `{` from a printed string shouldn't drag every later log
  // into the same entry.
  if (openBrackets > 0 && /^[)\]}]/.test(nextBody)) return true

  return false
}

export function coalesceLogLines(rawLines: string[]): CoalescedEntry[] {
  const out: CoalescedEntry[] = []
  let i = 0
  while (i < rawLines.length) {
    const first = rawLines[i]
    if (!first.trim()) {
      i++
      continue
    }

    const block: string[] = [first]
    const levels: LogLevel[] = [detectLevel(first)]
    let openBrackets = Math.max(0, bracketDelta(first))
    let j = i + 1

    while (j < rawLines.length && block.length < MAX_COALESCED_LINES) {
      const next = rawLines[j]
      const prev = block[block.length - 1]
      if (!isContinuation(first, prev, next, openBrackets)) break
      block.push(next)
      levels.push(detectLevel(next))
      openBrackets = Math.max(0, openBrackets + bracketDelta(next))
      j++
    }

    out.push({
      text: block.join('\n'),
      level: maxLevel(levels),
      rawLines: block,
    })
    i = j
  }
  return out
}
