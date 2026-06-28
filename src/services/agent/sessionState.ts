/**
 * Session state tracker — owns all mutable per-session state.
 *
 * SRP: tracks file access, tool telemetry, and compression counters.
 * No I/O, no store reads, no API calls — pure state management.
 *
 * DIP: depends on types.ts interfaces, not on concrete services.
 * The agent loop injects data via method calls; this module never
 * reaches out to the filesystem, stores, or network.
 */

import type { FileAccessEntry, ToolFailureEntry } from './types'
import { clearMentionContextTracker } from './mentionContextTracker'

// ── SessionState class ──

export class SessionState {
  // ── File access tracking ──
  private fileAccessLog: FileAccessEntry[] = []

  // ── Files edited this session (for verify enforcement) ──
  private filesEditedThisSession: Set<string> = new Set()

  // ── Timestamp of the last approved file change ──
  private lastFileChangeTimestamp = 0

  // ── Prompt token tracking ──
  private lastPromptTokens = 0

  // ── Wall-clock timestamp of last completed assistant turn ──
  private lastAssistantMessageAt: number | null = null

  // ── Context window ──
  private contextWindowSize: number

  // ── Compression circuit breaker ──
  private summarizationFailures = 0

  // ── Pool telemetry ──
  private poolConcurrencyConflictsAvoided = 0

  // ── Tool-call pattern telemetry ──
  private cumulativeToolCalls = 0
  private turnIndex = 0
  private writesWithoutDevServerLogs = 0
  private turnsSinceLastReminder = 0

  // ── Repeated tool failure tracking ──
  private recentToolFailures: Map<string, ToolFailureEntry> = new Map()

  constructor(contextWindowSize: number) {
    this.contextWindowSize = contextWindowSize
  }

  // ── File access ──

  trackFileAccess(toolName: string, args: Record<string, unknown>): void {
    const path = (args.file_path as string) || ''
    if (!path) return

    let action: 'read' | 'modified' | null = null
    switch (toolName) {
      case 'read_file': action = 'read'; break
      case 'write_file': case 'create_file': case 'edit_file':
        action = 'modified'; break
      default: return
    }

    // Preserve 'modified' as the strongest action
    const existing = this.fileAccessLog.find(e => e.path === path)
    const resolvedAction = (existing?.action === 'modified' && action === 'read')
      ? 'modified'
      : action

    this.fileAccessLog = this.fileAccessLog.filter(e => e.path !== path)
    this.fileAccessLog.push({ path, action: resolvedAction, timestamp: Date.now() })

    if (this.fileAccessLog.length > 200) {
      this.fileAccessLog = this.fileAccessLog.slice(-200)
    }
  }

  getAccessedFilePaths(): string[] {
    return this.fileAccessLog.map(e => e.path)
  }

  getRecentFiles(limit: number): string[] {
    const sorted = [...this.fileAccessLog].sort((a, b) => {
      if (a.action === 'modified' && b.action !== 'modified') return -1
      if (b.action === 'modified' && a.action !== 'modified') return 1
      return b.timestamp - a.timestamp
    })
    return sorted.slice(0, limit).map(e => e.path)
  }

  // ── Files edited ──

  trackFileEdit(path: string): void {
    this.filesEditedThisSession.add(path)
    this.lastFileChangeTimestamp = Date.now()
  }

  getFilesEdited(): Set<string> {
    return this.filesEditedThisSession
  }

  getLastFileChangeTimestamp(): number {
    return this.lastFileChangeTimestamp
  }

  // ── Token tracking ──

  getLastPromptTokens(): number { return this.lastPromptTokens }
  setLastPromptTokens(tokens: number): void { this.lastPromptTokens = tokens }

  // ── Assistant turn timestamp ──

  getLastAssistantMessageAt(): number | null { return this.lastAssistantMessageAt }
  setLastAssistantMessageAt(ts: number): void { this.lastAssistantMessageAt = ts }

  // ── Context window ──

  getContextWindowSize(): number { return this.contextWindowSize }
  setContextWindowSize(size: number): void { this.contextWindowSize = size }

  // ── Compression circuit breaker ──

  getSummarizationFailures(): number { return this.summarizationFailures }
  incrementSummarizationFailures(): number { return ++this.summarizationFailures }
  resetSummarizationFailures(): void { this.summarizationFailures = 0 }

  // ── Pool telemetry ──

  getPoolConflictsAvoided(): number { return this.poolConcurrencyConflictsAvoided }
  addPoolConflictsAvoided(count: number): void { this.poolConcurrencyConflictsAvoided += count }

  // ── Tool telemetry ──

  getTurnIndex(): number { return this.turnIndex }
  incrementTurnIndex(): void { this.turnIndex++ }

  getCumulativeToolCalls(): number { return this.cumulativeToolCalls }
  addCumulativeToolCalls(count: number): void { this.cumulativeToolCalls += count }

  getWritesWithoutDevServerLogs(): number { return this.writesWithoutDevServerLogs }
  setWritesWithoutDevServerLogs(count: number): void { this.writesWithoutDevServerLogs = count }
  addWritesWithoutDevServerLogs(count: number): void { this.writesWithoutDevServerLogs += count }

  getTurnsSinceLastReminder(): number { return this.turnsSinceLastReminder }
  incrementTurnsSinceLastReminder(): void { this.turnsSinceLastReminder++ }
  resetTurnsSinceLastReminder(): void { this.turnsSinceLastReminder = 0 }

  // ── Tool failure tracking ──

  recordToolFailure(key: string, error: string): number {
    const existing = this.recentToolFailures.get(key)
    const count = (existing?.count ?? 0) + 1
    this.recentToolFailures.set(key, { count, lastError: error.slice(0, 200) })
    return count
  }

  getToolFailure(key: string): ToolFailureEntry | undefined {
    return this.recentToolFailures.get(key)
  }

  // ── Reset ──

  resetForNewSession(): void {
    clearMentionContextTracker()
    this.lastPromptTokens = 0
    this.fileAccessLog = []
    this.filesEditedThisSession.clear()
    this.lastFileChangeTimestamp = 0
    this.summarizationFailures = 0
    this.poolConcurrencyConflictsAvoided = 0
    this.cumulativeToolCalls = 0
    this.turnIndex = 0
    this.writesWithoutDevServerLogs = 0
    this.turnsSinceLastReminder = 0
    this.recentToolFailures.clear()
  }

  resetForNewMessage(): void {
    this.filesEditedThisSession.clear()
    this.lastFileChangeTimestamp = 0
    this.recentToolFailures.clear()
  }
}
