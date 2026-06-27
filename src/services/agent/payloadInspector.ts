/**
 * Payload Inspector — token-cost diagnostics for the agent loop.
 *
 * Called once per LLM request (inside query.ts, right before
 * `client.chat.completions.create`) to produce a structured report of
 * everything that is about to be billed as input tokens. The report is
 * written to console.debug (visible in Tauri DevTools, which ship enabled
 * even in release builds) and kept in an in-memory ring buffer that the UI
 * or a debug export can read later.
 *
 * WHY THIS EXISTS
 * ─────────────
 * A simple task generated ~1.097.970 input tokens against Claude even
 * though the UI showed only ~66.9k for the "current request". The visible
 * session had 2 messages but the agent ran many internal tool calls. Each
 * turn of the agent loop re-sends the FULL cumulative history (assistant
 * text + tool_call args + tool_result bodies) to the provider. The UI pill
 * shows the LAST turn; the billing meter sums EVERY turn. When tool-result
 * bodies are large (read_file of a 20 KB file, a tsc log, a search dump)
 * and stay in the sliding window that microcompact keeps, the cumulative
 * cost balloons even though no single request looks alarming.
 *
 * This inspector makes that inflation visible per-turn: it breaks the
 * payload down by category, lists the biggest blocks, hashes them to
 * surface duplicates (the same file read twice, the same diff re-sent),
 * and sizes every tool_result so we can point at the exact line that
 * bloated the prompt.
 *
 * The inspector NEVER throws and NEVER blocks the request. It is pure
 * read-only analysis that runs synchronously before the fetch. If anything
 * goes wrong it logs a one-line warning and returns.
 */

// ── Token estimate (matches compact/autoCompact.ts roughTokenEstimate) ──
// ceil(length / 3) — the project's existing heuristic. Keeping it identical
// means the inspector's numbers line up with what autoCompact sees.
function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 3)
}

// ── FNV-1a 32-bit hash ──
// Cheap, collision-resistant enough for duplicate detection across a single
// payload. Not cryptographic — we only need to spot "this exact block
// appears N times". Hex string so it's log-friendly.
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // Force unsigned and to hex
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ── Types ──

type AnyMessage = Record<string, unknown>

interface BlockInfo {
  /** Index in the apiMessages array (for cross-referencing). */
  messageIndex: number
  role: string
  /** Block kind: system, user-text, assistant-text, thinking, tool_call, tool_result, tool-role. */
  kind: string
  /** Estimated tokens for THIS block. */
  tokens: number
  /** Char length of the serialized content. */
  chars: number
  /** FNV-1a hash of the content (for duplicate detection). */
  hash: string
  /** First 160 chars for identification (never the full body — secrets stay out of logs). */
  preview: string
  /** For tool_result: the tool_call_id it answers (lets us pair call↔result). */
  toolCallId?: string
  /** For tool_call: the tool name. */
  toolName?: string
}

export interface PayloadReport {
  /** Wall-clock of the request (ms since epoch). */
  timestamp: number
  /** Agent loop turn number (1-based). */
  turn: number
  /** Model id the payload is sent to. */
  model: string
  /** Total messages in the apiMessages array. */
  totalMessages: number
  /** Estimated input tokens for the whole payload (system + all messages + tool defs). */
  totalEstimatedTokens: number
  /** Estimated tokens contributed by the system prompt. */
  systemPromptTokens: number
  /** Estimated tokens contributed by the tool definitions (schemas). */
  toolDefsTokens: number
  /** Number of tool definitions sent in THIS request (after dynamic selection). */
  toolCount: number
  /** Total tools available (before dynamic selection). Equal to toolCount when no selector is active. */
  toolCountTotal: number
  /** Breakdown by category. */
  byCategory: Record<string, { blocks: number; tokens: number; chars: number }>
  /** The 10 largest blocks, sorted desc. */
  topBlocks: BlockInfo[]
  /** Blocks whose content hash appears more than once (re-sent duplicates). */
  duplicates: Array<{ hash: string; count: number; tokens: number; preview: string }>
  /** One entry per tool_result block in the payload, in order. */
  toolResults: Array<{ messageIndex: number; toolCallId: string; tokens: number; chars: number; hash: string; preview: string }>
}

// ── Ring buffer (last 50 reports) ──
// Survives in-memory for the session. A debug export or DevTools snippet can
// read `getRecentReports()` at any time. Not persisted to disk by default to
// avoid writing secrets-adjacent data; the console.debug output is the
// primary channel and DevTools preserves it.
const REPORT_RING: PayloadReport[] = []
const RING_MAX = 50

export function getRecentReports(): readonly PayloadReport[] {
  return REPORT_RING
}

// ── Core analysis ──

/**
 * Extract a preview string (first 160 chars, single-line) from arbitrary content.
 * Never includes the full body — keeps secrets and large blobs out of logs.
 */
function previewOf(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 160 ? single.slice(0, 157) + '...' : single
}

/** Serialize a content block to a string for sizing/hashing. */
function blockContent(block: AnyMessage): { text: string; kind: string; toolCallId?: string; toolName?: string } {
  const type = block.type as string | undefined
  if (type === 'text') {
    return { text: (block.text as string) ?? '', kind: 'text' }
  }
  if (type === 'thinking') {
    return { text: (block.thinking as string) ?? '', kind: 'thinking' }
  }
  if (type === 'tool_result') {
    return {
      text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      kind: 'tool_result',
      toolCallId: block.toolCallId as string | undefined,
    }
  }
  if (type === 'tool_call') {
    const name = (block.name as string) ?? ''
    const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.input ?? {})
    return { text: `${name}(${args})`, kind: 'tool_call', toolName: name }
  }
  if (type === 'image_url') {
    const url = (block.image_url as AnyMessage)?.url as string | undefined
    // Don't hash the base64 body — just note it's an image and its URL length.
    return { text: `[image_url: ${(url ?? '').length} chars]`, kind: 'image_url' }
  }
  // Unknown block type — serialize minimally
  return { text: JSON.stringify(block), kind: type ?? 'unknown' }
}

/**
 * Build the full report for a payload about to be sent to the provider.
 *
 * @param apiMessages  The OpenAI-formatted message array (output of toOpenAIMessages).
 *                     Accepts `readonly unknown[]` so callers don't need to cast
 *                     away the SDK's nominal `ChatCompletionMessageParam` union.
 * @param systemPrompt The system prompt string (already prepended in apiMessages as role:system,
 *                     but passed separately so we can attribute it).
 * @param tools        The tool definitions array (for sizing the schemas).
 * @param model        The model id.
 * @param turn         The agent loop turn number (1-based).
 * @param totalToolCount  Total tools available before dynamic selection (for the N/total log).
 */
export function inspectPayload(
  apiMessages: readonly unknown[],
  systemPrompt: string | undefined,
  tools: { type?: string; function?: unknown }[] | undefined,
  model: string,
  turn: number,
  totalToolCount?: number,
): PayloadReport {
  const messages = apiMessages as AnyMessage[]
  const blocks: BlockInfo[] = []
  const byCategory: Record<string, { blocks: number; tokens: number; chars: number }> = {}

  const tally = (kind: string, chars: number) => {
    if (!byCategory[kind]) byCategory[kind] = { blocks: 0, tokens: 0, chars: 0 }
    byCategory[kind].blocks++
    byCategory[kind].tokens += Math.ceil(chars / 3)
    byCategory[kind].chars += chars
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const role = (msg.role as string) ?? 'unknown'

    // role:tool is the OpenAI flat tool-result message
    if (role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
      const hash = fnv1aHex(content)
      blocks.push({
        messageIndex: i,
        role,
        kind: 'tool_result',
        tokens: roughTokenEstimate(content),
        chars: content.length,
        hash,
        preview: previewOf(content),
        toolCallId: msg.tool_call_id as string | undefined,
      })
      tally('tool_result', content.length)
      continue
    }

    // role:system
    if (role === 'system') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
      blocks.push({
        messageIndex: i,
        role,
        kind: 'system',
        tokens: roughTokenEstimate(content),
        chars: content.length,
        hash: fnv1aHex(content),
        preview: previewOf(content),
      })
      tally('system', content.length)
      continue
    }

    // role:user or role:assistant — content can be string or array of parts
    const content = msg.content
    if (typeof content === 'string' || content === null || content === undefined) {
      const text = (content as string) ?? ''
      const kind = role === 'assistant' ? 'assistant-text' : 'user-text'
      blocks.push({
        messageIndex: i,
        role,
        kind,
        tokens: roughTokenEstimate(text),
        chars: text.length,
        hash: fnv1aHex(text),
        preview: previewOf(text),
      })
      tally(kind, text.length)
      continue
    }

    if (Array.isArray(content)) {
      for (const block of content as AnyMessage[]) {
        const { text, kind, toolCallId, toolName } = blockContent(block)
        const category = role === 'assistant'
          ? (kind === 'tool_call' ? 'tool_call' : kind === 'thinking' ? 'thinking' : 'assistant-text')
          : (kind === 'tool_result' ? 'tool_result' : kind === 'image_url' ? 'image_url' : 'user-text')
        blocks.push({
          messageIndex: i,
          role,
          kind: category,
          tokens: roughTokenEstimate(text),
          chars: text.length,
          hash: fnv1aHex(text),
          preview: previewOf(text),
          toolCallId,
          toolName,
        })
        tally(category, text.length)
      }
      continue
    }

    // Fallback: unknown content shape
    const text = JSON.stringify(content)
    blocks.push({
      messageIndex: i,
      role,
      kind: 'unknown',
      tokens: roughTokenEstimate(text),
      chars: text.length,
      hash: fnv1aHex(text),
      preview: previewOf(text),
    })
    tally('unknown', text.length)
  }

  // Tool definitions (schemas sent as the `tools` param)
  let toolDefsTokens = 0
  if (tools && tools.length > 0) {
    for (const t of tools) {
      const fn = t.function ?? t
      const serialized = JSON.stringify(fn)
      toolDefsTokens += roughTokenEstimate(serialized)
    }
  }

  const systemPromptTokens = systemPrompt ? roughTokenEstimate(systemPrompt) : 0
  const totalEstimatedTokens =
    systemPromptTokens +
    toolDefsTokens +
    Object.values(byCategory).reduce((sum, c) => sum + c.tokens, 0)

  // Top 10 largest blocks
  const topBlocks = [...blocks].sort((a, b) => b.tokens - a.tokens).slice(0, 10)

  // Duplicate detection — group by hash, report those with count > 1
  const byHash = new Map<string, BlockInfo[]>()
  for (const b of blocks) {
    const arr = byHash.get(b.hash) ?? []
    arr.push(b)
    byHash.set(b.hash, arr)
  }
  const duplicates: PayloadReport['duplicates'] = []
  for (const [hash, arr] of byHash) {
    if (arr.length > 1) {
      duplicates.push({
        hash,
        count: arr.length,
        tokens: arr[0].tokens * arr.length,
        preview: arr[0].preview,
      })
    }
  }
  duplicates.sort((a, b) => b.tokens - a.tokens)

  // Tool results list
  const toolResults: PayloadReport['toolResults'] = blocks
    .filter((b) => b.kind === 'tool_result')
    .map((b) => ({
      messageIndex: b.messageIndex,
      toolCallId: b.toolCallId ?? '(none)',
      tokens: b.tokens,
      chars: b.chars,
      hash: b.hash,
      preview: b.preview,
    }))

  const report: PayloadReport = {
    timestamp: Date.now(),
    turn,
    model,
    totalMessages: messages.length,
    totalEstimatedTokens,
    systemPromptTokens,
    toolDefsTokens,
    toolCount: tools?.length ?? 0,
    toolCountTotal: totalToolCount ?? tools?.length ?? 0,
    byCategory,
    topBlocks,
    duplicates,
    toolResults,
  }

  // Ring buffer
  REPORT_RING.push(report)
  if (REPORT_RING.length > RING_MAX) REPORT_RING.shift()

  return report
}

/**
 * Format a report for console.debug output. Compact but complete — one
 * header line, a category table, the top-10 table, duplicates (if any),
 * and the tool-result sizes. Designed to be grepped in DevTools via
 * `[payload-inspector]`.
 */
export function formatReportForConsole(report: PayloadReport): string {
  const lines: string[] = []
  const turn = report.turn

  lines.push(
    `[payload-inspector] turn ${turn} | model=${report.model} | ` +
    `${report.totalMessages} msgs | ~${report.totalEstimatedTokens.toLocaleString()} input tokens ` +
    `(system=${report.systemPromptTokens.toLocaleString()}, tools=${report.toolCount}/${report.toolCountTotal}=${report.toolDefsTokens.toLocaleString()}t)` +
    (report.toolCount < report.toolCountTotal ? ' ↓' : ''),
  )

  // Category breakdown
  const catEntries = Object.entries(report.byCategory).sort((a, b) => b[1].tokens - a[1].tokens)
  const catRow = catEntries
    .map(([k, v]) => `${k}:${v.tokens.toLocaleString()}t(${v.blocks}b/${(v.chars / 1024).toFixed(1)}KB)`)
    .join('  ')
  lines.push(`  categories: ${catRow}`)

  // Top 10 blocks
  if (report.topBlocks.length > 0) {
    lines.push(`  top blocks:`)
    for (let i = 0; i < report.topBlocks.length; i++) {
      const b = report.topBlocks[i]
      const dup = report.duplicates.find((d) => d.hash === b.hash)
      const dupTag = dup ? ` ×${dup.count}` : ''
      lines.push(
        `    #${i + 1} msg[${b.messageIndex}] ${b.role}/${b.kind}` +
        `${b.toolName ? `(${b.toolName})` : ''}${dupTag} ` +
        `~${b.tokens.toLocaleString()}t ${b.chars.toLocaleString()}c ` +
        `hash=${b.hash} "${b.preview}"`,
      )
    }
  }

  // Duplicates
  if (report.duplicates.length > 0) {
    lines.push(`  duplicates (re-sent blocks):`)
    for (const d of report.duplicates) {
      lines.push(
        `    hash=${d.hash} ×${d.count} ~${d.tokens.toLocaleString()}t total "${d.preview}"`,
      )
    }
  }

  // Tool results
  if (report.toolResults.length > 0) {
    const totalToolResultTokens = report.toolResults.reduce((s, t) => s + t.tokens, 0)
    lines.push(
      `  tool_results: ${report.toolResults.length} blocks, ~${totalToolResultTokens.toLocaleString()}t total`,
    )
    for (const tr of report.toolResults) {
      lines.push(
        `    msg[${tr.messageIndex}] id=${tr.toolCallId} ~${tr.tokens.toLocaleString()}t ${tr.chars.toLocaleString()}c "${tr.preview}"`,
      )
    }
  }

  return lines.join('\n')
}

/**
 * Convenience: inspect + log in one call. This is the function query.ts
 * calls before every `client.chat.completions.create`. Best-effort —
 * never throws.
 */
export function inspectAndLogPayload(
  apiMessages: readonly unknown[],
  systemPrompt: string | undefined,
  tools: { type?: string; function?: unknown }[] | undefined,
  model: string,
  turn: number,
  totalToolCount?: number,
): PayloadReport | null {
  try {
    const report = inspectPayload(apiMessages, systemPrompt, tools, model, turn, totalToolCount)
    // eslint-disable-next-line no-console
    console.debug(formatReportForConsole(report))
    // Return the report so the caller (query.ts) can persist the per-request
    // breakdown alongside the real provider usage — eliminates inferring
    // consumption from compacted transcripts.
    return report
  } catch (err) {
    // Never block the request on a diagnostic failure.
    // eslint-disable-next-line no-console
    console.warn('[payload-inspector] failed (non-blocking):', err)
    return null
  }
}
