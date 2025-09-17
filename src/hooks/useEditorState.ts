import { useCallback, useMemo, useRef } from 'react';
import { shallow } from 'zustand/shallow';
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


// Hook para stacks de undo/redo - só re-renderiza quando essas stacks mudam
export function useUndoRedoStacks() {
  return useEditorRepository(
    state => ({
      undoStack: state.undoStack,
      redoStack: state.redoStack,
    }),
    shallow
  );
}

// Hook para estado de um arquivo específico - retorna valores primitivos separados
export function useFileContent(path: string) {
  return useEditorRepository(
    state => state.openFiles.find(f => f.path === path)?.content ?? ''
  );
}

export function useFileLanguage(path: string) {
  return useEditorRepository(
    state => state.openFiles.find(f => f.path === path)?.language ?? 'plaintext'
  );
}

export function useFileIsDirty(path: string) {
  return useEditorRepository(
    state => state.openFiles.find(f => f.path === path)?.isDirty ?? false
  );
}

// Valor estável padrão para cursor position
const DEFAULT_CURSOR_POSITION = { line: 1, column: 1 };

export function useFileCursorPosition(path: string) {
  return useEditorRepository(
    state => state.openFiles.find(f => f.path === path)?.cursorPosition ?? DEFAULT_CURSOR_POSITION,
    shallow
  );
}

export function useFileIsActive(path: string) {
  return useEditorRepository(
    state => state.activeFile === path
  );
}

export function useFileExists(path: string) {
  return useEditorRepository(
    state => state.openFiles.some(f => f.path === path)
  );
}

// Hook combinado otimizado para o CodeEditor - agrupa seletores relacionados
export function useCodeEditorState() {
  const openFiles = useOpenFiles();
  const activeFile = useActiveFile();
  
  // Seletores individuais para ações
  const openFile = useEditorRepository(state => state.openFile);
  const closeFile = useEditorRepository(state => state.closeFile);
  const setActiveFile = useEditorRepository(state => state.setActiveFile);
  const updateFileContent = useEditorRepository(state => state.updateFileContent);
  const saveFile = useEditorRepository(state => state.saveFile);
  const saveAllFiles = useEditorRepository(state => state.saveAllFiles);
  
  // Callbacks simples sem over-optimization
  const handleFileSelect = useCallback((path: string) => {
    openFile(path);
  }, [openFile]);
  
  const handleCloseFile = useCallback((path: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    closeFile(path);
  }, [closeFile]);
  
  const handleSetActiveFile = useCallback((path: string | null) => {
    setActiveFile(path);
  }, [setActiveFile]);
  
  // Dados simples sem over-memoization
  const hasOpenFiles = openFiles.length > 0;
  const dirtyFiles = openFiles.filter(f => f.isDirty);
  const hasDirtyFiles = dirtyFiles.length > 0;
  
  return {
    // Estados
    openFiles,
    activeFile,
    hasOpenFiles,
    dirtyFiles,
    hasDirtyFiles,
    
    // Actions
    handleFileSelect,
    handleCloseFile,
    handleSetActiveFile,
    updateFileContent,
    saveFile,
    saveAllFiles,
  };
}

// Hook específico para o Monaco Editor
export function useMonacoEditorState(path: string) {
  // Usar hooks primitivos para evitar loops infinitos
  const content = useFileContent(path);
  const language = useFileLanguage(path);
  const isDirty = useFileIsDirty(path);
  const cursorPosition = useFileCursorPosition(path);
  const isActive = useFileIsActive(path);
  const exists = useFileExists(path);
  
  // Seletores individuais de ações
  const updateFileContent = useEditorRepository(state => state.updateFileContent);
  const setCursorPosition = useEditorRepository(state => state.setCursorPosition);
  const saveFile = useEditorRepository(state => state.saveFile);
  const undo = useEditorRepository(state => state.undo);
  const redo = useEditorRepository(state => state.redo);
  
  const handleContentChange = useCallback((content: string) => {
    updateFileContent(path, content);
  }, [updateFileContent, path]);
  
  const handleCursorChange = useCallback((line: number, column: number) => {
    setCursorPosition(path, line, column);
  }, [setCursorPosition, path]);
  
  const handleSave = useCallback(async () => {
    await saveFile(path);
  }, [saveFile, path]);
  
  const handleUndo = useCallback(() => {
    undo(path);
  }, [undo, path]);
  
  const handleRedo = useCallback(() => {
    redo(path);
  }, [redo, path]);
  
  // Retornar objeto com valores primitivos estáveis
  return {
    // File state
    content,
    language,
    isDirty,
    cursorPosition,
    isActive,
    exists,
    
    // Actions
    handleContentChange,
    handleCursorChange,
    handleSave,
    handleUndo,
    handleRedo,
  };
}
