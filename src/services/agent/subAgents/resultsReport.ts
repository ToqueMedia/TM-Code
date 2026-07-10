// Shared formatter for team (sub-agent) results — used by BOTH the
// collect_results tool and the push-delivery path (autoWake/steering), so the
// model sees one consistent shape no matter how results reach it.
//
// Pure: callers pass the summaries in; no store access here.

export interface TeamRunSummaryLike {
  id: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'error' | 'timeout' | 'aborted'
  /** Milliseconds. */
  duration: number
  toolCallCount: number
  tokenUsage?: { input: number; output: number } | null
  errorText?: string | null
  finalText?: string | null
}

export interface TeamResultsReport {
  text: string
  runningCount: number
  /** Ids of the non-running, non-aborted runs included in the report. */
  finishedIds: string[]
}

const STATUS_ICON: Record<TeamRunSummaryLike['status'], string> = {
  completed: '✅',
  error: '❌',
  timeout: '⏰',
  aborted: '🛑',
  running: '⏳',
}

export function buildTeamResultsReport(
  summaries: TeamRunSummaryLike[],
  opts: {
    /** Include still-running entries (collect_results does; push delivery doesn't need to). */
    includeRunning?: boolean
    /** Cap each run's finalText (push delivery bounds its payload; the tool doesn't). */
    perRunCharCap?: number
    /** Optional "last action" enricher for running rows (tool-only detail). */
    lastActionFor?: (id: string) => string | null
  } = {},
): TeamResultsReport {
  const { includeRunning = true, perRunCharCap, lastActionFor } = opts
  const lines: string[] = ['## Team Results\n']
  const finishedIds: string[] = []
  let runningCount = 0

  for (const s of summaries) {
    const duration = (s.duration / 1000).toFixed(0)
    const icon = STATUS_ICON[s.status]

    if (s.status === 'running') {
      runningCount++
      if (!includeRunning) continue
      const lastAction = lastActionFor?.(s.id)
      lines.push(
        `### ${icon} ${s.agentType}: "${s.description}" — still running (${duration}s, ${s.toolCallCount} tool calls so far${lastAction ? ` — last action: ${lastAction}` : ''})`,
      )
      lines.push('')
      continue
    }

    if (s.status === 'aborted') {
      lines.push(`### ${icon} ${s.agentType}: "${s.description}" (${duration}s, ${s.toolCallCount} tool calls)`)
      lines.push('Task was aborted.')
      lines.push('')
      continue
    }

    finishedIds.push(s.id)
    lines.push(`### ${icon} ${s.agentType}: "${s.description}" (${duration}s, ${s.toolCallCount} tool calls)`)
    if (s.tokenUsage) {
      lines.push(`Tokens: ${s.tokenUsage.input.toLocaleString()} in / ${s.tokenUsage.output.toLocaleString()} out`)
    }
    if (s.status === 'error' && s.errorText) {
      lines.push(`Error: ${s.errorText}`)
    } else if (s.finalText) {
      const text =
        perRunCharCap && s.finalText.length > perRunCharCap
          ? `${s.finalText.slice(0, perRunCharCap)}\n[... truncated — call collect_results for the full text]`
          : s.finalText
      lines.push(text)
    }
    lines.push('')
  }

  return { text: lines.join('\n'), runningCount, finishedIds }
}
