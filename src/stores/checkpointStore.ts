import { create } from 'zustand'
import CheckpointService, { Checkpoint } from '../services/agent/checkpointService'
import { useFileTreeRepository } from './fileTreeStore'
import { useEditorRepository } from './editorStore'
import { logger } from '../utils/logger'

interface SessionDiffEntry {
  filePath: string
  before: string | null
  after: string | null
}

interface RevertAllResult {
  restored: string[]
  failed: { path: string; error: string }[]
}

interface CheckpointState {
  checkpoints: Checkpoint[]
  isReverting: boolean
  /** Paths restored by the last revert — consumed by UI to show system message */
  lastRevertedPaths: string[]
  /** Result of the last revertAll — includes partial failures for UI display */
  lastRevertAllResult: RevertAllResult | null
  sessionDiff: SessionDiffEntry[]
  isLoadingDiff: boolean
}

interface CheckpointActions {
  syncFromService: () => void
  revertToCheckpoint: (checkpointId: string) => Promise<void>
  revertLast: () => Promise<void>
  revertAll: () => Promise<{ restored: string[]; failed: { path: string; error: string }[] }>
  loadSessionDiff: () => Promise<void>
  clearLastRevertedPaths: () => void
  clear: () => void
}

async function refreshAfterRevert(restoredPaths: string[]) {
  useFileTreeRepository.getState().refresh()
  const editorState = useEditorRepository.getState()
  for (const path of restoredPaths) {
    if (editorState.openFiles.some(f => f.path === path)) {
      await editorState.refreshFileContent(path)
    }
  }
}

export const useCheckpointStore = create<CheckpointState & CheckpointActions>()((set) => ({
  checkpoints: [],
  isReverting: false,
  lastRevertedPaths: [],
  lastRevertAllResult: null,
  sessionDiff: [],
  isLoadingDiff: false,

  syncFromService: () => {
    const service = CheckpointService.getInstance()
    const next = service.getCheckpoints()
    // Only update if checkpoint count changed to avoid unnecessary re-renders
    // during rapid agent tool calls (new array reference every time)
    const prev = useCheckpointStore.getState().checkpoints
    if (prev.length !== next.length || prev[prev.length - 1]?.id !== next[next.length - 1]?.id) {
      set({ checkpoints: next, sessionDiff: [] })
    }
  },

  revertToCheckpoint: async (checkpointId: string) => {
    set({ isReverting: true })
    try {
      const service = CheckpointService.getInstance()
      const restoredPaths = await service.revertToCheckpoint(checkpointId)

      await refreshAfterRevert(restoredPaths)

      set({
        checkpoints: service.getCheckpoints(),
        lastRevertedPaths: restoredPaths,
        isReverting: false,
      })
    } catch (err) {
      logger.error('checkpoint', 'Revert failed:', err)
      set({ isReverting: false })
    }
  },

  revertLast: async () => {
    set({ isReverting: true })
    try {
      const service = CheckpointService.getInstance()
      const restoredPaths = await service.revertLast()

      await refreshAfterRevert(restoredPaths)

      set({
        checkpoints: service.getCheckpoints(),
        lastRevertedPaths: restoredPaths,
        isReverting: false,
      })
    } catch (err) {
      logger.error('checkpoint', 'Revert last failed:', err)
      set({ isReverting: false })
    }
  },

  revertAll: async () => {
    set({ isReverting: true })
    try {
      const service = CheckpointService.getInstance()
      const result = await service.revertAll()

      await refreshAfterRevert(result.restored)

      set({
        checkpoints: [],
        lastRevertedPaths: result.restored,
        lastRevertAllResult: result,
        sessionDiff: [],
        isReverting: false,
      })

      return result
    } catch (err) {
      logger.error('checkpoint', 'Revert all failed:', err)
      set({ isReverting: false })
      throw err
    }
  },

  loadSessionDiff: async () => {
    set({ isLoadingDiff: true })
    try {
      const service = CheckpointService.getInstance()
      const diffs = await service.getSessionDiff()
      set({ sessionDiff: diffs, isLoadingDiff: false })
    } catch (err) {
      logger.error('checkpoint', 'Failed to load session diff:', err)
      set({ isLoadingDiff: false })
    }
  },

  clearLastRevertedPaths: () => {
    set({ lastRevertedPaths: [], lastRevertAllResult: null })
  },

  clear: () => {
    set({
      checkpoints: [],
      isReverting: false,
      lastRevertedPaths: [],
      lastRevertAllResult: null,
      sessionDiff: [],
      isLoadingDiff: false,
    })
  },
}))
