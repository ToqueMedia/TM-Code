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

import { splitOnBoundary } from './contextBuilder/helpers'

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
  /** Estimated tokens contributed by @mention synthetic context. */
  mentionContextTokens: number
  /** Largest system-prompt sections, split by static/cacheable vs dynamic. */
  systemPromptSections: PromptSectionInfo[]
  /** System-prompt sections that look like candidates for lazy/on-demand loading. */
  auxiliaryPromptCandidates: PromptSectionInfo[]
  /** Estimated tokens contributed by the tool definitions (schemas). */
  toolDefsTokens: number
  /**
   * Decomposition of `totalEstimatedTokens` by category, so an export can
   * prove the estimate is system + user + mention + assistant + tool_result
   * + tool_defs WITHOUT double-counting the system prompt. The message
   * role:system already lives in byCategory.system; systemPromptTokens is
   * kept as an attribute only and is NOT re-added to the total.
   */
  estimatedInputTokensBreakdown: {
    system: number
    userText: number
    mentionContext: number
    assistantText: number
    toolCall: number
    toolResult: number
    thinking: number
    toolDefs: number
    /** Sum of the above — equals totalEstimatedTokens. */
    total: number
  }
  /** Number of tool definitions sent in THIS request (after dynamic selection). */
  toolCount: number
  /** Total tools available (before dynamic selection). Equal to toolCount when no selector is active. */
  toolCountTotal: number
  /**
   * When the loop continued past the 3-4-request efficiency target, this
   * carries the inferred technical reason (e.g. "build/test error — fixing
   * cascade"). Surfaced so the session export + inspector log show WHY a
   * 7-turn bugfix kept going. Undefined when the turn is within target.
   */
  continuationReason?: string
  /** On-demand context architecture: estimated core-context tokens (system prompt minus loaded auxiliaries). */
  coreContextTokens: number
  /** Alias/export field for core system prompt tokens. */
  coreSystemTokens: number
  /** Tokens spent on the rendered on-demand index. */
  onDemandIndexTokens: number
  /** On-demand context architecture: estimated tokens of auxiliaries loaded inline. */
  auxiliaryContextTokens: number
  /** On-demand context architecture: auxiliaries loaded inline (id + name + reason). */
  auxiliaryLoaded: Array<{ id: string; name: string; reason: string; tokens: number }>
  /** Alias/export field for loaded inline system sections. */
  loadedSystemSections: string[]
  /** On-demand context architecture: auxiliaries omitted, available on-demand (id + name + reason + est tokens). */
  auxiliaryOmitted: Array<{ id: string; name: string; reason: string; estTokens: number }>
  /** Alias/export field for omitted system sections. */
  omittedSystemSections: string[]
  /** Auxiliary sections fetched through request_context in this run. */
  requestedContextSections: string[]
  /** On-demand context architecture: estimated savings vs loading all phase-1 auxiliaries. */
  auxiliarySavingsTokens: number
  /** Alias/export field for system prompt savings. */
  systemPromptSavingsTokens: number
  /** Human-readable reason for the selected prompt/system profile. */
  systemPromptProfileReason?: string
  /** Breakdown by category. */
  byCategory: Record<string, { blocks: number; tokens: number; chars: number }>
  /** The 10 largest blocks, sorted desc. */
  topBlocks: BlockInfo[]
  /** Blocks whose content hash appears more than once (re-sent duplicates). */
  duplicates: Array<{ hash: string; count: number; tokens: number; preview: string }>
  /** One entry per tool_result block in the payload, in order. */
  toolResults: Array<{ messageIndex: number; toolCallId: string; tokens: number; chars: number; hash: string; preview: string }>
}

export interface PromptSectionInfo {
  name: string
  location: 'static' | 'dynamic'
  tokens: number
  chars: number
  auxiliaryCandidate?: boolean
  reason?: string
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

function sectionName(text: string, fallback: string): string {
  const heading = text.match(/^#{1,3}\s+(.+?)$/m)
  return (heading?.[1] ?? fallback).replace(/\s+/g, ' ').trim().slice(0, 80)
}

function splitPromptSections(text: string, location: PromptSectionInfo['location']): PromptSectionInfo[] {
  const starts: number[] = []
  const headingRe = /^#{1,2}\s+.+$/gm
  let match: RegExpExecArray | null
  while ((match = headingRe.exec(text)) !== null) starts.push(match.index)
  if (starts.length === 0) {
    const trimmed = text.trim()
    return trimmed
      ? [{ name: sectionName(trimmed, '(system prelude)'), location, chars: trimmed.length, tokens: roughTokenEstimate(trimmed) }]
      : []
  }

  const sections: PromptSectionInfo[] = []
  if (starts[0] > 0) {
    const prelude = text.slice(0, starts[0]).trim()
    if (prelude) {
      sections.push({
        name: sectionName(prelude, '(system prelude)'),
        location,
        chars: prelude.length,
        tokens: roughTokenEstimate(prelude),
      })
    }
  }

  for (let i = 0; i < starts.length; i++) {
    const chunk = text.slice(starts[i], starts[i + 1] ?? text.length).trim()
    if (!chunk) continue
    sections.push({
      name: sectionName(chunk, `(section ${i + 1})`),
      location,
      chars: chunk.length,
      tokens: roughTokenEstimate(chunk),
    })
  }
  return sections
}

function auxiliaryReason(name: string): string | undefined {
  const n = name.toLowerCase()
  if (n.includes('scaffolding workflow') || n.includes('installing dependencies')) {
    return 'Only needed for new-project scaffolding or multi-package installs; bugfix/read-only turns can fetch this protocol on demand.'
  }
  if (n.includes('publishing') || n.includes('database') || n.includes('file uploads')) {
    return 'Publish/platform guidance is domain-specific; load when deploy, DB, file upload, auth, or platform provisioning is requested.'
  }
  if (n.includes('ui baseline') || n.includes('taste defaults')) {
    return 'Frontend/visual guidance is valuable for UI work but unnecessary for backend, git, config, or analysis-only tasks.'
  }
  if (n.includes('vision')) {
    return 'Image handling rules only matter when the request includes image/vision input.'
  }
  if (n.includes('authentication')) {
    return 'Auth rules can be loaded when auth hashtags, auth files, or auth-related user intent are present.'
  }
  if (n.includes('mcp tools')) {
    return 'MCP routing can stay as a compact index; detailed usage can be fetched when a matching MCP is selected.'
  }
  if (n.includes('skills')) {
    return 'Skills are already intended as on-demand content; keep only names/descriptions until read_skill is called.'
  }
  if (n.includes('project structure') || n.includes('recently modified files')) {
    return 'Project orientation can often be summarized; full detail is recoverable through list/search/read tools.'
  }
  if (n.includes('readme') || n.includes('project memory') || n.includes('task list')) {
    return 'Project documents are mutable context; consider indexing/summarizing and loading full bodies only when task-relevant.'
  }
  if (n.includes('background commands') || n.includes('active team')) {
    return 'Live auxiliary state is useful only when active; omit or keep as a one-line index otherwise.'
  }
  return undefined
}

function analyzeSystemPrompt(systemPrompt: string | undefined): {
  systemPromptSections: PromptSectionInfo[]
  auxiliaryPromptCandidates: PromptSectionInfo[]
} {
  if (!systemPrompt) return { systemPromptSections: [], auxiliaryPromptCandidates: [] }
  const split = splitOnBoundary(systemPrompt)
  const sections = [
    ...splitPromptSections(split.staticPrefix, 'static'),
    ...splitPromptSections(split.dynamicSuffix, 'dynamic'),
  ].map(section => {
    const reason = auxiliaryReason(section.name)
    return reason
      ? { ...section, auxiliaryCandidate: true, reason }
      : section
  })

  const bySize = [...sections].sort((a, b) => b.tokens - a.tokens)
  return {
    systemPromptSections: bySize.slice(0, 30),
    auxiliaryPromptCandidates: bySize.filter(s => s.auxiliaryCandidate).slice(0, 15),
  }
}

function isMentionContextReminder(text: string): boolean {
  return (
    /Called the (read_file|list_directory) tool with the following input:/.test(text) ||
    /Result of calling the (read_file|list_directory) tool:/.test(text) ||
    /@mention compact_reference/.test(text) ||
    /alreadyProvided:\s*true[\s\S]*mentionContextRefId|mentionContextRefId[\s\S]*alreadyProvided:\s*true/.test(text) ||
    /Mentioned file summary \(@mention compacted; full content was NOT injected\)/.test(text) ||
    /via @-mention/.test(text)
  )
}

function splitMentionContext(text: string): Array<{ text: string; kind: 'mention_context' | 'text' }> {
  const out: Array<{ text: string; kind: 'mention_context' | 'text' }> = []
  const re = /<system-reminder>[\s\S]*?<\/system-reminder>/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), kind: 'text' })
    const reminder = match[0]
    out.push({ text: reminder, kind: isMentionContextReminder(reminder) ? 'mention_context' : 'text' })
    last = match.index + reminder.length
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'text' })
  return out.filter(part => part.text.length > 0)
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
 * @param continuationReason  When the loop is past the efficiency target, the inferred reason.
 */
export function inspectPayload(
  apiMessages: readonly unknown[],
  systemPrompt: string | undefined,
  tools: { type?: string; function?: unknown }[] | undefined,
  model: string,
  turn: number,
  totalToolCount?: number,
  continuationReason?: string,
  auxiliarySelection?: import('./contextBuilder/auxiliaryRegistry').AuxiliarySelection,
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
      const parts = role === 'user' ? splitMentionContext(text) : [{ text, kind: 'text' as const }]
      for (const part of parts) {
        const blockKind = part.kind === 'mention_context' ? 'mention_context' : kind
        blocks.push({
          messageIndex: i,
          role,
          kind: blockKind,
          tokens: roughTokenEstimate(part.text),
          chars: part.text.length,
          hash: fnv1aHex(part.text),
          preview: previewOf(part.text),
        })
        tally(blockKind, part.text.length)
      }
      continue
    }

    if (Array.isArray(content)) {
      for (const block of content as AnyMessage[]) {
        const { text, kind, toolCallId, toolName } = blockContent(block)
        if (role === 'user' && kind === 'text') {
          for (const part of splitMentionContext(text)) {
            const category = part.kind === 'mention_context' ? 'mention_context' : 'user-text'
            blocks.push({
              messageIndex: i,
              role,
              kind: category,
              tokens: roughTokenEstimate(part.text),
              chars: part.text.length,
              hash: fnv1aHex(part.text),
              preview: previewOf(part.text),
            })
            tally(category, part.text.length)
          }
          continue
        }
        const category = role === 'user' && kind === 'text' && isMentionContextReminder(text)
          ? 'mention_context'
          : role === 'assistant'
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
  const { systemPromptSections, auxiliaryPromptCandidates } = analyzeSystemPrompt(systemPrompt)
  const mentionContextTokens = byCategory.mention_context?.tokens ?? 0
  // NOTE: the system prompt travels inside apiMessages as a role:system
  // message, so byCategory.system ALREADY accounts for it. Adding
  // systemPromptTokens on top double-counts it — confirmed against the
  // exported session (turn 1: breakdown.system=21790 + systemPromptTokens
  // 21790 + tool_defs 2010 + user/mention 3291 == 48891 == the old buggy
  // estimate, ~29K above the real inputTokens). We now sum byCategory
  // (which includes system) + tool_defs only, and keep systemPromptTokens
  // as an attribute for reference.
  const estimatedInputTokensBreakdown = {
    system: byCategory.system?.tokens ?? 0,
    userText: byCategory['user-text']?.tokens ?? 0,
    mentionContext: byCategory.mention_context?.tokens ?? 0,
    assistantText: byCategory['assistant-text']?.tokens ?? 0,
    toolCall: byCategory.tool_call?.tokens ?? 0,
    toolResult: byCategory.tool_result?.tokens ?? 0,
    thinking: byCategory.thinking?.tokens ?? 0,
    toolDefs: toolDefsTokens,
    total: 0,
  }
  estimatedInputTokensBreakdown.total =
    estimatedInputTokensBreakdown.system +
    estimatedInputTokensBreakdown.userText +
    estimatedInputTokensBreakdown.mentionContext +
    estimatedInputTokensBreakdown.assistantText +
    estimatedInputTokensBreakdown.toolCall +
    estimatedInputTokensBreakdown.toolResult +
    estimatedInputTokensBreakdown.thinking +
    estimatedInputTokensBreakdown.toolDefs
  const totalEstimatedTokens = estimatedInputTokensBreakdown.total

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

  // On-demand context architecture breakdown. The system prompt INCLUDES the
  // loaded auxiliaries inline, so core = systemPromptTokens − loaded auxiliary
  // tokens. auxiliaryContextTokens is the inline-loaded auxiliary cost;
  // auxiliarySavingsTokens is what was saved vs loading ALL phase-1 auxiliaries.
  const auxiliaryLoaded = auxiliarySelection?.loaded ?? []
  const auxiliaryOmitted = auxiliarySelection?.omitted ?? []
  const auxiliaryContextTokens = auxiliarySelection?.loadedTokens ?? 0
  const auxiliarySavingsTokens = auxiliarySelection?.savingsTokens ?? 0
  const coreContextTokens = Math.max(0, systemPromptTokens - auxiliaryContextTokens)
  const onDemandIndexMatch = systemPrompt?.match(
    /# Auxiliary context \(on-demand\)[\s\S]*?(?=\n# |\n__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__|$)/,
  )
  const onDemandIndexTokens = onDemandIndexMatch
    ? roughTokenEstimate(onDemandIndexMatch[0])
    : 0
  const loadedSystemSections = auxiliaryLoaded.map((a) => a.id)
  const omittedSystemSections = auxiliaryOmitted.map((a) => a.id)
  const requestedContextSections = auxiliarySelection?.requestedContextSections ?? []

  const report: PayloadReport = {
    timestamp: Date.now(),
    turn,
    model,
    totalMessages: messages.length,
    totalEstimatedTokens,
    systemPromptTokens,
    mentionContextTokens,
    systemPromptSections,
    auxiliaryPromptCandidates,
    toolDefsTokens,
    estimatedInputTokensBreakdown,
    toolCount: tools?.length ?? 0,
    toolCountTotal: totalToolCount ?? tools?.length ?? 0,
    continuationReason,
    coreContextTokens,
    coreSystemTokens: coreContextTokens,
    onDemandIndexTokens,
    auxiliaryContextTokens,
    auxiliaryLoaded,
    loadedSystemSections,
    auxiliaryOmitted,
    omittedSystemSections,
    requestedContextSections,
    auxiliarySavingsTokens,
    systemPromptSavingsTokens: auxiliarySavingsTokens,
    systemPromptProfileReason: auxiliarySelection?.reason,
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
  // Continuation reason — surfaced when the loop is past the 3-4-request
  // efficiency target so a 7-turn bugfix leaves a forensic trail of WHY.
  if (report.continuationReason) {
    lines.push(`  turn-efficiency: ${report.continuationReason}`)
  }

  // Category breakdown
  const catEntries = Object.entries(report.byCategory).sort((a, b) => b[1].tokens - a[1].tokens)
  const catRow = catEntries
    .map(([k, v]) => `${k}:${v.tokens.toLocaleString()}t(${v.blocks}b/${(v.chars / 1024).toFixed(1)}KB)`)
    .join('  ')
  lines.push(`  categories: ${catRow}`)

  if (report.systemPromptSections.length > 0) {
    const systemRow = report.systemPromptSections
      .slice(0, 8)
      .map(s => `${s.location}:${s.name}${s.auxiliaryCandidate ? '*' : ''}:${s.tokens.toLocaleString()}t`)
      .join('  ')
    lines.push(`  system_sections: ${systemRow}`)
  }

  // On-demand context architecture: which auxiliaries loaded inline vs.
  // omitted (available via request_context). Lets you see the savings per
  // turn in DevTools without opening the full export.
  if (report.auxiliaryLoaded.length > 0 || report.auxiliaryOmitted.length > 0) {
    const loadedIds = report.auxiliaryLoaded.map((l) => l.id).join(',') || '(none)'
    const omittedIds = report.auxiliaryOmitted.map((o) => o.id).join(',') || '(none)'
    lines.push(
      `  auxiliary: core=${report.coreContextTokens.toLocaleString()}t aux=${report.auxiliaryContextTokens.toLocaleString()}t ` +
      `loaded=[${loadedIds}] omitted=[${omittedIds}] savings=${report.auxiliarySavingsTokens.toLocaleString()}t`,
    )
  }

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
  continuationReason?: string,
  auxiliarySelection?: import('./contextBuilder/auxiliaryRegistry').AuxiliarySelection,
): PayloadReport | null {
  try {
    const report = inspectPayload(apiMessages, systemPrompt, tools, model, turn, totalToolCount, continuationReason, auxiliarySelection)
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
