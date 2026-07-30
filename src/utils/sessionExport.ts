/**
 * Session export — serializes a chat session (messages + tool calls +
 * reasoning + attachments metadata + provider snapshot) into JSON or Markdown
 * for offline review, bug reports, and agent debugging.
 *
 * Two layers:
 *   1. Session data (always sync, already in memory): messages, tool calls,
 *      diffs, BYOK provider snapshot, project path, timestamps, token totals.
 *   2. Environment snapshot (async, optional): the system prompt the agent
 *      WOULD see RIGHT NOW (re-built via contextBuilder), current TMS/PLAN/
 *      TODO contents, available skills, hashtag detection of the latest user
 *      message. Labelled "at export time" because state may have drifted from
 *      what each turn saw — but it's the closest reproduction of the agent's
 *      context without persisting full prompts per-turn (which would 10x
 *      session disk usage).
 *
 * Strips base64 image data from attachments to keep file sizes manageable
 * (a single screenshot can blow the export from 10KB to 5MB).
 */

import type { ChatSession, ChatMessage, ToolCallDisplay, Attachment, ByokSessionSnapshot, RequestUsageEntry } from '../types/chat'
import { getPromptSerializeStats } from '../services/agent/promptSerialize'
import { t } from '@/i18n'

/**
 * Environment context captured at export time. Reconstructed via the same
 * services the live agent uses, so the debugger sees what the agent would
 * see if it ran a new turn NOW. Build via `buildEnvironmentSnapshot()`.
 *
 * Intentionally NOT duplicated here: TMS.md, PLAN.md, TODO.md content and
 * the package.json summary. Those are already embedded inside `systemPrompt`
 * via the live contextBuilder sections (getProjectMemorySection,
 * getActivePlanSection, getTaskListSection, getEnvironmentSection). Adding
 * them as separate fields doubled the export payload for no extra debug
 * value — they're searchable inside the prompt block anyway.
 */
export interface EnvironmentSnapshot {
  /** ISO timestamp this snapshot was taken. */
  capturedAt: string
  /** System prompt the agent would receive on a fresh turn. Large (10-50KB).
   *  Captures all the sticky-skill + hashtag-driven content + TMS/PLAN/TODO
   *  + package summary. May differ from per-turn prompts if project state
   *  changed since send-time. */
  systemPrompt?: string
  /** Why the systemPrompt is missing, when it is — e.g. "no active project". */
  systemPromptError?: string
  /** Hashtag-driven skill set detected on the LAST user message. Surface
   *  signal: was `#auth-google` recognised by the regex? */
  hashtagSkills: string[]
  /** Names of skills currently sticky/loaded for this project + mode. */
  availableSkills: string[]
  /** Resolved project type — derived from the SESSION's project (not the
   *  live IDE's currently-open one, which may differ after the user
   *  switched projects). Same value fed into buildSystemPrompt. */
  projectType: string
}

interface ExportOptions {
  /** Strip base64 from attachments to keep export small. Default true. */
  stripImageData?: boolean
  /** Environment snapshot from `buildEnvironmentSnapshot`. When provided, the
   *  export includes a final section with the system prompt + project state. */
  envSnapshot?: EnvironmentSnapshot | null
}

export interface RequestEfficiencyReport {
  totalRequests: number
  symbolIndexRequests: number
  symbolIndexTokensEstimate: number
  symbolIndexFilesConsidered: number
  symbolIndexFilesScanned: number
  symbolIndexEntries: number
  symbolIndexTruncated: boolean
  finalReadRangeCount: number
  finalReadRangeFileCount: number
  finalReadToEndRangeCount: number
  finalBoundedReadRangeCount: number
  skippedOverlappingReads: number
  adjustedReadRanges: number
  readBeforeWriteBlockCount: number
  readBeforeWriteBlockedTools: string[]
  readBeforeWriteBlockedReasons: string[]
  firstSymbolIndexRequest?: { requestNumber: number; turn: number }
  readRangesBeforeFirstSymbolIndex?: number
  readRangesAfterFirstSymbolIndex?: number
}

function isoTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ms)
  }
}

function unique(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v))))
}

export function buildRequestEfficiencyReport(log: RequestUsageEntry[] | undefined): RequestEfficiencyReport | null {
  if (!log || log.length === 0) return null

  const symbolEntries = log.filter(e => e.symbolIndexRequested)
  const firstSymbolIndex = symbolEntries.length
    ? log.findIndex(e => e.symbolIndexRequested)
    : -1
  const beforeSymbolReadRanges =
    firstSymbolIndex > 0
      ? log[firstSymbolIndex - 1]?.readRanges?.length ?? 0
      : firstSymbolIndex === 0
        ? 0
        : undefined
  const finalReadRanges = [...log].reverse().find(e => e.readRanges)?.readRanges ?? []
  const readBeforeWriteBlockCount = Math.max(0, ...log.map(e => e.readBeforeWriteBlockCount ?? 0))

  return {
    totalRequests: log.length,
    symbolIndexRequests: symbolEntries.length,
    symbolIndexTokensEstimate: symbolEntries.reduce((sum, e) => sum + (e.symbolIndexTokensEstimate ?? 0), 0),
    symbolIndexFilesConsidered: symbolEntries.reduce((sum, e) => sum + (e.symbolIndexFilesConsidered ?? 0), 0),
    symbolIndexFilesScanned: symbolEntries.reduce((sum, e) => sum + (e.symbolIndexFilesScanned ?? 0), 0),
    symbolIndexEntries: symbolEntries.reduce((sum, e) => sum + (e.symbolIndexEntries ?? 0), 0),
    symbolIndexTruncated: symbolEntries.some(e => e.symbolIndexTruncated),
    finalReadRangeCount: finalReadRanges.length,
    finalReadRangeFileCount: new Set(finalReadRanges.map(r => r.path)).size,
    finalReadToEndRangeCount: finalReadRanges.filter(r => r.readToEnd).length,
    finalBoundedReadRangeCount: finalReadRanges.filter(r => !r.readToEnd).length,
    skippedOverlappingReads: log.reduce((sum, e) => sum + (e.skippedOverlappingReads ?? 0), 0),
    adjustedReadRanges: log.reduce((sum, e) => sum + (e.adjustedReadRanges ?? 0), 0),
    readBeforeWriteBlockCount,
    readBeforeWriteBlockedTools: unique(log.flatMap(e => e.readBeforeWriteBlockedTools ?? [])),
    readBeforeWriteBlockedReasons: unique(log.flatMap(e => e.readBeforeWriteBlockedReasons ?? [])),
    firstSymbolIndexRequest: firstSymbolIndex >= 0
      ? { requestNumber: firstSymbolIndex + 1, turn: log[firstSymbolIndex]?.turn ?? 0 }
      : undefined,
    readRangesBeforeFirstSymbolIndex: beforeSymbolReadRanges,
    readRangesAfterFirstSymbolIndex: beforeSymbolReadRanges === undefined
      ? undefined
      : Math.max(0, finalReadRanges.length - beforeSymbolReadRanges),
  }
}

function sanitizeAttachment(att: Attachment, stripImageData: boolean): Attachment {
  if (!stripImageData) return att
  if (att.base64) {
    const { base64: _base64, ...rest } = att
    return rest as Attachment
  }
  return att
}

function sanitizeMessage(msg: ChatMessage, stripImageData: boolean): ChatMessage {
  const cleaned: ChatMessage = { ...msg }
  if (msg.attachments?.length) {
    cleaned.attachments = msg.attachments.map(a => sanitizeAttachment(a, stripImageData))
  }
  if (msg.promptBlocks?.length) {
    cleaned.promptBlocks = msg.promptBlocks.map(b =>
      b.type === 'attachment'
        ? { type: 'attachment', attachment: sanitizeAttachment(b.attachment, stripImageData) }
        : b,
    )
  }
  return cleaned
}

function sanitizeByokSnapshot(snap: ByokSessionSnapshot | null | undefined): ByokSessionSnapshot | null {
  if (!snap) return null
  // Provider/model/baseURL are non-secret — providerId identifies which BYOK
  // entry was selected, modelId is the model name, baseURL is the (already
  // user-known) endpoint. No API keys are persisted in the snapshot — keys
  // live in the byokStore separately and never enter the session payload.
  // This sanitizer exists as a forward-compat guard in case the snapshot
  // shape ever grows a key-like field.
  return snap
}

export function sessionToJson(session: ChatSession, opts: ExportOptions = {}): string {
  const stripImageData = opts.stripImageData !== false
  const requestUsageLog = session.requestUsageLog ?? []
  // Process-local structured-serialize counters (MCP TOON/mini path). Snapshot
  // at export time so bug reports can show whether TOON ever won this session.
  const promptSerializeStats = getPromptSerializeStats()
  const hasSerializeActivity =
    promptSerializeStats.stringPassthrough
    + promptSerializeStats.jsonMini
    + promptSerializeStats.toonWins
    + promptSerializeStats.toonNoWin
    + promptSerializeStats.toonUnavailable
    > 0

  const payload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      byokSnapshot: sanitizeByokSnapshot(session.byokSnapshot),
      requestUsageLog,
      requestEfficiencyReport: buildRequestEfficiencyReport(requestUsageLog),
      ...(hasSerializeActivity ? { promptSerializeStats } : {}),
      messages: session.messages.map(m => sanitizeMessage(m, stripImageData)),
    },
    environment: opts.envSnapshot ?? null,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Render the permission badge for a tool call. Only emitted when a decision
 * was actually made (silent for `safe_tool`-bypassed reads to avoid clutter).
 * Distinguishes user-approved tools from auto-approved-by-scope so forensic
 * review can correctly attribute "destructive command was run" — the user
 * may have explicitly granted permission, which is meaningful context that
 * the tool result alone hides.
 */
function renderPermissionBadge(p: NonNullable<ToolCallDisplay['permission']>): string {
  const kindLabel = p.promptKind === 'dangerous_command'
    ? ` (${t('export.dangerousCommand')})`
    : p.promptKind === 'sensitive_file'
      ? ` (${t('export.sensitiveFile')})`
      : ''
  if (!p.approved) {
    const reason = p.denyReason ? ` — "${p.denyReason}"` : ''
    return `🚫 ${t('export.permDenied')}${kindLabel}${reason}`
  }
  if (p.source === 'user') {
    return `🔓 ${t('export.permApproved')}${kindLabel}`
  }
  if (p.source === 'approved_scope') {
    return `🔓 ${t('export.permAutoApproved')}`
  }
  if (p.source === 'has_own_approval') {
    return `🔓 ${t('export.permInlineDiff')}`
  }
  return ''
}

function renderToolCallMd(tc: ToolCallDisplay): string {
  const status = tc.isError ? `❌ ${t('export.failed')}` : tc.status === 'completed' ? `✅ ${t('export.ok')}` : `⏳ ${tc.status}`
  const permissionBadge = tc.permission ? renderPermissionBadge(tc.permission) : ''
  const lines: string[] = []
  lines.push(`<details>`)
  lines.push(`<summary><strong>🔧 ${tc.toolName}</strong> — ${status}${permissionBadge ? ` · ${permissionBadge}` : ''}</summary>`)
  lines.push(``)
  lines.push(`**${t('export.input')}**`)
  lines.push('```json')
  try {
    lines.push(JSON.stringify(tc.input, null, 2))
  } catch {
    lines.push(String(tc.input))
  }
  lines.push('```')
  const hasDiffFields = Boolean(tc.diffOldContent || tc.diffNewContent)
  // Num diff, o "resultado" é um marcador — o conteúdo vive nos campos
  // diffOldContent/diffNewContent. Imprimi-lo aqui era despejar o ficheiro
  // inteiro duas vezes dentro de um bloco de código (sessão yyyy, 2026-07-30:
  // 136 KB para uma mudança de 8 linhas). A linha do Diff abaixo é a
  // informação que resta e é a que interessa.
  if (tc.result !== undefined && !hasDiffFields) {
    lines.push(``)
    lines.push(`**${t('export.result')}**`)
    lines.push('```')
    lines.push(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2))
    lines.push('```')
  }
  if (hasDiffFields) {
    const oldLines = (tc.diffOldContent || '').split('\n').length
    const newLines = (tc.diffNewContent || '').split('\n').length
    lines.push(``)
    lines.push(
      `**Diff:** \`${tc.diffStatus ?? 'pending'}\` (${tc.isNewFile ? t('export.newFile') : t('export.edit')}` +
      `, ${oldLines} → ${newLines} ${t('export.lines')})`,
    )
  }
  lines.push(`</details>`)
  return lines.join('\n')
}

function renderMessageMd(msg: ChatMessage): string {
  const stamp = isoTimestamp(msg.timestamp)
  const roleLabel = msg.role === 'user' ? `👤 ${t('export.user')}` : msg.role === 'assistant' ? `🤖 ${t('export.assistant')}` : `⚙️ ${t('export.system')}`
  // Effort carimbado neste turno (managed) — prova no export se Low/High/Max
  // saiu no pedido. Ausente em mensagens legadas.
  const effortLine =
    msg.role === 'assistant' && msg.reasoningEffort
      ? ` · effort \`${msg.reasoningEffort}\`${
          msg.reasoningEffortSent === false ? ' (not sent → provider default)' : ' (sent)'
        }`
      : ''
  const lines: string[] = []
  lines.push(`### ${roleLabel} — ${stamp}${effortLine}`)
  lines.push(``)

  // When the message uses the modern block-based representation, walk it
  // in order so reasoning passes interleave with text and tool calls in
  // the same positions the user saw on screen. Multiple thinking passes
  // (one before each tool call group, for example) all render in place.
  // Falls back to the legacy flat fields for older messages.
  const hasBlocks = !!msg.contentBlocks && msg.contentBlocks.length > 0
  const hasInlineReasoning = hasBlocks && msg.contentBlocks!.some(b => b.type === 'reasoning')

  // Legacy reasoning fallback — only when blocks don't already carry it,
  // otherwise we'd duplicate the same content (block + flat field both
  // populated by some legacy stream paths).
  if (msg.reasoningContent && !hasInlineReasoning) {
    const dur = msg.reasoningDurationMs != null ? ` (${Math.round(msg.reasoningDurationMs / 1000)}s)` : ''
    lines.push(`<details>`)
    lines.push(`<summary>💭 ${t('export.reasoning')}${dur}</summary>`)
    lines.push(``)
    lines.push('```')
    lines.push(msg.reasoningContent)
    lines.push('```')
    lines.push(`</details>`)
    lines.push(``)
  }

  if (hasBlocks) {
    for (const block of msg.contentBlocks!) {
      if (block.type === 'text' && block.text) {
        lines.push(block.text)
        lines.push(``)
      } else if (block.type === 'reasoning' && block.text) {
        const dur = block.durationMs != null ? ` (${Math.round(block.durationMs / 1000)}s)` : ''
        lines.push(`<details>`)
        lines.push(`<summary>💭 ${t('export.reasoning')}${dur}</summary>`)
        lines.push(``)
        lines.push('```')
        lines.push(block.text)
        lines.push('```')
        lines.push(`</details>`)
        lines.push(``)
      } else if (block.type === 'tool_call') {
        const tc = msg.toolCalls?.find(t => t.id === block.toolCallId)
        if (tc) {
          lines.push(renderToolCallMd(tc))
          lines.push(``)
        }
      }
    }
  } else {
    if (msg.content) {
      lines.push(msg.content)
      lines.push(``)
    }
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        lines.push(renderToolCallMd(tc))
        lines.push(``)
      }
    }
  }

  if (msg.codeBlocks?.length) {
    for (const cb of msg.codeBlocks) {
      lines.push(`**Code block (${cb.status})${cb.filePath ? ` — \`${cb.filePath}\`` : ''}**`)
      lines.push('```' + (cb.language ?? ''))
      lines.push(cb.code)
      lines.push('```')
      lines.push(``)
    }
  }

  if (msg.attachments?.length) {
    lines.push(`**Attachments:** ${msg.attachments.map(a => `\`${a.name}\` (${a.type})`).join(', ')}`)
    lines.push(``)
  }

  if (msg.card) {
    lines.push(`**Inline card:** ${msg.card.type} — status: ${msg.card.status}`)
    lines.push(``)
  }

  return lines.join('\n')
}

function renderByokSnapshotMd(snap: ByokSessionSnapshot | null | undefined): string[] {
  if (!snap) return []
  const lines: string[] = []
  lines.push(`- **Provider:** \`${snap.providerId}\``)
  lines.push(`- **Model:** \`${snap.modelId}\``)
  lines.push(`- **Base URL:** \`${snap.baseURL}\``)
  if (snap.thinkingShape) lines.push(`- **Thinking shape:** \`${snap.thinkingShape}\``)
  if (snap.local) lines.push(`- **Local provider:** yes`)
  if (snap.custom) lines.push(`- **Custom provider:** yes`)
  return lines
}

/** Per-request usage log — one row per chat.completions.create call.
 *  Real input/output tokens + payloadInspector estimate + cache fields +
 *  per-category breakdown. Lets you read consumption per request directly
 *  from an exported session (eliminates inferring from compacted transcripts). */
function renderRequestUsageMd(log: RequestUsageEntry[] | undefined): string[] {
  if (!log || log.length === 0) return []
  const lines: string[] = []
  lines.push(`## Request usage log`)
  lines.push(``)
  lines.push(`One row per provider call. \`est.\` = payloadInspector estimate (ceil(chars/3)); \`real\` = provider usage; \`usage\` shows whether real provider counters were available.`)
  lines.push(``)
  const totalIn = log.reduce((s, e) => s + (e.inputTokens ?? 0), 0)
  const totalOut = log.reduce((s, e) => s + (e.outputTokens ?? 0), 0)
  const totalEst = log.reduce((s, e) => s + (e.estimatedInputTokens ?? 0), 0)
  const totalMentionContext = log.reduce((s, e) => s + (e.mentionContextTokens ?? 0), 0)
  const totalToolDefs = log.reduce((s, e) => s + (e.toolDefsTokens ?? 0), 0)
  const totalCacheRead = log.reduce((s, e) => s + (e.cacheReadInputTokens ?? 0), 0)
  const totalCacheCreate = log.reduce((s, e) => s + (e.cacheCreationInputTokens ?? 0), 0)
  // uncached = input tokens that were neither read from cache nor written to it.
  const totalUncached = Math.max(0, totalIn - totalCacheRead - totalCacheCreate)
  const cachedPct = totalIn > 0 ? Math.round(((totalCacheRead + totalCacheCreate) / totalIn) * 100) : 0
  lines.push(`**Totals:** ${log.length} requests · IN ${totalIn.toLocaleString()} (est. ${totalEst.toLocaleString()}) · OUT ${totalOut.toLocaleString()}`)
  if (totalMentionContext > 0) {
    lines.push(`**@mention context:** est. ${totalMentionContext.toLocaleString()} input tokens`)
  }
  if (totalToolDefs > 0) {
    lines.push(`**Tool definitions:** est. ${totalToolDefs.toLocaleString()} input tokens`)
  }
  if (totalCacheRead > 0 || totalCacheCreate > 0) {
    lines.push(`**Prompt cache:** read ${totalCacheRead.toLocaleString()} · create ${totalCacheCreate.toLocaleString()} · uncached ${totalUncached.toLocaleString()} · ${cachedPct}% of input cached`)
  }
  const efficiency = buildRequestEfficiencyReport(log)
  if (efficiency) {
    lines.push(``)
    lines.push(`**Agent reading efficiency:**`)
    lines.push(``)
    lines.push(`| metric | value |`)
    lines.push(`|---|---:|`)
    lines.push(`| symbol index requests | ${efficiency.symbolIndexRequests.toLocaleString()} / ${efficiency.totalRequests.toLocaleString()} |`)
    lines.push(`| symbol index tokens est. | ${efficiency.symbolIndexTokensEstimate.toLocaleString()} |`)
    lines.push(`| symbol index files considered | ${efficiency.symbolIndexFilesConsidered.toLocaleString()} |`)
    lines.push(`| symbol index files scanned | ${efficiency.symbolIndexFilesScanned.toLocaleString()} |`)
    lines.push(`| symbol index entries | ${efficiency.symbolIndexEntries.toLocaleString()} |`)
    lines.push(`| symbol index truncated | ${efficiency.symbolIndexTruncated ? 'yes' : 'no'} |`)
    lines.push(`| final read ranges | ${efficiency.finalReadRangeCount.toLocaleString()} |`)
    lines.push(`| files read | ${efficiency.finalReadRangeFileCount.toLocaleString()} |`)
    lines.push(`| read-to-end ranges | ${efficiency.finalReadToEndRangeCount.toLocaleString()} |`)
    lines.push(`| bounded ranges | ${efficiency.finalBoundedReadRangeCount.toLocaleString()} |`)
    lines.push(`| skipped overlapping reads | ${efficiency.skippedOverlappingReads.toLocaleString()} |`)
    lines.push(`| adjusted read ranges | ${efficiency.adjustedReadRanges.toLocaleString()} |`)
    lines.push(`| read-before-write blocks | ${efficiency.readBeforeWriteBlockCount.toLocaleString()} |`)
    if (efficiency.firstSymbolIndexRequest) {
      lines.push(`| first symbol index request | #${efficiency.firstSymbolIndexRequest.requestNumber.toLocaleString()} / turn ${efficiency.firstSymbolIndexRequest.turn.toLocaleString()} |`)
      lines.push(`| read ranges before symbol index | ${efficiency.readRangesBeforeFirstSymbolIndex?.toLocaleString() ?? '—'} |`)
      lines.push(`| read ranges after symbol index | ${efficiency.readRangesAfterFirstSymbolIndex?.toLocaleString() ?? '—'} |`)
    }
    if (efficiency.readBeforeWriteBlockedTools.length) {
      lines.push(`| blocked write tools | ${efficiency.readBeforeWriteBlockedTools.map(tool => `\`${tool}\``).join(', ')} |`)
    }
    if (efficiency.readBeforeWriteBlockedReasons.length) {
      lines.push(`| block reasons | ${efficiency.readBeforeWriteBlockedReasons.map(reason => `\`${reason}\``).join(', ')} |`)
    }
  }
  lines.push(``)
  lines.push('| # | turn | provider | model | usage | msgs | tools | tool defs | IN (real) | OUT | est. IN | @mention ctx | cache read | cache create | uncached IN |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  log.forEach((e, i) => {
    const cRead = e.cacheReadInputTokens ?? 0
    const cCreate = e.cacheCreationInputTokens ?? 0
    const uncached = Math.max(0, (e.inputTokens ?? 0) - cRead - cCreate)
    const usageState = e.usageAvailable === false ? 'missing' : 'provider'
    const tools = e.toolCount != null
      ? `${e.toolCount}${e.toolCountTotal != null ? `/${e.toolCountTotal}` : ''}`
      : '—'
    lines.push(`| ${i + 1} | ${e.turn} | ${e.provider ?? '—'} | ${e.model} | ${usageState} | ${e.totalMessages?.toLocaleString() ?? '—'} | ${tools} | ${e.toolDefsTokens?.toLocaleString() ?? '—'} | ${e.inputTokens.toLocaleString()} | ${e.outputTokens.toLocaleString()} | ${e.estimatedInputTokens.toLocaleString()} | ${e.mentionContextTokens?.toLocaleString() ?? '—'} | ${e.cacheReadInputTokens?.toLocaleString() ?? '—'} | ${e.cacheCreationInputTokens?.toLocaleString() ?? '—'} | ${uncached.toLocaleString()} |`)
  })
  lines.push(``)
  // Collapsible per-request breakdown — top 5 by real input tokens.
  const top = [...log].sort((a, b) => (b.inputTokens ?? 0) - (a.inputTokens ?? 0)).slice(0, 5)
  for (const e of top) {
    const idx = log.indexOf(e) + 1
    lines.push(`<details><summary>breakdown · req #${idx} · turn ${e.turn} · IN ${e.inputTokens.toLocaleString()} (est. ${e.estimatedInputTokens.toLocaleString()})</summary>`)
    lines.push(``)
    lines.push('| category | blocks | tokens | chars |')
    lines.push('|---|---|---|---|')
    for (const [cat, v] of Object.entries(e.breakdown ?? {})) {
      lines.push(`| ${cat} | ${v.blocks} | ${v.tokens.toLocaleString()} | ${v.chars.toLocaleString()} |`)
    }
    lines.push(``)
    if (e.systemPromptSections?.length) {
      lines.push(`**System prompt sections**`)
      lines.push(``)
      lines.push('| section | location | tokens | chars | on-demand candidate |')
      lines.push('|---|---|---|---|---|')
      for (const s of e.systemPromptSections.slice(0, 12)) {
        lines.push(`| ${escapeTableCell(s.name)} | ${s.location} | ${s.tokens.toLocaleString()} | ${s.chars.toLocaleString()} | ${s.auxiliaryCandidate ? 'yes' : '—'} |`)
      }
      lines.push(``)
    }
    if (e.toolNames?.length) {
      lines.push(`**Toolset**`)
      lines.push(``)
      lines.push(e.toolNames.map(name => `\`${name}\``).join(', '))
      lines.push(``)
    }
    if (
      e.mentionContextRepeatedTokens != null
      || e.mentionContextFullTokens != null
      || e.mentionContextStubTokens != null
      || e.mentionContextRepeatedTokensCumulative != null
    ) {
      lines.push(`**Mention context savings**`)
      lines.push(``)
      lines.push(`| field | tokens |`)
      lines.push(`|---|---:|`)
      if (e.mentionContextFullTokens != null) lines.push(`| full mention context | ${e.mentionContextFullTokens.toLocaleString()} |`)
      if (e.mentionContextStubTokens != null) lines.push(`| stub sent | ${e.mentionContextStubTokens.toLocaleString()} |`)
      if (e.mentionContextRepeatedTokens != null) lines.push(`| saved this request | ${e.mentionContextRepeatedTokens.toLocaleString()} |`)
      if (e.mentionContextRepeatedTokensCumulative != null) lines.push(`| saved cumulative | ${e.mentionContextRepeatedTokensCumulative.toLocaleString()} |`)
      if (e.mentionContextRefId) lines.push(`| ref id | ${escapeTableCell(e.mentionContextRefId)} |`)
      lines.push(``)
    }
    // ── Lazy System Prompt + Tighter Toolset (Phase 1) ──
    // Proves the tighter toolset reached the provider: which profile the
    // Intent Router chose, the core/auxiliary token split, the savings, and
    // which tools were expanded via request_tools vs denied by the bound.
    const hasLazyInfo = e.selectedPromptProfile != null
      || e.coreContextTokens != null
      || e.auxiliarySavingsTokens != null
      || (e.expandedToolNames?.length ?? 0) > 0
      || (e.deniedToolNames?.length ?? 0) > 0
    if (hasLazyInfo) {
      lines.push(`**Lazy system prompt + tighter toolset**`)
      lines.push(``)
      lines.push(`| field | value |`)
      lines.push(`|---|---|`)
      lines.push(`| prompt profile | ${e.selectedPromptProfile ?? '—'}${e.readOnlyRun ? ' (read-only)' : ''} |`)
      if (e.routerSource) lines.push(`| router | ${e.routerSource}${e.routerConfidence && e.routerConfidence !== 'none' ? ` (${e.routerConfidence})` : ''}${e.routerError ? ` — ERROR: ${escapeTableCell(e.routerError)}` : ''} |`)
      if (e.toolsetReason) lines.push(`| reason | ${escapeTableCell(e.toolsetReason)} |`)
      if (e.systemPromptProfileReason && e.systemPromptProfileReason !== e.toolsetReason) lines.push(`| system profile reason | ${escapeTableCell(e.systemPromptProfileReason)} |`)
      // Full router diagnostics — shown when the router ran (model or fallback)
      // so a failed run is diagnosable from the export alone.
      const d = e.routerDiagnostics
      if (d) {
        lines.push(`| router URL | ${escapeTableCell(d.url)} |`)
        lines.push(`| router HTTP | ${d.httpStatus} |`)
        if (d.servedModel) lines.push(`| router served model | ${escapeTableCell(d.servedModel)} |`)
        if (d.configKey) lines.push(`| router config key | ${escapeTableCell(d.configKey)} |`)
        if (d.contentType) lines.push(`| router content-type | ${escapeTableCell(d.contentType)} |`)
        lines.push(`| router appcheck | ${d.appCheckPresent ? 'present' : 'absent'} |`)
        if (d.parseError) lines.push(`| router parse error | ${escapeTableCell(d.parseError)} |`)
        if (d.rawBodyPreview) {
          lines.push(``)
          lines.push(`**router raw body (first 500 chars):**`)
          lines.push(``)
          lines.push('```')
          lines.push(d.rawBodyPreview)
          lines.push('```')
          lines.push(``)
        }
        if (d.contentPreview) {
          lines.push(`**router model content (first 500 chars):**`)
          lines.push(``)
          lines.push('```')
          lines.push(d.contentPreview)
          lines.push('```')
          lines.push(``)
        }
      }
      if (e.coreContextTokens != null) lines.push(`| core context tokens | ${e.coreContextTokens.toLocaleString()} |`)
      if (e.coreSystemTokens != null) lines.push(`| core system tokens | ${e.coreSystemTokens.toLocaleString()} |`)
      if (e.onDemandIndexTokens != null) lines.push(`| on-demand index tokens | ${e.onDemandIndexTokens.toLocaleString()} |`)
      if (e.auxiliaryContextTokens != null) lines.push(`| auxiliary context tokens | ${e.auxiliaryContextTokens.toLocaleString()} |`)
      if (e.auxiliarySavingsTokens != null) lines.push(`| auxiliary savings tokens | ${e.auxiliarySavingsTokens.toLocaleString()} |`)
      if (e.systemPromptSavingsTokens != null) lines.push(`| system prompt savings tokens | ${e.systemPromptSavingsTokens.toLocaleString()} |`)
      if (e.auxiliaryLoaded?.length) lines.push(`| auxiliary loaded | ${e.auxiliaryLoaded.map(id => `\`${id}\``).join(', ')} |`)
      if (e.auxiliaryOmitted?.length) lines.push(`| auxiliary omitted | ${e.auxiliaryOmitted.map(id => `\`${id}\``).join(', ')} |`)
      if (e.loadedSystemSections?.length) lines.push(`| loaded system sections | ${e.loadedSystemSections.map(id => `\`${id}\``).join(', ')} |`)
      if (e.omittedSystemSections?.length) lines.push(`| omitted system sections | ${e.omittedSystemSections.map(id => `\`${id}\``).join(', ')} |`)
      if (e.autoLoadedSystemSections?.length) lines.push(`| auto-loaded system sections | ${e.autoLoadedSystemSections.map(id => `\`${id}\``).join(', ')} |`)
      if (e.contextPlanCandidateSections?.length) lines.push(`| context plan candidates | ${e.contextPlanCandidateSections.map(id => `\`${id}\``).join(', ')} |`)
      if (e.modelRequestedContextSections?.length) lines.push(`| model requested context sections | ${e.modelRequestedContextSections.map(id => `\`${id}\``).join(', ')} |`)
      if (e.requestContextToolCalls != null) lines.push(`| request_context tool calls | ${e.requestContextToolCalls.toLocaleString()} |`)
      if (e.requestContextSectionsLoaded?.length) lines.push(`| request_context sections loaded | ${e.requestContextSectionsLoaded.map(id => `\`${id}\``).join(', ')} |`)
      if (e.requestContextSelectionReason && Object.keys(e.requestContextSelectionReason).length) lines.push(`| request_context selection reason | ${Object.entries(e.requestContextSelectionReason).map(([id, reason]) => `\`${id}\`: ${escapeTableCell(String(reason))}`).join('<br>')} |`)
      if (e.requestContextCostTier && Object.keys(e.requestContextCostTier).length) lines.push(`| request_context cost tier | ${Object.entries(e.requestContextCostTier).map(([id, tier]) => `\`${id}\`: ${tier}`).join(', ')} |`)
      if (e.requestContextFallbackUsed != null) lines.push(`| request_context fallback used | ${e.requestContextFallbackUsed ? 'true' : 'false'} |`)
      if (e.requestContextFallbackFrom?.length) lines.push(`| request_context fallback from | ${e.requestContextFallbackFrom.map(id => `\`${id}\``).join(', ')} |`)
      if (e.requestContextFallbackTo?.length) lines.push(`| request_context fallback to | ${e.requestContextFallbackTo.map(id => `\`${id}\``).join(', ')} |`)
      if (e.requestedButNotLoadedSections?.length) lines.push(`| requested but not loaded sections | ${e.requestedButNotLoadedSections.map(id => `\`${id}\``).join(', ')} |`)
      if (e.expandedToolNames?.length) lines.push(`| expanded via request_tools | ${e.expandedToolNames.map(name => `\`${name}\``).join(', ')} |`)
      if (e.deniedToolNames?.length) lines.push(`| DENIED by profile bound | ${e.deniedToolNames.map(name => `\`${name}\``).join(', ')} |`)
      if (e.contextPlannerStatus) lines.push(`| context planner status | ${e.contextPlannerStatus} |`)
      if (e.contextPlannerError) lines.push(`| context planner error | ${escapeTableCell(e.contextPlannerError)} |`)
      if (e.contextPlannerRawOutput) lines.push(`| context planner raw output | ${escapeTableCell(e.contextPlannerRawOutput)} |`)
      if (e.contextPlannerTaskDomain) lines.push(`| planner task domain | ${e.contextPlannerTaskDomain} |`)
      if (e.contextPlannerRequiredCapabilities?.length) lines.push(`| required capabilities | ${e.contextPlannerRequiredCapabilities.map(c => `\`${c}\``).join(', ')} |`)
      if (e.contextPlannerSelectedContexts?.length) lines.push(`| planner selected contexts | ${e.contextPlannerSelectedContexts.map(id => `\`${id}\``).join(', ')} |`)
      if (e.contextPlannerRejectedContexts?.length) lines.push(`| planner rejected contexts | ${e.contextPlannerRejectedContexts.map(id => `\`${id}\``).join(', ')} |`)
      if (e.contextPlannerSelectionReason) lines.push(`| planner selection reason | ${escapeTableCell(e.contextPlannerSelectionReason)} |`)
      lines.push(``)
    }
    if (e.auxiliaryPromptCandidates?.length) {
      lines.push(`**Auxiliary/on-demand candidates**`)
      lines.push(``)
      lines.push('| section | location | tokens | reason |')
      lines.push('|---|---|---|---|')
      for (const s of e.auxiliaryPromptCandidates.slice(0, 8)) {
        lines.push(`| ${escapeTableCell(s.name)} | ${s.location} | ${s.tokens.toLocaleString()} | ${escapeTableCell(s.reason ?? '')} |`)
      }
      lines.push(``)
    }
    lines.push(`</details>`)
    lines.push(``)
  }
  return lines
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function renderEnvironmentMd(env: EnvironmentSnapshot): string {
  const out: string[] = []
  out.push(`# Environment snapshot`)
  out.push(``)
  out.push(`> Reconstructed at export time (${env.capturedAt}). May differ from`)
  out.push(`> what each individual turn saw if project state has changed since.`)
  out.push(``)
  out.push(`## Detection signals`)
  out.push(``)
  out.push(`- **Project type:** \`${env.projectType}\``)
  out.push(`- **${t('export.hashtags')}** ${env.hashtagSkills.length ? env.hashtagSkills.map(s => `\`${s}\``).join(', ') : '_(none)_'}`)
  out.push(`- **Available skills:** ${env.availableSkills.length ? env.availableSkills.map(s => `\`${s}\``).join(', ') : '_(none)_'}`)
  out.push(``)

  out.push(`## System prompt (at export time)`)
  out.push(``)
  out.push(`> Contains TMS / PLAN / TODO / package summary inline — search within this block`)
  out.push(`> rather than expecting separate sections.`)
  out.push(``)
  if (env.systemPromptError) {
    out.push(`> Could not rebuild: ${env.systemPromptError}`)
    out.push(``)
  } else if (env.systemPrompt) {
    out.push('```')
    out.push(env.systemPrompt)
    out.push('```')
    out.push(``)
  }
  return out.join('\n')
}

export function sessionToMarkdown(session: ChatSession, opts: ExportOptions = {}): string {
  const out: string[] = []
  out.push(`# ${session.name || 'TM Code Session'}`)
  out.push(``)
  out.push(`- **Session ID:** \`${session.id}\``)
  out.push(`- **Project path:** \`${session.projectPath}\``)
  out.push(`- **Status:** \`${session.status}\``)
  out.push(`- **Created:** ${isoTimestamp(session.createdAt)}`)
  out.push(`- **Updated:** ${isoTimestamp(session.updatedAt)}`)
  out.push(`- **Exported at:** ${new Date().toISOString()}`)
  out.push(`- **Messages:** ${session.messages.length}`)
  out.push(...renderByokSnapshotMd(session.byokSnapshot))
  out.push(``)
  out.push(`---`)
  out.push(``)
  for (const msg of session.messages) {
    out.push(renderMessageMd(msg))
    out.push(`---`)
    out.push(``)
  }
  out.push(...renderRequestUsageMd(session.requestUsageLog))
  if (opts.envSnapshot) {
    out.push(``)
    out.push(renderEnvironmentMd(opts.envSnapshot))
  }
  return out.join('\n')
}

/**
 * Build the environment snapshot — async because it reads files (TMS.md etc.)
 * and rebuilds the prompt via contextBuilder. Safe to call before export; all
 * failures are absorbed into the returned object's `systemPromptError` field
 * so the export itself never throws.
 *
 * Imports are dynamic (lazy) so this util doesn't drag the agent runtime into
 * any bundle that just renders message bubbles.
 */
export async function buildEnvironmentSnapshot(session: ChatSession): Promise<EnvironmentSnapshot> {
  const out: EnvironmentSnapshot = {
    capturedAt: new Date().toISOString(),
    hashtagSkills: [],
    availableSkills: [],
    projectType: 'unknown',
  }

  // Latest user message — used for hashtag detection. Walks backwards so a
  // re-export after some assistant turns still captures the original signal.
  let lastUserMessage = ''
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === 'user') {
      lastUserMessage = session.messages[i].content || ''
      break
    }
  }

  try {
    const { skillsFromHashtags } = await import('../services/agent/contextBuilder')
    out.hashtagSkills = skillsFromHashtags(lastUserMessage)
  } catch { /* non-critical */ }

  // Derive projectType from the SESSION's own package.json — not from
  // `useProjectStore.currentProject`, which reflects whatever project is
  // open in the IDE RIGHT NOW (may differ from the session's project if
  // the user switched). The detection logic here mirrors a subset of
  // contextBuilder.detectProjectType for the common frameworks.
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const raw = await invoke<string>('read_file', { path: `${session.projectPath}/package.json` })
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    if (deps.includes('next')) out.projectType = 'nextjs'
    else if (deps.includes('nuxt')) out.projectType = 'nuxt'
    else if (deps.includes('@angular/core')) out.projectType = 'angular'
    else if (deps.includes('svelte')) out.projectType = 'svelte'
    else if (deps.includes('vue')) out.projectType = 'vue'
    else if (deps.includes('react')) out.projectType = 'react'
    else out.projectType = 'node'
  } catch { /* not a Node project, or no package.json — leave as 'unknown' */ }

  // Skills available for this project prompt. loadSkills is cached, so
  // calling it here doesn't double-cost when the live agent already ran.
  try {
    const { default: SkillService } = await import('../services/agent/skillService')
    const skills = await SkillService.getInstance().loadSkills(session.projectPath, out.projectType, 'chat')
    out.availableSkills = skills.map((s) => s.name)
  } catch { /* non-critical */ }

  // Rebuild system prompt — the expensive step. Already embeds TMS/PLAN/TODO
  // and package summary via contextBuilder's internal sections, so we don't
  // duplicate them as separate fields here. Errors absorbed into the
  // snapshot so export never throws on a partial build.
  try {
    const { default: ContextBuilder } = await import('../services/agent/contextBuilder')
    const builder = ContextBuilder.getInstance()
    out.systemPrompt = await builder.buildSystemPrompt(
      session.projectPath,
      out.projectType,
      [], // mcpTools — empty for snapshot; the live agent path includes them at send time
      undefined,
      lastUserMessage,
    )
  } catch (err) {
    out.systemPromptError = err instanceof Error ? err.message : String(err)
  }

  return out
}

/**
 * Open the OS-native save dialog and write the export to the chosen path.
 * Uses Tauri's dialog plugin for the picker, then routes the actual write
 * through the worker's existing `write_file` Rust command (the same path the
 * agent uses for file writes). The fs plugin's `writeTextFile` was failing
 * silently in observed cases — going through `write_file` reuses the
 * already-validated, well-tested Rust path with proper error propagation.
 *
 * Returns the saved path on success, null when the user cancelled, or
 * throws when the write itself failed (caller should surface to UI).
 */
export async function triggerDownload(
  filename: string,
  content: string,
  mimeType: string,
): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { invoke } = await import('@tauri-apps/api/core')

  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : 'txt'
  const filterName = mimeType.includes('json')
    ? 'JSON'
    : mimeType.includes('markdown')
      ? 'Markdown'
      : 'Text'

  const targetPath = await save({
    defaultPath: filename,
    filters: [{ name: filterName, extensions: [ext] }],
  })

  if (!targetPath) return null
  // The Rust `write_file` command bypasses the fs plugin's scope check —
  // the user explicitly picked the path via the system dialog so we trust
  // their choice (sandbox UX would block writing outside fs:scope which is
  // restrictive on Windows where users routinely pick non-$HOME drives).
  await invoke('write_file', { path: targetPath, content })
  return targetPath
}

export function defaultExportFilename(session: ChatSession, ext: 'json' | 'md'): string {
  const slug = (session.name || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `tmcode-${slug || 'session'}-${stamp}.${ext}`
}
