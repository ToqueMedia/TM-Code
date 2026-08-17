/**
 * Persistent-shell input — same command rules as cli-vaz Bash:
 *
 *   Independent steps: separate tool calls (parallel when they don't depend).
 *   Dependent steps: chain with `&&`. Use `;` only if earlier failure is fine.
 *   "DO NOT use newlines to separate commands (newlines are ok in
 *    quoted strings)."
 *
 * Heredoc bodies (`python3 - <<'PY'` … `PY`) are the same class of data
 * as a quoted string.
 */

const WORD = /[\w]/

export function validatePersistentShellInput(data: string): string {
  const command = data.replace(/\n+$/g, '').trim()
  if (!command) throw new Error('Agent shell input cannot be empty.')

  const skeleton = stripQuotedAndHeredocRegions(command)
  if (/[\n\r]/.test(skeleton)) {
    throw new Error(
      'Do not use newlines to separate commands (newlines are ok in quoted strings and heredocs). Chain dependent steps with &&, or use ; if you do not care whether earlier steps fail.',
    )
  }
  return command
}

/**
 * Replace quoted spans and heredoc bodies with spaces so remaining
 * newlines are the ones that actually start another command.
 */
export function stripQuotedAndHeredocRegions(command: string): string {
  const out: string[] = []
  let i = 0
  let quote: '"' | "'" | null = null

  while (i < command.length) {
    const ch = command[i]!

    if (quote) {
      if (ch === '\\' && quote === '"') {
        out.push(' ')
        i++
        if (i < command.length) { out.push(' '); i++ }
        continue
      }
      if (ch === quote) {
        quote = null
        out.push(ch)
        i++
        continue
      }
      out.push(ch === '\n' || ch === '\r' ? ' ' : ch)
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      out.push(ch)
      i++
      continue
    }

    if (ch === '\\') {
      const next = command[i + 1]
      if (next === '\n' || next === '\r') {
        out.push(' ')
        i += 2
        if (next === '\r' && command[i] === '\n') { out.push(' '); i++ }
        continue
      }
      out.push(ch)
      i++
      if (i < command.length) {
        const escaped = command[i]!
        out.push(escaped === '\n' || escaped === '\r' ? ' ' : escaped)
        i++
      }
      continue
    }

    // `<<` / `<<-`, but not `<<<`.
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      out.push('<', '<')
      i += 2
      let stripLeadingTabs = false
      if (command[i] === '-') {
        stripLeadingTabs = true
        out.push('-')
        i++
      }
      while (command[i] === ' ' || command[i] === '\t') {
        out.push(command[i]!)
        i++
      }

      let delim = ''
      if (command[i] === "'" || command[i] === '"') {
        const q = command[i]!
        out.push(q)
        i++
        while (i < command.length && command[i] !== q && command[i] !== '\n' && command[i] !== '\r') {
          delim += command[i]
          out.push(command[i]!)
          i++
        }
        if (command[i] === q) { out.push(q); i++ }
      } else {
        if (command[i] === '\\') { out.push('\\'); i++ }
        while (i < command.length && WORD.test(command[i]!)) {
          delim += command[i]
          out.push(command[i]!)
          i++
        }
      }

      if (!delim) continue

      while (i < command.length && command[i] !== '\n' && command[i] !== '\r') {
        out.push(command[i]!)
        i++
      }
      if (command[i] === '\r') { out.push(' '); i++ }
      if (command[i] === '\n') { out.push(' '); i++ }

      while (i < command.length) {
        const lineStart = i
        let lineEnd = i
        while (lineEnd < command.length && command[lineEnd] !== '\n' && command[lineEnd] !== '\r') {
          lineEnd++
        }
        const line = command.slice(lineStart, lineEnd)
        const compare = stripLeadingTabs ? line.replace(/^\t+/, '') : line
        for (let k = lineStart; k < lineEnd; k++) out.push(' ')
        i = lineEnd
        if (compare === delim) break
        if (command[i] === '\r') { out.push(' '); i++ }
        if (command[i] === '\n') { out.push(' '); i++ }
      }
      continue
    }

    out.push(ch)
    i++
  }

  return out.join('')
}
