// Project state hooks
export {
  useCurrentProject,
  useRecentProjects,
  useProjectLoading,
  useProjectError,
  useWindowState,
  useUnsavedChanges,
  useProjectActions,
  useWelcomeScreenState,
  useAppState,
  useUnsavedChangesState,
  useWindowStateManager,
} from './useProjectState'

// Editor state hooks
export {
  useOpenFiles,
  useActiveFile,
  useCursorPositions,
  useUndoRedoStacks,
  useFileContent,
  useFileLanguage,
  useFileIsDirty,
  useFileCursorPosition,
  useFileIsActive,
  useFileExists,
  useCodeEditorState,
  useMonacoEditorState,
} from './useEditorState'

// Monaco theme
export { useMonacoTheme } from './useMonacoTheme'

// Keyboard shortcuts
export { useKeyboardShortcuts } from './useKeyboardShortcuts'

// File cache (React Query)
export {
  fileKeys,
  useFileContent as useFileCacheContent,
  useSaveFile,
  useFileMetadata,
  usePrefetchFile,
  useInvalidateFileCache,
  useOptimisticFileUpdate,
  useBatchFileOperations,
} from './useFileCache'

// File tree worker
export { useFileTreeWorker } from './useFileTreeWorker'
export type {
  WorkerMessageType,
  WorkerResponseType,
  WorkerFileTreeFilter,
  FileTreeOptions,
  WorkerMessage,
  WorkerResponse,
  FileTreeNode,
  FileTreeIndex as WorkerFileTreeIndex,
  ParsedFileTreeResult,
} from './useFileTreeWorker'

// Dialog
export { useDialog } from './useDialog'

// Window controls
export { useWindowControls } from './useWindowControls'

// Prompt logic (shared between chat and cmd mode)
export { usePromptLogic } from './usePromptLogic'

// CMD-mode scroll follow
export { useCmdScrollFollow } from './useCmdScrollFollow'
