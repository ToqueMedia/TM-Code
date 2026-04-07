import { invoke } from '@tauri-apps/api/core'
import { ChatSession, ChatMessage, PersistedSession, SessionSummary, ToolCallDisplay } from '../../types/chat'
import { logger } from '../../utils/logger'
import { hashProjectPath, encryptSession, decryptSession } from '../../utils/crypto'

const MAX_SESSIONS_PER_PROJECT = 50
const MAX_TOOL_RESULT_LENGTH = 2000
const BASE_DIR_NAME = '.toquemedia-studio'

class SessionService {
  private static instance: SessionService
  private basePath: string | null = null
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private saving = false
  private getSessionFn: (() => ChatSession | null) | null = null
  private getTokenUsageFn: (() => { input: number; output: number; turns: number }) | null = null

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

  private async getBasePath(): Promise<string> {
    if (this.basePath) return this.basePath
    const home = await invoke<string>('get_home_directory')
    const normalized = home.endsWith('/') || home.endsWith('\\') ? home.slice(0, -1) : home
    this.basePath = `${normalized}/${BASE_DIR_NAME}`
    return this.basePath
  }

  private async getSessionsDir(projectPath: string): Promise<string> {
    const base = await this.getBasePath()
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

    // Clean up stale empty sessions from previous runs (e.g. if app crashed before cleanup)
    try {
      await this.cleanupEmptySessions(projectPath)
    } catch {
      // Ignore — index may not exist yet on first run
    }
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

      return {
        id: persisted.id,
        projectPath: persisted.projectPath,
        messages,
        status: persisted.status === 'running' ? 'idle' : persisted.status,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
      }
    } catch (error) {
      logger.error('session', `Failed to load session ${sessionId}:`, error)
      return null
    }
  }

  async saveSession(session: ChatSession, tokenUsage?: { input: number; output: number; turns: number }): Promise<void> {
    try {
      const filePath = await this.getSessionFilePath(session.projectPath, session.id)

      const persisted: PersistedSession = {
        id: session.id,
        projectPath: session.projectPath,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        messages: session.messages.map(msg => this.sanitizeMessageForSave(msg)),
      }

      if (tokenUsage) {
        persisted.tokenUsage = {
          totalPromptTokens: tokenUsage.input,
          totalCompletionTokens: tokenUsage.output,
          totalTurns: tokenUsage.turns,
        }
      }

      const json = JSON.stringify(persisted, null, 2)
      const encrypted = await encryptSession(json, session.projectPath)
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
    try {
      const dir = await this.getSessionsDir(projectPath)
      await invoke('delete_file_or_directory', { path: dir })
      logger.info('session', `Deleted all sessions for project: ${projectPath}`)
    } catch (error) {
      logger.error('session', 'Failed to delete all project sessions:', error)
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

  private sanitizeMessageForSave(msg: ChatMessage): ChatMessage {
    const sanitized: ChatMessage = {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
    }

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

  private async updateIndex(projectPath: string, session: ChatSession): Promise<void> {
    try {
      const summaries = await this.listSessions(projectPath)
      const lastMsg = session.messages[session.messages.length - 1]

      const summary: SessionSummary = {
        id: session.id,
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

  async cleanupEmptySessions(projectPath: string): Promise<void> {
    const summaries = await this.listSessions(projectPath)
    for (const summary of summaries) {
      if (summary.messageCount === 0) {
        await this.deleteSession(projectPath, summary.id)
      }
    }
  }
}

export const sessionService = SessionService.getInstance()
export default SessionService
