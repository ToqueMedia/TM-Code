import { useCallback, useMemo } from 'react';
import { useEditorRepository } from '../stores/editorStore';

// Hook para arquivos abertos - só re-renderiza quando openFiles muda
export function useOpenFiles() {
  return useEditorRepository(state => state.openFiles);
}

// Hook para arquivo ativo - só re-renderiza quando activeFile muda  
export function useActiveFile() {
  return useEditorRepository(state => state.activeFile);
}

// Hook para posições do cursor - só re-renderiza quando cursorPositions muda
export function useCursorPositions() {
  return useEditorRepository(state => state.cursorPositions);
}

// Hook para ações do editor - memoizado para evitar re-renders desnecessários
export function useEditorActions() {
  return useEditorRepository(
    state => ({
      openFile: state.openFile,
      closeFile: state.closeFile,
      setActiveFile: state.setActiveFile,
      updateFileContent: state.updateFileContent,
      setCursorPosition: state.setCursorPosition,
      updateEditorState: state.updateEditorState,
      undo: state.undo,
      redo: state.redo,
      saveFile: state.saveFile,
      saveAllFiles: state.saveAllFiles,
    })
  );
}

// Hook para stacks de undo/redo - só re-renderiza quando essas stacks mudam
export function useUndoRedoStacks() {
  return useEditorRepository(
    state => ({
      undoStack: state.undoStack,
      redoStack: state.redoStack,
    })
  );
}

// Hook para estado de um arquivo específico
export function useFileState(path: string) {
  return useEditorRepository(
    useCallback(
      (state) => {
        const file = state.openFiles.find(f => f.path === path);
        if (!file) return null;
        
        return {
          content: file.content,
          language: file.language,
          isDirty: file.isDirty,
          cursorPosition: file.cursorPosition,
          isActive: state.activeFile === path
        };
      },
      [path]
    )
  );
}

// Hook combinado otimizado para o CodeEditor - agrupa seletores relacionados
export function useCodeEditorState() {
  const openFiles = useOpenFiles();
  const activeFile = useActiveFile();
  const actions = useEditorActions();
  
  // Callbacks memoizados para evitar re-renders em componentes filhos
  const handleFileSelect = useCallback((path: string) => {
    actions.openFile(path);
  }, [actions]);
  
  const handleCloseFile = useCallback((path: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    actions.closeFile(path);
  }, [actions]);
  
  const handleSetActiveFile = useCallback((path: string | null) => {
    actions.setActiveFile(path);
  }, [actions]);
  
  // Dados derivados memoizados
  const hasOpenFiles = useMemo(() => openFiles.length > 0, [openFiles.length]);
  const dirtyFiles = useMemo(() => openFiles.filter(f => f.isDirty), [openFiles]);
  const hasDirtyFiles = useMemo(() => dirtyFiles.length > 0, [dirtyFiles.length]);
  
  return {
    // Estados
    openFiles,
    activeFile,
    hasOpenFiles,
    dirtyFiles,
    hasDirtyFiles,
    
    // Actions otimizadas
    handleFileSelect,
    handleCloseFile,
    handleSetActiveFile,
    updateFileContent: actions.updateFileContent,
    saveFile: actions.saveFile,
    saveAllFiles: actions.saveAllFiles,
  };
}

// Hook específico para o Monaco Editor
export function useMonacoEditorState(path: string) {
  const fileState = useFileState(path);
  const actions = useEditorActions();
  
  const handleContentChange = useCallback((content: string) => {
    actions.updateFileContent(path, content);
  }, [actions, path]);
  
  const handleCursorChange = useCallback((line: number, column: number) => {
    actions.setCursorPosition(path, line, column);
  }, [actions, path]);
  
  const handleSave = useCallback(async () => {
    await actions.saveFile(path);
  }, [actions, path]);
  
  const handleUndo = useCallback(() => {
    actions.undo(path);
  }, [actions, path]);
  
  const handleRedo = useCallback(() => {
    actions.redo(path);
  }, [actions, path]);
  
  return {
    fileState,
    handleContentChange,
    handleCursorChange,
    handleSave,
    handleUndo,
    handleRedo,
  };
}