import { invoke } from '@/utils/invokeMetrics'
import { logger } from '../../utils/logger'
import { hashFilePath } from '../../utils/crypto'
// Per-file paths are still hashed for filename-length / character safety on
// disk. Project-level checkpoint storage is resolved by Rust from
// `.toquemedia-id` into app-managed project state.

const MAX_CHECKPOINTS_PER_SESSION = 100
const PERSIST_DEBOUNCE_MS = 500

// === Types ===

export interface FileSnapshot {
  filePath: string
  filePathHash: string
  operation: 'write' | 'create' | 'delete' | 'rename'
  /** null means file didn't exist before (create operation) */
  contentBefore: string | null
  /** For rename: the new path after renaming */
  newPath?: string
}

export interface Checkpoint {
  id: string
  sessionId: string
  timestamp: number
  toolCallId: string
  toolName: string
  description: string
  files: FileSnapshot[]
}

interface CheckpointIndexFile {
  filePath: string
  filePathHash: string
  operation: string
  wasNew: boolean
  newPath?: string
}

interface CheckpointIndexEntry {
  id: string
  sessionId: string
  timestamp: number
  toolCallId: string
  toolName: string
  description: string
  files: CheckpointIndexFile[]
}

interface CheckpointIndex {
  checkpoints: CheckpointIndexEntry[]
  /** Session baseline: filePath → content hash used to reconstruct baseline from disk */
  baseline?: Record<string, { checkpointId: string; filePathHash: string; wasNew: boolean }>
}

// === Service ===

class CheckpointService {
  private static instance: CheckpointService
  private checkpoints: Checkpoint[] = []
  private currentSessionId: string | null = null
  /** Absolute project path — Rust resolves it to app-managed project state. */
  private currentProjectPath: string | null = null
  /** Tracks which file paths were touched during this session (for session diff). */
  private sessionBaseline: Set<string> = new Set()
  /** Maps filePath → { checkpointId, filePathHash } for baseline persistence */
  private baselineIndex: Map<string, { checkpointId: string; filePathHash: string; wasNew: boolean }> = new Map()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistDirty = false

  static getInstance(): CheckpointService {
    if (!CheckpointService.instance) {
      CheckpointService.instance = new CheckpointService()
    }
    return CheckpointService.instance
  }

  // === Session lifecycle ===

  async initSession(projectPath: string, sessionId: string): Promise<void> {
    await this.flushPersist()
    this.currentProjectPath = projectPath
    this.currentSessionId = sessionId
    this.sessionBaseline.clear()
    this.baselineIndex.clear()

    // Load existing checkpoints for this session
    try {
      const indexJson = await invoke<string>('load_checkpoint_index', {
        projectPath: this.currentProjectPath,
        sessionId,
      })
      const index: CheckpointIndex = JSON.parse(indexJson)
      this.checkpoints = index.checkpoints.map(cp => ({
        ...cp,
        files: cp.files.map(f => ({
          filePath: f.filePath,
          filePathHash: f.filePathHash,
          operation: f.operation as FileSnapshot['operation'],
          contentBefore: f.wasNew ? null : '__stored_on_disk__',
          newPath: f.newPath,
        })),
      }))

      // Restore baseline index from persisted data
      if (index.baseline) {
        for (const [filePath, entry] of Object.entries(index.baseline)) {
          this.baselineIndex.set(filePath, entry)
          // Mark baseline as tracked (content loaded lazily on demand via getSessionDiff)
          this.sessionBaseline.add(filePath)
        }
      }
    } catch {
      this.checkpoints = []
    }
  }

  async clearSession(): Promise<void> {
    await this.flushPersist()
    this.checkpoints = []
    this.currentSessionId = null
    this.currentProjectPath = null
    this.sessionBaseline.clear()
    this.baselineIndex.clear()
  }

  // === Capture ===

  /**
   * Capture file state BEFORE a write/edit operation.
   * Called from DiffService.acceptDiff() before writing to disk.
   */
  async captureBeforeWrite(
    filePath: string,
    originalContent: string,
    isNewFile: boolean,
    toolCallId: string,
    toolName: string,
  ): Promise<void> {
    if (!this.currentProjectPath || !this.currentSessionId) return

    // Skip capture during revert to avoid race with streaming agent
    try {
      const { useCheckpointStore } = await import('../../stores/checkpointStore')
      if (useCheckpointStore.getState().isReverting) return
    } catch { /* import failure is non-critical */ }

    const filePathHash = await hashFilePath(filePath)
    const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const operation: FileSnapshot['operation'] = isNewFile ? 'create' : 'write'

    // Track session baseline (first snapshot wins)
    if (!this.sessionBaseline.has(filePath)) {
      this.sessionBaseline.add(filePath)
      this.baselineIndex.set(filePath, { checkpointId, filePathHash, wasNew: isNewFile })
    }

    // Store file content on disk
    if (isNewFile) {
      await invoke('save_checkpoint_new_marker', {
        projectPath: this.currentProjectPath,
        sessionId: this.currentSessionId,
        checkpointId,
        filePathHash,
      })
    } else {
      await invoke('save_checkpoint_file', {
        projectPath: this.currentProjectPath,
        sessionId: this.currentSessionId,
        checkpointId,
        filePathHash,
        content: originalContent,
      })
    }

    const checkpoint: Checkpoint = {
      id: checkpointId,
      sessionId: this.currentSessionId,
      timestamp: Date.now(),
      toolCallId,
      toolName,
      description: `${isNewFile ? 'Created' : 'Modified'} ${this.shortPath(filePath)}`,
      files: [{
        filePath,
        filePathHash,
        operation,
        // Content already on disk — don't keep in memory
        contentBefore: isNewFile ? null : '__stored_on_disk__',
      }],
    }

    this.checkpoints.push(checkpoint)
    this.enforceMaxCheckpoints()
    this.schedulePersist()
  }

  /**
   * Capture file state BEFORE a delete operation.
   */
  async captureBeforeDelete(
    filePath: string,
    content: string,
    toolCallId: string,
  ): Promise<void> {
    if (!this.currentProjectPath || !this.currentSessionId) return

    // Skip capture during revert to avoid race with streaming agent
    try {
      const { useCheckpointStore } = await import('../../stores/checkpointStore')
      if (useCheckpointStore.getState().isReverting) return
    } catch { /* import failure is non-critical */ }

    const filePathHash = await hashFilePath(filePath)
    const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

    // Track session baseline
    if (!this.sessionBaseline.has(filePath)) {
      this.sessionBaseline.add(filePath)
      this.baselineIndex.set(filePath, { checkpointId, filePathHash, wasNew: false })
    }

    await invoke('save_checkpoint_file', {
      projectPath: this.currentProjectPath,
      sessionId: this.currentSessionId,
      checkpointId,
      filePathHash,
      content,
    })

    const checkpoint: Checkpoint = {
      id: checkpointId,
      sessionId: this.currentSessionId,
      timestamp: Date.now(),
      toolCallId,
      toolName: 'delete_file',
      description: `Deleted ${this.shortPath(filePath)}`,
      files: [{
        filePath,
        filePathHash,
        operation: 'delete',
        contentBefore: '__stored_on_disk__',
      }],
    }

    this.checkpoints.push(checkpoint)
    this.enforceMaxCheckpoints()
    this.schedulePersist()
  }

  /**
   * Capture file state BEFORE a rename operation.
   */
  async captureBeforeRename(
    oldPath: string,
    newPath: string,
    content: string,
    toolCallId: string,
  ): Promise<void> {
    if (!this.currentProjectPath || !this.currentSessionId) return

    // Skip capture during revert to avoid race with streaming agent
    try {
      const { useCheckpointStore } = await import('../../stores/checkpointStore')
      if (useCheckpointStore.getState().isReverting) return
    } catch { /* import failure is non-critical */ }

    const filePathHash = await hashFilePath(oldPath)
    const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

    if (!this.sessionBaseline.has(oldPath)) {
      this.sessionBaseline.add(oldPath)
      this.baselineIndex.set(oldPath, { checkpointId, filePathHash, wasNew: false })
    }
    // Track the new path as "created by rename" so session diff shows it
    if (!this.sessionBaseline.has(newPath)) {
      this.sessionBaseline.add(newPath)
      this.baselineIndex.set(newPath, { checkpointId, filePathHash: await hashFilePath(newPath), wasNew: true })
    }

    await invoke('save_checkpoint_file', {
      projectPath: this.currentProjectPath,
      sessionId: this.currentSessionId,
      checkpointId,
      filePathHash,
      content,
    })

    const checkpoint: Checkpoint = {
      id: checkpointId,
      sessionId: this.currentSessionId,
      timestamp: Date.now(),
      toolCallId,
      toolName: 'rename_file',
      description: `Renamed ${this.shortPath(oldPath)}`,
      files: [{
        filePath: oldPath,
        filePathHash,
        operation: 'rename',
        contentBefore: '__stored_on_disk__',
        newPath,
      }],
    }

    this.checkpoints.push(checkpoint)
    this.enforceMaxCheckpoints()
    this.schedulePersist()
  }

  // === Revert ===

  /**
   * Revert to a specific checkpoint — restores all files from that checkpoint.
   * Returns the list of restored file paths.
   */
  async revertToCheckpoint(checkpointId: string): Promise<string[]> {
    if (!this.currentProjectPath || !this.currentSessionId) {
      throw new Error('No active session')
    }

    const idx = this.checkpoints.findIndex(cp => cp.id === checkpointId)
    if (idx === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }

    // Collect the EARLIEST checkpoint for each file path — that's the one whose
    // "before" content represents the true pre-modification state.
    // Also collect all rename newPaths that should be deleted (not restored).
    const fileToCheckpoint = new Map<string, { cpId: string; file: FileSnapshot }>()
    const renameNewPaths = new Set<string>()
    const checkpointsToRevert = this.checkpoints.slice(idx)
    for (const cp of checkpointsToRevert) {
      for (const file of cp.files) {
        // First occurrence wins (earliest checkpoint = original state)
        if (!fileToCheckpoint.has(file.filePath)) {
          fileToCheckpoint.set(file.filePath, { cpId: cp.id, file })
        }
        // Track all rename destinations — these are paths created by renames
        // and should only be deleted, never restored.
        if (file.operation === 'rename' && file.newPath) {
          renameNewPaths.add(file.newPath)
        }
      }
    }

    const restoredPaths: string[] = []

    // Delete rename destinations first (clean up files created by renames)
    for (const newPath of renameNewPaths) {
      try {
        await invoke('delete_file_or_directory', { path: newPath })
        restoredPaths.push(newPath)
      } catch {
        // File might already be gone
      }
    }

    for (const [filePath, { cpId, file }] of fileToCheckpoint) {
      // Skip if this filePath is a rename destination — it was already
      // deleted above and should not be restored.
      if (renameNewPaths.has(filePath)) continue

      try {
        await this.revertFile(cpId, file)
        restoredPaths.push(file.filePath)
      } catch (err) {
        logger.error('checkpoint', `Failed to revert file ${file.filePath}:`, err)
      }
    }

    // Remove reverted checkpoints
    const removed = this.checkpoints.slice(idx)
    this.checkpoints = this.checkpoints.slice(0, idx)

    // Clear baseline entries for files that were fully reverted —
    // they're back to their original state, no need to track them.
    for (const [filePath] of fileToCheckpoint) {
      this.sessionBaseline.delete(filePath)
      this.baselineIndex.delete(filePath)
    }
    // Also clean up rename destination baseline entries
    for (const newPath of renameNewPaths) {
      this.sessionBaseline.delete(newPath)
      this.baselineIndex.delete(newPath)
    }

    this.persistDirty = true
    await this.flushPersist()

    // Clean up snapshot files, protecting any still referenced by the baseline
    const baselineCheckpointIds = new Set(
      Array.from(this.baselineIndex.values()).map(e => e.checkpointId)
    )
    const safeToDelete = removed.filter(cp => !baselineCheckpointIds.has(cp.id))
    if (safeToDelete.length > 0) {
      this.cleanupSnapshotFiles(safeToDelete).catch(err =>
        logger.error('checkpoint', 'Failed to cleanup snapshot files:', err)
      )
    }

    return [...new Set(restoredPaths)] // deduplicate
  }

  /**
   * Revert ALL checkpoints in the current session — restores every file
   * to its pre-agent state. Uses the baselineIndex to identify the true
   * original content for each file, avoiding issues with multiple
   * checkpoints touching the same file.
   *
   * Returns { restored, failed } so the UI can report partial failures.
   */
  async revertAll(): Promise<{ restored: string[]; failed: { path: string; error: string }[] }> {
    if (!this.currentProjectPath || !this.currentSessionId) {
      throw new Error('No active session')
    }

    const restoredPaths: string[] = []
    const failures: { path: string; error: string }[] = []

    // Collect rename destinations from all checkpoints — these are files
    // created by renames and must be deleted, not restored.
    const renameNewPaths = new Set<string>()
    for (const cp of this.checkpoints) {
      for (const file of cp.files) {
        if (file.operation === 'rename' && file.newPath) {
          renameNewPaths.add(file.newPath)
        }
      }
    }

    // Step 1: Delete rename destinations first (cleanup, not counted as restore)
    for (const newPath of renameNewPaths) {
      try {
        await invoke('delete_file_or_directory', { path: newPath })
      } catch (err) {
        // File might already be gone — not a critical failure
        logger.warn('checkpoint', `Could not delete rename destination ${newPath}:`, err)
      }
    }

    // Step 2: Restore each baseline file to its pre-session state
    for (const [filePath, baselineEntry] of this.baselineIndex) {
      // Skip rename destinations (already handled above)
      if (renameNewPaths.has(filePath)) continue

      try {
        if (baselineEntry.wasNew) {
          // File was created by agent — delete it
          await invoke('delete_file_or_directory', { path: filePath })
          restoredPaths.push(filePath)
        } else {
          // File existed before — restore original content
          const content = await this.loadContentFromDisk(
            baselineEntry.checkpointId,
            baselineEntry.filePathHash,
          )
          await invoke('write_file', { path: filePath, content })
          restoredPaths.push(filePath)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('checkpoint', `Failed to revert ${filePath}:`, msg)
        failures.push({ path: filePath, error: msg })
      }
    }

    // Step 3: Bump fsVersion so all caches refresh (must complete before
    // clearing checkpoints — otherwise caches miss the invalidation signal)
    try { (await import('../fsVersion')).bumpFsVersion('revertAll') } catch { /* non-critical */ }

    // Step 4: Clear all state
    const removedCheckpoints = [...this.checkpoints]
    this.checkpoints = []
    this.sessionBaseline.clear()
    this.baselineIndex.clear()
    this.persistDirty = true
    await this.flushPersist()

    // Step 5: Cleanup snapshot files from disk
    this.cleanupSnapshotFiles(removedCheckpoints).catch(err =>
      logger.error('checkpoint', 'Failed to cleanup snapshot files after revertAll:', err),
    )

    return { restored: [...new Set(restoredPaths)], failed: failures }
  }

  private async revertFile(checkpointId: string, file: FileSnapshot): Promise<void> {
    if (file.operation === 'create') {
      // File was created by agent — delete it to undo
      // (may already be gone if a later rename moved it)
      try {
        await invoke('delete_file_or_directory', { path: file.filePath })
      } catch {
        // File already removed — expected when a rename moved it
      }
    } else {
      // write, delete, or rename — restore original content at original path
      // (rename newPath cleanup is handled separately by the caller)
      const content = await this.loadContentFromDisk(checkpointId, file.filePathHash)
      await invoke('write_file', { path: file.filePath, content })
    }
    // Reverts are filesystem mutations — bump the fs version so caches that
    // depend on file state (system prompt tree) are rebuilt on next read.
    import('../fsVersion').then(m => m.bumpFsVersion(`revert:${file.filePath}`)).catch(() => {})
  }

  /**
   * Revert the most recent checkpoint.
   */
  async revertLast(): Promise<string[]> {
    if (this.checkpoints.length === 0) {
      throw new Error('No checkpoints to revert')
    }
    const last = this.checkpoints[this.checkpoints.length - 1]
    return this.revertToCheckpoint(last.id)
  }

  // === Query ===

  getCheckpoints(): Checkpoint[] {
    return [...this.checkpoints]
  }

  /** Returns parent/filename for disambiguation (e.g. "components/index.ts"). */
  private shortPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/')
    return parts.length >= 2 ? parts.slice(-2).join('/') : parts[0] || filePath
  }

  /**
   * Get session diff: files that changed since the session started.
   * Returns a map of filePath -> { before, after }.
   */
  async getSessionDiff(): Promise<Array<{ filePath: string; before: string | null; after: string | null }>> {
    // Build all diff tasks and run them in parallel
    const entries = Array.from(this.sessionBaseline).map(filePath => ({
      filePath,
      baselineEntry: this.baselineIndex.get(filePath),
    }))

    const results = await Promise.all(
      entries.map(async ({ filePath, baselineEntry }) => {
        // Load current content
        let after: string | null = null
        try {
          after = await invoke<string>('read_file', { path: filePath })
        } catch {
          after = null
        }

        // For new files: changed if the file still exists
        if (baselineEntry?.wasNew) {
          return after !== null ? { filePath, before: null, after } : null
        }

        // Load baseline content
        let before: string | null = null
        if (baselineEntry) {
          try {
            before = await this.loadContentFromDisk(baselineEntry.checkpointId, baselineEntry.filePathHash)
          } catch {
            before = null
          }
        }

        return before !== after ? { filePath, before, after } : null
      })
    )

    return results.filter((r): r is NonNullable<typeof r> => r !== null)
  }

  // === Cleanup ===

  async deleteSessionCheckpoints(projectPath: string, sessionId: string): Promise<void> {
    try {
      await invoke('delete_checkpoint_session', { projectPath, sessionId })
    } catch (err) {
      logger.error('checkpoint', 'Failed to delete session checkpoints:', err)
    }

    // Clear in-memory if it's the current session
    if (this.currentSessionId === sessionId) {
      this.checkpoints = []
      this.sessionBaseline.clear()
      this.baselineIndex.clear()
    }
  }

  /**
   * Delete EVERY checkpoint (every session, every file snapshot) for a project.
   * Called from projectStore.deleteProject so checkpoints don't outlive the
   * project they reference. Also clears in-memory state if the project being
   * deleted happens to be the one this service is currently scoped to.
   *
   * The Rust command is still useful for "Clear checkpoints" surfaces that
   * wipe snapshots without deleting the project.
   */
  async deleteAllProjectCheckpoints(projectPath: string): Promise<void> {
    try {
      await invoke('delete_checkpoint_project', { projectPath })
      // Drop in-memory caches if we're deleting the project we're scoped to.
      if (this.currentProjectPath === projectPath) {
        this.checkpoints = []
        this.sessionBaseline.clear()
        this.baselineIndex.clear()
        this.currentProjectPath = null
        this.currentSessionId = null
      }
    } catch (err) {
      logger.error('checkpoint', 'Failed to delete project checkpoints:', err)
    }
  }

  // === Internal ===

  private async loadContentFromDisk(checkpointId: string, filePathHash: string): Promise<string> {
    return invoke<string>('load_checkpoint_file', {
      projectPath: this.currentProjectPath,
      sessionId: this.currentSessionId,
      checkpointId,
      filePathHash,
    })
  }

  private enforceMaxCheckpoints(): void {
    if (this.checkpoints.length > MAX_CHECKPOINTS_PER_SESSION) {
      const removed = this.checkpoints.slice(0, this.checkpoints.length - MAX_CHECKPOINTS_PER_SESSION)
      this.checkpoints = this.checkpoints.slice(-MAX_CHECKPOINTS_PER_SESSION)

      // Protect baseline: if any removed checkpoint is referenced by the baseline,
      // skip its file cleanup so getSessionDiff can still load it.
      const baselineCheckpointIds = new Set(
        Array.from(this.baselineIndex.values()).map(e => e.checkpointId)
      )
      const safeToDelete = removed.filter(cp => !baselineCheckpointIds.has(cp.id))

      if (safeToDelete.length > 0) {
        this.cleanupSnapshotFiles(safeToDelete).catch(err =>
          logger.error('checkpoint', 'Failed to cleanup old snapshots:', err)
        )
      }
    }
  }

  /** Delete snapshot directories for a list of removed checkpoints. */
  private async cleanupSnapshotFiles(removed: Checkpoint[]): Promise<void> {
    if (!this.currentProjectPath || !this.currentSessionId) return
    for (const cp of removed) {
      try {
        // Each checkpoint stores files under files/{checkpointId}/
        await invoke('delete_checkpoint_files', {
          projectPath: this.currentProjectPath,
          sessionId: this.currentSessionId,
          checkpointId: cp.id,
        })
      } catch {
        // Best effort — directory might not exist
      }
    }
  }

  private schedulePersist(): void {
    this.persistDirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (this.persistDirty) {
        this.persistDirty = false
        this.persistIndex().catch(err =>
          logger.error('checkpoint', 'Failed to persist checkpoint index:', err)
        )
      }
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Flush any pending persist immediately (awaitable). */
  async flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (this.persistDirty) {
      this.persistDirty = false
      try {
        await this.persistIndex()
      } catch (err) {
        logger.error('checkpoint', 'Failed to flush checkpoint index:', err)
      }
    }
  }

  private async persistIndex(): Promise<void> {
    if (!this.currentProjectPath || !this.currentSessionId) return

    // Build baseline for persistence
    const baseline: Record<string, { checkpointId: string; filePathHash: string; wasNew: boolean }> = {}
    for (const [filePath, entry] of this.baselineIndex) {
      baseline[filePath] = entry
    }

    const index: CheckpointIndex = {
      checkpoints: this.checkpoints.map(cp => ({
        id: cp.id,
        sessionId: cp.sessionId,
        timestamp: cp.timestamp,
        toolCallId: cp.toolCallId,
        toolName: cp.toolName,
        description: cp.description,
        files: cp.files.map(f => ({
          filePath: f.filePath,
          filePathHash: f.filePathHash,
          operation: f.operation,
          wasNew: f.contentBefore === null,
          newPath: f.newPath,
        })),
      })),
      baseline,
    }

    await invoke('save_checkpoint_index', {
      projectPath: this.currentProjectPath,
      sessionId: this.currentSessionId,
      indexJson: JSON.stringify(index),
    })
  }
}

export default CheckpointService
