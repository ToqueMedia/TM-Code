/**
 * Session export — serializes a chat session (messages + tool calls +
 * reasoning + attachments metadata) into JSON or Markdown for offline review,
 * bug reports, and agent debugging.
 *
 * Strips base64 image data from attachments to keep file sizes manageable
 * (a single screenshot can blow the export from 10KB to 5MB).
 */

import type { ChatSession, ChatMessage, ToolCallDisplay, Attachment } from '../types/chat'

interface ExportOptions {
  /** Strip base64 from attachments to keep export small. Default true. */
  stripImageData?: boolean
}

function isoTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ms)
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

export function sessionToJson(session: ChatSession, opts: ExportOptions = {}): string {
  const stripImageData = opts.stripImageData !== false
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      name: session.name,
      messages: session.messages.map(m => sanitizeMessage(m, stripImageData)),
    },
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
    ? ' (dangerous command)'
    : p.promptKind === 'sensitive_file'
      ? ' (sensitive file)'
      : ''
  if (!p.approved) {
    const reason = p.denyReason ? ` — "${p.denyReason}"` : ''
    return `🚫 Permission denied by user${kindLabel}${reason}`
  }
  if (p.source === 'user') {
    return `🔓 Approved by user${kindLabel}`
  }
  if (p.source === 'approved_scope') {
    return '🔓 Auto-approved (scope: Accept All)'
  }
  if (p.source === 'has_own_approval') {
    return '🔓 Approved via inline diff'
  }
  return ''
}

function renderToolCallMd(tc: ToolCallDisplay): string {
  const status = tc.isError ? '❌ failed' : tc.status === 'completed' ? '✅ ok' : `⏳ ${tc.status}`
  const permissionBadge = tc.permission ? renderPermissionBadge(tc.permission) : ''
  const lines: string[] = []
  lines.push(`<details>`)
  lines.push(`<summary><strong>🔧 ${tc.toolName}</strong> — ${status}${permissionBadge ? ` · ${permissionBadge}` : ''}</summary>`)
  lines.push(``)
  lines.push(`**Input:**`)
  lines.push('```json')
  try {
    lines.push(JSON.stringify(tc.input, null, 2))
  } catch {
    lines.push(String(tc.input))
  }
  lines.push('```')
  if (tc.result !== undefined) {
    lines.push(``)
    lines.push(`**Result:**`)
    lines.push('```')
    lines.push(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2))
    lines.push('```')
  }
  if (tc.diffOldContent || tc.diffNewContent) {
    lines.push(``)
    lines.push(`**Diff:** \`${tc.diffStatus ?? 'pending'}\` (${tc.isNewFile ? 'new file' : 'edit'})`)
  }
  lines.push(`</details>`)
  return lines.join('\n')
}

function renderMessageMd(msg: ChatMessage): string {
  const stamp = isoTimestamp(msg.timestamp)
  const roleLabel = msg.role === 'user' ? '👤 User' : msg.role === 'assistant' ? '🤖 Assistant' : '⚙️ System'
  const lines: string[] = []
  lines.push(`### ${roleLabel} — ${stamp}`)
  lines.push(``)

  if (msg.reasoningContent) {
    const dur = msg.reasoningDurationMs != null ? ` (${Math.round(msg.reasoningDurationMs / 1000)}s)` : ''
    lines.push(`<details>`)
    lines.push(`<summary>💭 Reasoning${dur}</summary>`)
    lines.push(``)
    lines.push('```')
    lines.push(msg.reasoningContent)
    lines.push('```')
    lines.push(`</details>`)
    lines.push(``)
  }

  if (msg.contentBlocks && msg.contentBlocks.length > 0) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        lines.push(block.text)
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

export function sessionToMarkdown(session: ChatSession, _opts: ExportOptions = {}): string {
  const out: string[] = []
  out.push(`# ${session.name || 'TM Code Session'}`)
  out.push(``)
  out.push(`- **Session ID:** \`${session.id}\``)
  out.push(`- **Exported at:** ${new Date().toISOString()}`)
  out.push(`- **Messages:** ${session.messages.length}`)
  out.push(``)
  out.push(`---`)
  out.push(``)
  for (const msg of session.messages) {
    out.push(renderMessageMd(msg))
    out.push(`---`)
    out.push(``)
  }
  return out.join('\n')
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
