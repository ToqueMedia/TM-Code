/**
 * cat -n style line numbering for read_file output.
 *
 * Mirrors claude-vaz `utils/file.ts` addLineNumbers. The model relies on
 * these 1-indexed line numbers to target offset/limit and edit_file ranges.
 * Without them (the TM's prior behaviour), the model had to count lines
 * mentally to pick an offset — parity with the Claude Code Read tool means
 * numbering every line.
 *
 * Format (claude-vaz default, non-compact):
 *   - line number right-padded to width 6, then `→`, then the line text.
 *   - once the number string itself reaches 6 chars (>= 1_000_000 lines),
 *     no padding is applied.
 *
 *   "     1→first line"
 *   "    10→tenth line"
 *   "123456→pastamillion"
 */
export function addLineNumbers(content: string, startLine: number): string {
  if (!content) {
    return ''
  }

  const lines = content.split(/\r?\n/)
  return lines
    .map((line, index) => {
      const numStr = String(index + startLine)
      if (numStr.length >= 6) {
        return `${numStr}→${line}`
      }
      return `${numStr.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}
