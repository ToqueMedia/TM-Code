import { invoke } from '@/utils/invokeMetrics'
import { ChatSession, ChatMessage, PersistedSession, SessionSummary, ToolCallDisplay, ByokSessionSnapshot, SessionTurnSnapshot } from '../../types/chat'
import { logger } from '../../utils/logger'
import { hashProjectPath, encryptSession, decryptSession } from '../../utils/crypto'
import { useByokStore } from '../../stores/byokStore'

/** Snapshot the current BYOK selection so the session uses the same provider
 *  and model for its entire lifetime, even if the user later switches the
 *  active selection in Settings. Returns null when BYOK is not active or
 *  not configured.
 *
 *  Capabilities are captured whenever the model isn't a registry hit — both
 *  for `custom` providers (no registry) and for "other model" mode on a
 *  curated provider (model id not in our hardcoded catalog). The IDE then
 *  forwards them as X-BYOK-Capabilities and the backend trusts them over
 *  the registry. */
export function captureByokSnapshot(): ByokSessionSnapshot | null {
  const active = useByokStore.getState().resolveActive()
  if (!active) return null
  const inRegistry = active.provider.models.some(m => m.id === active.model.id)
  const isCustom = active.provider.custom === true
  const isLocal = active.provider.local === true
  return {
    providerId: active.provider.id,
    modelId: active.model.id,
    baseURL: active.baseURL,
    custom: isCustom,
    local: isLocal,
    capabilities: !inRegistry ? active.model.capabilities : undefined,
    // Thinking shape is part of the model spec — freeze it on the snapshot
    // so the request body sends the right param shape per BYOK provider
    // (anthropic / openai / qwen / gemini), not the plan-profile shape.
    supportsThinking: active.model.supportsThinking,
    thinkingShape: active.model.thinkingShape,
  }
}

const MAX_SESSIONS_PER_PROJECT = 50
const MAX_TOOL_RESULT_LENGTH = 2000
/** Legacy home-dir root for sessions written before the 2026-05 migration
 *  to `<project>/.toquemedia/sessions/`. Kept only as the SOURCE side of
 *  the one-shot migration in `migrateLegacySessions`; nothing else reads
 *  from here. */
const LEGACY_BASE_DIR_NAME = '.toquemedia-studio'

class SessionService {
  private static instance: SessionService
  private basePath: string | null = null
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private saving = false
  private getSessionFn: (() => ChatSession | null) | null = null
  private getTokenUsageFn: (() => { input: number; output: number; turns: number }) | null = null
  private getTurnSnapshotFn: (() => SessionTurnSnapshot | null) | null = null
  // Tracks the promise of the most recent saveSession invocation. Used by
  // deleteAllProjectSessions to await any in-flight write before unlinking
  // the directory — otherwise Tauri's thread pool can interleave write_file
  // and delete_file_or_directory, recreating a session file inside (or just
  // after) the directory we're trying to remove.
  private currentSavePromise: Promise<void> | null = null
  // Set to true while deleteAllProjectSessions is running so any in-flight
  // saveSession that completes between the await and the actual unlink
  // becomes a no-op rather than re-creating the file. Reset after delete.
  private deletingProjectPath: string | null = null

  static getInstance(): SessionService {
    if (!SessionService.instance) {
      SessionService.instance = new SessionService()
    }
    return SessionService.instance
  }

  setSessionGetter(fn: () => ChatSession | null) {
    this.getSessionFn = fn
  }

  setTokenUsageGetter(fn: () => { input: number; output: number; turns: number }) {
    this.getTokenUsageFn = fn
  }

  /** Snapshot of the last on-wire turn — persisted alongside the session so
   *  the context-window indicator survives a reload (otherwise the bar
   *  shows 0% until the next turn). Read at save time only; no-op when unset. */
  setTurnSnapshotGetter(fn: () => SessionTurnSnapshot | null) {
    this.getTurnSnapshotFn = fn
  }

  /** Legacy home-dir base — used ONLY by `migrateLegacySessions` to locate
   *  the pre-migration data on first init. New writes never touch this. */
  private async getLegacyBasePath(): Promise<string> {
    if (this.basePath) return this.basePath
    const home = await invoke<string>('get_home_directory')
    const normalized = home.endsWith('/') || home.endsWith('\\') ? home.slice(0, -1) : home
    this.basePath = `${normalized}/${LEGACY_BASE_DIR_NAME}`
    return this.basePath
  }

  /** Sessions live INSIDE the project at `<project>/.toquemedia/sessions/`
   *  (migrated 2026-05 from `~/.toquemedia-studio/sessions/{projectHash}/`).
   *  Project-rooted so the conversation history travels with the project:
   *  move the folder to another machine, the agent picks up where it left
   *  off without an opaque hash key going stale on the new machine. */
  private async getSessionsDir(projectPath: string): Promise<string> {
    const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
    return `${normalized}/.toquemedia/sessions`
  }

  /** Path under the LEGACY home-dir scheme. Used only during migration. */
  private async getLegacySessionsDir(projectPath: string): Promise<string> {
    const base = await this.getLegacyBasePath()
    const hash = await hashProjectPath(projectPath)
    return `${base}/sessions/${hash}`
  }

  private async getSessionFilePath(projectPath: string, sessionId: string): Promise<string> {
    const dir = await this.getSessionsDir(projectPath)
    return `${dir}/session_${sessionId}.json`
  }

  private async getActiveSessionFile(projectPath: string): Promise<string> {
    const dir = await this.getSessionsDir(projectPath)
    return `${dir}/active_session.json`
  }

  private async getIndexFile(projectPath: string): Promise<string> {
    const dir = await this.getSessionsDir(projectPath)
    return `${dir}/sessions_index.json`
  }

  // === Lifecycle ===

  async init(projectPath: string): Promise<void> {
    const dir = await this.getSessionsDir(projectPath)
    try {
      await invoke('create_directories_all', { path: dir })
    } catch (error) {
      logger.error('session', 'Failed to create sessions directory:', error)
    }

    // One-shot migration from the legacy home-dir layout. Runs every init
    // but is cheap (`list_directory` + a marker check) and short-circuits
    // when there's nothing to migrate. After it succeeds the marker stops
    // future runs from doing anything.
    try {
      await this.migrateLegacySessions(projectPath)
    } catch (error) {
      // Migration failure is non-fatal — sessions in the legacy location
      // remain readable via manual rescue if ever needed. New writes go
      // to the project regardless.
      logger.warn('session', 'Legacy session migration failed (non-fatal):', error)
    }

    // Ensure `.toquemedia/.gitignore` carries the sessions/ + queue
    // entries. The Rust helper is idempotent — adds only what's missing.
    try {
      await invoke('ensure_toquemedia_gitignore_cmd', { projectPath })
    } catch (error) {
      logger.warn('session', 'Failed to write .toquemedia/.gitignore:', error)
    }

    // Clean up stale empty sessions from previous runs (e.g. if app crashed before cleanup)
    try {
      await this.cleanupEmptySessions(projectPath)
    } catch {
      // Ignore — index may not exist yet on first run
    }
  }

  /**
   * One-shot best-effort migration of the legacy session tree from
   * `~/.toquemedia-studio/sessions/{projectHash}/` into the project's
   * own `.toquemedia/sessions/`. Idempotent via a `.migrated` marker
   * file in the new directory — after the first successful run, every
   * subsequent init returns immediately.
   *
   * The migration is intentionally simple: copy every file from legacy
   * to new (encryption is keyed on `projectPath`, which is unchanged,
   * so encrypted files keep decrypting fine), then write the marker.
   * The legacy tree is LEFT in place — we don't risk data loss if the
   * user rolls back, and the orphan can be cleaned by an admin command
   * later. The legacy dir won't appear in the IDE again because nothing
   * reads from it post-migration.
   */
  private async migrateLegacySessions(projectPath: string): Promise<void> {
    const newDir = await this.getSessionsDir(projectPath)
    const markerPath = `${newDir}/.migrated`

    // Marker check — already migrated.
    try {
      await invoke<string>('read_file', { path: markerPath })
      return
    } catch { /* not migrated yet — continue */ }

    const legacyDir = await this.getLegacySessionsDir(projectPath)
    // Probe the legacy dir. If it doesn't exist or is empty, write the
    // marker and exit — there's nothing to migrate, but we still drop
    // the marker so future inits don't re-probe.
    let legacyEntries: string[] = []
    try {
      legacyEntries = await invoke<string[]>('list_directory', { path: legacyDir })
    } catch {
      // Legacy dir missing — fresh install, no migration needed.
      try {
        await invoke('write_file', { path: markerPath, content: 'no-legacy' })
      } catch { /* marker write best-effort */ }
      return
    }
    if (legacyEntries.length === 0) {
      try {
        await invoke('write_file', { path: markerPath, content: 'empty-legacy' })
      } catch { /* best-effort */ }
      return
    }

    // Copy every file. The legacy dir is flat (session_*.json, active_session.json,
    // sessions_index.json, queue-operations.jsonl) — no nested traversal needed.
    let migrated = 0
    for (const entry of legacyEntries) {
      // `list_directory` returns full paths or basenames depending on impl;
      // be tolerant of both by computing the basename ourselves.
      const basename = entry.split('/').pop() ?? entry
      const srcPath = entry.includes('/') ? entry : `${legacyDir}/${basename}`
      const destPath = `${newDir}/${basename}`
      try {
        const content = await invoke<string>('read_file', { path: srcPath })
        await invoke('write_file', { path: destPath, content })
        migrated++
      } catch (err) {
        logger.warn('session', `Failed to migrate ${basename}:`, err)
      }
    }
    logger.info('session', `Migrated ${migrated}/${legacyEntries.length} legacy session files for ${projectPath}`)

    // Marker written last so partial migrations (process killed mid-loop)
    // re-attempt next init and finish copying. The copy step is idempotent
    // — write_file overwrites — so re-running is safe.
    try {
      await invoke('write_file', {
        path: markerPath,
        content: JSON.stringify({
          migratedAt: new Date().toISOString(),
          fileCount: migrated,
          legacyDir,
        }, null, 2),
      })
    } catch { /* marker write best-effort */ }
  }

  // === Session CRUD ===

  async createSession(projectPath: string): Promise<ChatSession> {
    const now = Date.now()
    const sessionId = `sess_${now}_${Math.random().toString(36).slice(2, 8)}`

    const session: ChatSession = {
      id: sessionId,
      projectPath,
      messages: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      byokSnapshot: captureByokSnapshot(),
    }

    await this.saveSession(session)
    await this.setActiveSessionId(projectPath, sessionId)
    await this.enforceMaxSessions(projectPath)

    return session
  }

  async loadSession(projectPath: string, sessionId: string): Promise<ChatSession | null> {
    try {
      const filePath = await this.getSessionFilePath(projectPath, sessionId)
      const raw = await invoke<string>('read_file', { path: filePath })

      // Try decrypting first; fall back to plain JSON for legacy unencrypted sessions
      let json = await decryptSession(raw, projectPath)
      if (json === null) {
        // Not encrypted (legacy) or decryption failed — try parsing as plain JSON
        json = raw
      }
      const persisted: PersistedSession = JSON.parse(json)

      // Truncate tool results that may have been saved with full content
      const messages = persisted.messages.map(msg => this.sanitizeMessage(msg))

      // Carry the persisted turn snapshot through on the returned session
      // even though it isn't a formal ChatSession field — the chatStore
      // loader reads it via type assertion to restore the context-window
      // indicator without requiring a parallel return value.
      const out = {
        id: persisted.id,
        projectPath: persisted.projectPath,
        messages,
        status: persisted.status === 'running' ? 'idle' : persisted.status,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        byokSnapshot: persisted.byokSnapshot ?? null,
      } as ChatSession & { lastTurnSnapshot?: SessionTurnSnapshot }
      if (persisted.lastTurnSnapshot) out.lastTurnSnapshot = persisted.lastTurnSnapshot
      return out
    } catch (error) {
      logger.error('session', `Failed to load session ${sessionId}:`, error)
      return null
    }
  }

  async saveSession(session: ChatSession, tokenUsage?: { input: number; output: number; turns: number }): Promise<void> {
    // Refuse new saves for a project that's mid-deletion. Without this guard
    // a debounced save fired just before deleteProject ran could complete
    // its write_file AFTER the directory was removed, recreating it with a
    // stale session file inside.
    if (this.deletingProjectPath === session.projectPath) return
    const promise = this._writeSessionToDisk(session, tokenUsage)
    this.currentSavePromise = promise
    try {
      await promise
    } finally {
      if (this.currentSavePromise === promise) this.currentSavePromise = null
    }
  }

  private async _writeSessionToDisk(session: ChatSession, tokenUsage?: { input: number; output: number; turns: number }): Promise<void> {
    try {
      const filePath = await this.getSessionFilePath(session.projectPath, session.id)

      const persisted: PersistedSession = {
        id: session.id,
        projectPath: session.projectPath,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        messages: session.messages
          .map(msg => this.sanitizeMessageForSave(msg))
          .filter((m): m is ChatMessage => m !== null),
        byokSnapshot: session.byokSnapshot ?? null,
      }

      if (tokenUsage) {
        persisted.tokenUsage = {
          totalPromptTokens: tokenUsage.input,
          totalCompletionTokens: tokenUsage.output,
          totalTurns: tokenUsage.turns,
        }
      }

      const turnSnapshot = this.getTurnSnapshotFn?.()
      if (turnSnapshot) {
        persisted.lastTurnSnapshot = turnSnapshot
      }

      const json = JSON.stringify(persisted, null, 2)
      const encrypted = await encryptSession(json, session.projectPath)
      // Re-check the kill switch right before the actual write. Between the
      // start of this method and now, JSON encoding + crypto have run; the
      // user may have triggered deletion in that window.
      if (this.deletingProjectPath === session.projectPath) return
      await invoke('write_file', { path: filePath, content: encrypted })
      // Restrict file permissions to owner-only (600) to protect sensitive session data
      try {
        const safePath = filePath.replace(/'/g, "'\\''")
        await invoke('execute_command', { command: `chmod 600 '${safePath}'`, cwd: '/' })
      } catch { /* non-fatal on non-Unix or sandboxed environments */ }
      await this.updateIndex(session.projectPath, session)
    } catch (error) {
      logger.error('session', `Failed to save session ${session.id}:`, error)
    }
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    try {
      const filePath = await this.getSessionFilePath(projectPath, sessionId)
      await invoke('delete_file_or_directory', { path: filePath })
      await this.removeFromIndex(projectPath, sessionId)
    } catch (error) {
      logger.error('session', `Failed to delete session ${sessionId}:`, error)
    }
  }

  async deleteAllProjectSessions(projectPath: string): Promise<void> {
    // 1. Latch the kill switch so any saveSession invocation racing with
    //    this delete becomes a no-op once it observes the flag.
    this.deletingProjectPath = projectPath
    try {
      // 2. Wait for the in-flight save (if any) started BEFORE the latch
      //    was set. _writeSessionToDisk re-checks the latch right before
      //    invoke('write_file'), so a save that started the JSON encoding
      //    pass earlier will short-circuit before touching disk. Awaiting
      //    here makes the ordering deterministic — without it the JS
      //    promise + Tauri thread-pool interleaving could complete the
      //    write AFTER our delete_file_or_directory call returns.
      if (this.currentSavePromise) {
        try { await this.currentSavePromise } catch { /* swallowed in saveSession */ }
      }
      // 3. Now safe to remove the directory. Subsequent debounced/streaming
      //    saves that try to fire will hit the latch and bail.
      const dir = await this.getSessionsDir(projectPath)
      await invoke('delete_file_or_directory', { path: dir })
      logger.info('session', `Deleted all sessions for project: ${projectPath}`)
    } catch (error) {
      logger.error('session', 'Failed to delete all project sessions:', error)
    } finally {
      // 4. Clear the latch so opening a different project later isn't blocked
      //    from saving. (Per-project: only writes targeting `projectPath`
      //    were blocked; other paths were always allowed.)
      if (this.deletingProjectPath === projectPath) {
        this.deletingProjectPath = null
      }
    }
  }

  // === Session listing ===

  async listSessions(projectPath: string): Promise<SessionSummary[]> {
    try {
      const indexPath = await this.getIndexFile(projectPath)
      const content = await invoke<string>('read_file', { path: indexPath })
      const summaries: SessionSummary[] = JSON.parse(content)
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  // === Active session pointer ===

  async getActiveSessionId(projectPath: string): Promise<string | null> {
    try {
      const filePath = await this.getActiveSessionFile(projectPath)
      const content = await invoke<string>('read_file', { path: filePath })
      const data = JSON.parse(content)
      return data.sessionId || null
    } catch {
      return null
    }
  }

  async setActiveSessionId(projectPath: string, sessionId: string): Promise<void> {
    try {
      const filePath = await this.getActiveSessionFile(projectPath)
      await invoke('write_file', {
        path: filePath,
        content: JSON.stringify({ sessionId, updatedAt: Date.now() }),
      })
    } catch (error) {
      logger.error('session', 'Failed to set active session:', error)
    }
  }

  // === Auto-save ===

  markDirty() {
    this.dirty = true
  }

  startAutoSave(intervalMs: number = 30000): void {
    this.stopAutoSave()
    this.autoSaveInterval = setInterval(() => {
      if (this.dirty) {
        this.flushNow()
      }
    }, intervalMs)
  }

  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval)
      this.autoSaveInterval = null
    }
  }

  async flushNow(): Promise<void> {
    if (!this.dirty || !this.getSessionFn || this.saving) return

    this.saving = true
    try {
      const session = this.getSessionFn()
      if (session) {
        const tokenUsage = this.getTokenUsageFn?.()
        await this.saveSession(session, tokenUsage ?? undefined)
        this.dirty = false
      }
    } finally {
      this.saving = false
    }
  }

  // === Internal helpers ===

  private sanitizeMessage(msg: ChatMessage): ChatMessage {
    if (!msg.toolCalls?.length) return msg
    return {
      ...msg,
      toolCalls: msg.toolCalls.map(tc => ({
        ...tc,
        result: tc.result && tc.result.length > MAX_TOOL_RESULT_LENGTH
          ? tc.result.slice(0, MAX_TOOL_RESULT_LENGTH) + '...'
          : tc.result,
      })),
    }
  }

  private sanitizeMessageForSave(msg: ChatMessage): ChatMessage | null {
    // Drop ephemeral status messages from the persisted session. They were
    // transient by design (permission grants, "session saved" feedback,
    // dev-server lifecycle) — the in-memory timer already removes them after
    // ~8s, persisting would resurrect them on the next reload as stale noise.
    if (msg.ephemeral) return null

    const sanitized: ChatMessage = {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
    }

    // Persist UI-discriminator + meta fields. These were silently dropped by
    // the earlier "copy these 7 fields" sanitizer — bug exposed when the user
    // reloaded a chat with a pending plan_approval card and the card returned
    // as an empty system message (no approve/reject buttons). Same class of
    // bug for the compact_boundary marker and per-turn token stats.
    //
    // Rule: anything that drives rendering OR resumes a user-actionable flow
    // (cards, permission requests) goes in here. Anything that's purely
    // runtime state (isStreaming, in-flight resolve promises) does NOT.
    if (msg.card) sanitized.card = msg.card
    if (msg.level) sanitized.level = msg.level
    if (msg.kind) sanitized.kind = msg.kind
    if (typeof msg.compactBeforeTokens === 'number') {
      sanitized.compactBeforeTokens = msg.compactBeforeTokens
    }
    if (typeof msg.thinkingRequested === 'boolean') {
      sanitized.thinkingRequested = msg.thinkingRequested
    }
    if (typeof msg.turnDurationMs === 'number') sanitized.turnDurationMs = msg.turnDurationMs
    if (typeof msg.turnInputTokens === 'number') sanitized.turnInputTokens = msg.turnInputTokens
    if (typeof msg.turnOutputTokens === 'number') sanitized.turnOutputTokens = msg.turnOutputTokens

    // Persist attachment metadata WITHOUT base64. The base64 data URI is
    // potentially several MB per image and would bloat the encrypted
    // session file. On reload, attachments come back with only metadata
    // (id, type, name, path, mimeType, sizeBytes) — image base64 is gone,
    // so multimodal reconstruction in rebuildConversationHistory falls
    // back to the text path. Multimodal across app restarts is a known
    // limitation; in-session multimodal works correctly.
    if (msg.attachments?.length) {
      sanitized.attachments = msg.attachments.map(a => {
        const { base64: _base64, ...rest } = a
        return rest
      })
    }

    // Persist promptBlocks the same way — preserve the interleaved
    // ordering, but strip base64 from any attachment blocks. On reload
    // the block ordering is intact (so the bubble can still derive a
    // correct display) but image content has to be re-resolved from
    // disk via attachment.path if multimodal is needed.
    if (msg.promptBlocks?.length) {
      sanitized.promptBlocks = msg.promptBlocks.map(block => {
        if (block.type === 'attachment') {
          const { base64: _base64, ...rest } = block.attachment
          return { type: 'attachment' as const, attachment: rest }
        }
        return block
      })
    }

    if (msg.codeBlocks?.length) {
      sanitized.codeBlocks = msg.codeBlocks
    }

    if (msg.toolCalls?.length) {
      sanitized.toolCalls = msg.toolCalls.map((tc: ToolCallDisplay) => ({
        ...tc,
        result: tc.result && tc.result.length > MAX_TOOL_RESULT_LENGTH
          ? tc.result.slice(0, MAX_TOOL_RESULT_LENGTH) + '...'
          : tc.result,
      }))
    }

    // Persist contentBlocks for interleaved text + tool call rendering
    if (msg.contentBlocks?.length) {
      sanitized.contentBlocks = msg.contentBlocks
    }

    // Persist reasoning content if present
    if (msg.reasoningContent) {
      sanitized.reasoningContent = msg.reasoningContent
      if (msg.reasoningDurationMs) sanitized.reasoningDurationMs = msg.reasoningDurationMs
    }

    // Don't persist isStreaming
    return sanitized
  }

  async updateIndex(projectPath: string, session: ChatSession): Promise<void> {
    try {
      const summaries = await this.listSessions(projectPath)
      const lastMsg = session.messages[session.messages.length - 1]

      const summary: SessionSummary = {
        id: session.id,
        name: session.name,
        projectPath: session.projectPath,
        messageCount: session.messages.length,
        lastMessage: lastMsg?.content?.slice(0, 100) ?? '',
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }

      const filtered = summaries.filter(s => s.id !== session.id)
      filtered.unshift(summary)

      const indexPath = await this.getIndexFile(projectPath)
      await invoke('write_file', {
        path: indexPath,
        content: JSON.stringify(filtered, null, 2),
      })
    } catch (error) {
      logger.error('session', 'Failed to update session index:', error)
    }
  }

  private async removeFromIndex(projectPath: string, sessionId: string): Promise<void> {
    try {
      const summaries = await this.listSessions(projectPath)
      const filtered = summaries.filter(s => s.id !== sessionId)
      const indexPath = await this.getIndexFile(projectPath)
      await invoke('write_file', {
        path: indexPath,
        content: JSON.stringify(filtered, null, 2),
      })
    } catch (error) {
      logger.error('session', 'Failed to remove from session index:', error)
    }
  }

  private async enforceMaxSessions(projectPath: string): Promise<void> {
    const summaries = await this.listSessions(projectPath)
    if (summaries.length <= MAX_SESSIONS_PER_PROJECT) return

    // Sort by updatedAt ascending (oldest first)
    const sorted = [...summaries].sort((a, b) => a.updatedAt - b.updatedAt)
    const toDelete = sorted.slice(0, sorted.length - MAX_SESSIONS_PER_PROJECT)

    for (const session of toDelete) {
      await this.deleteSession(projectPath, session.id)
    }
  }

  async renameSession(session: ChatSession, name: string): Promise<void> {
    session.name = name
    await this.updateIndex(session.projectPath, session)
  }

  async cleanupEmptySessions(projectPath: string): Promise<void> {
    // Read the active session FIRST so we never delete it, even if it has 0 messages.
    // Deleting the active session causes a PathNotFound error on the next startup
    // because active_session.json still points to it.
    const activeId = await this.getActiveSessionId(projectPath)
    const summaries = await this.listSessions(projectPath)
    for (const summary of summaries) {
      if (summary.messageCount === 0 && summary.id !== activeId) {
        await this.deleteSession(projectPath, summary.id)
      }
    }
  }
}

export const sessionService = SessionService.getInstance()
export default SessionService
