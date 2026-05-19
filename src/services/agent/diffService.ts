import { invoke } from '@/utils/invokeMetrics'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useEditorRepository } from '../../stores/editorStore'
import CheckpointService from './checkpointService'
import { useCheckpointStore } from '../../stores/checkpointStore'

export interface DiffResult {
  id: string
  filePath: string
  originalContent: string
  newContent: string
  isNewFile: boolean
  status: 'pending' | 'accepted' | 'rejected'
  /** Tool call ID that produced this diff (for checkpoint tracking). */
  toolCallId?: string
  /** Tool name that produced this diff (for checkpoint tracking). */
  toolName?: string
}

class DiffService {
  private static instance: DiffService
  private pendingDiffs: Map<string, DiffResult> = new Map()

  static getInstance(): DiffService {
    if (!DiffService.instance) {
      DiffService.instance = new DiffService()
    }
    return DiffService.instance
  }

  async createDiff(filePath: string, newContent: string): Promise<DiffResult> {
    let originalContent = ''
    let isNewFile = true

    try {
      originalContent = await invoke<string>('read_file', { path: filePath })
      isNewFile = false
    } catch {
      isNewFile = true
    }

    const diff: DiffResult = {
      id: crypto.randomUUID(),
      filePath,
      originalContent,
      newContent,
      isNewFile,
      status: 'pending',
    }

    this.pendingDiffs.set(diff.id, diff)
    return diff
  }

  registerDiff(diff: DiffResult): void {
    this.pendingDiffs.set(diff.id, diff)
  }

  async acceptDiff(diffId: string): Promise<void> {
    const diff = this.pendingDiffs.get(diffId)
    if (!diff) return

    // Capture checkpoint BEFORE writing to disk
    try {
      const checkpointService = CheckpointService.getInstance()
      await checkpointService.captureBeforeWrite(
        diff.filePath,
        diff.originalContent,
        diff.isNewFile,
        diff.toolCallId || diffId,
        diff.toolName || (diff.isNewFile ? 'create_file' : 'write_file'),
      )
      useCheckpointStore.getState().syncFromService()
    } catch {
      // Checkpoint failure should not block file writes
    }

    await invoke('write_file', { path: diff.filePath, content: diff.newContent })
    diff.status = 'accepted'
    this.pendingDiffs.delete(diffId)

    // Refresh file tree
    useFileTreeRepository.getState().refresh()

    // Refresh editor if file is open
    const editorState = useEditorRepository.getState()
    if (editorState.openFiles.some(f => f.path === diff.filePath)) {
      await editorState.refreshFileContent(diff.filePath)
    }
  }

  rejectDiff(diffId: string): void {
    const diff = this.pendingDiffs.get(diffId)
    if (!diff) return

    diff.status = 'rejected'
    this.pendingDiffs.delete(diffId)
  }

  async acceptAllDiffs(): Promise<void> {
    const diffs = Array.from(this.pendingDiffs.values())
    for (const diff of diffs) {
      await this.acceptDiff(diff.id)
    }
  }

  rejectAllDiffs(): void {
    const diffs = Array.from(this.pendingDiffs.values())
    for (const diff of diffs) {
      this.rejectDiff(diff.id)
    }
  }

  getPendingDiffs(): DiffResult[] {
    return Array.from(this.pendingDiffs.values()).filter(d => d.status === 'pending')
  }
}

export default DiffService
