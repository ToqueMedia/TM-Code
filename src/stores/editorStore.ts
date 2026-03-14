import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FileService } from '../services/fileService';
import UnsavedChangesService from '../services/unsavedChangesService';
import { AutoSaveQueue } from '../utils/autoSaveQueue';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { logger } from '../utils/logger';

interface EditorFile {
  path: string;
  content: string;
  language: string;
  isDirty: boolean;
  cursorPosition?: { line: number; column: number };
}

interface EditorState {
  openFiles: EditorFile[];
  activeFile: string | null;
  cursorPositions: Record<string, [number, number]>; // line, column
  undoStack: Record<string, string[]>;
  redoStack: Record<string, string[]>;
}

interface EditorActions {
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string | null) => void;
  updateFileContent: (path: string, content: string) => void;
  setCursorPosition: (path: string, line: number, column: number) => void;
  updateEditorState: (path: string, state: Partial<EditorFile>) => void;
  getEditorState: (path: string) => Partial<EditorFile> | undefined;
  undo: (path: string) => void;
  redo: (path: string) => void;
  saveFile: (path: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  refreshFileContent: (path: string) => Promise<void>;
  renameOpenFile: (oldPath: string, newPath: string) => void;
  closeAllFiles: () => void;
}

// Get language from file extension
const getLanguageFromExtension = (filePath: string): string => {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  switch (extension) {
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'md':
      return 'markdown';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'cpp':
    case 'cc':
    case 'cxx':
      return 'cpp';
    case 'c':
      return 'c';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'php':
      return 'php';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
};

const unsavedChangesService = UnsavedChangesService.getInstance();
const autoSaveQueue = AutoSaveQueue.getInstance();

export const useEditorRepository = create<EditorState & EditorActions>()(
  persist(
    (set, get) => ({
      openFiles: [],
      activeFile: null,
      cursorPositions: {},
      undoStack: {},
      redoStack: {},

      openFile: async (path: string) => {
        logger.debug('editor', 'Opening file:', path);
        set({ activeFile: path });
        
        // Check if file is already open
        const existingFile = get().openFiles.find(f => f.path === path);
        if (existingFile) {
          logger.debug('editor', 'File already open:', path);
          // Refresh content from file system to ensure we have the latest version
          try {
            logger.debug('editor', 'Refreshing content for:', path);
            const content = await FileService.readFile(path);
            if (content !== existingFile.content) {
              logger.debug('editor', 'Content changed for:', path);
              set(state => {
                const fileIndex = state.openFiles.findIndex(f => f.path === path);
                if (fileIndex === -1) return state;
                
                const updatedFiles = [...state.openFiles];
                updatedFiles[fileIndex] = {
                  ...updatedFiles[fileIndex],
                  content,
                  isDirty: false // Reset dirty flag since we're loading fresh content
                };
                
                return { openFiles: updatedFiles };
              });
            }
          } catch (error) {
            logger.error('editor', `Failed to refresh file content ${path}:`, error);
          }
          return;
        }
        
        try {
          logger.debug('editor', 'Reading file content for:', path);
          const content = await FileService.readFile(path);
          const language = getLanguageFromExtension(path);
          logger.debug('editor', `File loaded successfully: ${path} (${content.length} chars, ${language})`);
          
          set(state => ({
            openFiles: [
              ...state.openFiles,
              {
                path,
                content,
                language,
                isDirty: false
              }
            ]
          }));
        } catch (error) {
          logger.error('editor', `Failed to open file ${path}:`, error);
          throw error;
        }
      },

      closeFile: (path: string) => {
        const removeFile = () => {
          set(state => {
            const updated = state.openFiles.filter(ff => ff.path !== path);
            const cursorPositions = { ...state.cursorPositions };
            delete cursorPositions[path];
            unsavedChangesService.markFileAsClean(path);
            let activeFile = state.activeFile;
            if (activeFile === path) {
              activeFile = updated.length > 0 ? updated[0].path : null;
            }
            return { openFiles: updated, activeFile, cursorPositions };
          });
        };

        const f = get().openFiles.find(f => f.path === path);
        if (f?.isDirty) {
          Promise.resolve().then(async () => {
            // Re-check state after async gap — file may have been saved or already closed
            const current = get().openFiles.find(ff => ff.path === path);
            if (!current) return; // Already closed
            if (!current.isDirty) {
              removeFile();
              return;
            }
            const ok = await tauriConfirm(`Close "${path}" without saving?`, { title: 'Unsaved changes', kind: 'warning' });
            if (!ok) return;
            // Re-verify file still exists before removing
            if (!get().openFiles.some(ff => ff.path === path)) return;
            removeFile();
          });
          return;
        }
        removeFile();
      },

      setActiveFile: (path: string | null) => {
        set({ activeFile: path });
      },

      updateFileContent: (path: string, content: string) => {
        set(state => {
          const fileIndex = state.openFiles.findIndex(f => f.path === path);
          if (fileIndex === -1) return state;
          
          const oldContent = state.openFiles[fileIndex].content;
          
          // Se o conteúdo não mudou, não faz nada
          if (oldContent === content) {
            return state;
          }
          
          const updatedFiles = [...state.openFiles];
          updatedFiles[fileIndex] = {
            ...updatedFiles[fileIndex],
            content,
            isDirty: true
          };
          
          // Update undo/redo stacks - com limite para evitar memory leaks
          const undoStack = { ...state.undoStack };
          if (!undoStack[path]) {
            undoStack[path] = [];
          }
          undoStack[path].push(oldContent);
          
          // Limita o stack de undo a 50 itens
          if (undoStack[path].length > 50) {
            undoStack[path] = undoStack[path].slice(-50);
          }
          
          // Clear redo stack when making new changes
          const redoStack = { ...state.redoStack };
          delete redoStack[path];
          
          // Mark file as dirty
          unsavedChangesService.markFileAsDirty(path);
          
          // Adiciona à queue de auto-save (apenas se realmente mudou)
          autoSaveQueue.addToQueue(path, content);
          
          return { 
            openFiles: updatedFiles,
            undoStack,
            redoStack
          };
        });
      },

      setCursorPosition: (path: string, line: number, column: number) => {
        set(state => {
          const cursorPositions = {
            ...state.cursorPositions,
            [path]: [line, column] as [number, number]
          };
          return { cursorPositions };
        });
      },

      updateEditorState: (path: string, stateUpdate: Partial<EditorFile>) => {
        set(s => {
          const fileIndex = s.openFiles.findIndex(f => f.path === path);
          if (fileIndex === -1) return s;
          
          const updatedFiles = [...s.openFiles];
          updatedFiles[fileIndex] = {
            ...updatedFiles[fileIndex],
            ...stateUpdate
          };
          
          return { openFiles: updatedFiles };
        });
      },

      getEditorState: (path: string) => {
        const { openFiles } = get();
        const file = openFiles.find(f => f.path === path);
        return file ? {
          content: file.content,
          language: file.language,
          isDirty: file.isDirty,
          cursorPosition: file.cursorPosition
        } : undefined;
      },

      undo: (path: string) => {
        set(state => {
          const undoStack = { ...state.undoStack };
          const redoStack = { ...state.redoStack };
          
          if (!undoStack[path] || undoStack[path].length === 0) {
            return state;
          }
          
          const fileIndex = state.openFiles.findIndex(f => f.path === path);
          if (fileIndex === -1) return state;
          
          const currentContent = state.openFiles[fileIndex].content;
          const previousContent = undoStack[path].pop()!;
          
          // Add current content to redo stack
          if (!redoStack[path]) {
            redoStack[path] = [];
          }
          redoStack[path].push(currentContent);
          
          const updatedFiles = [...state.openFiles];
          updatedFiles[fileIndex] = {
            ...updatedFiles[fileIndex],
            content: previousContent
          };
          
          return { 
            openFiles: updatedFiles,
            undoStack,
            redoStack
          };
        });
      },

      redo: (path: string) => {
        set(state => {
          const undoStack = { ...state.undoStack };
          const redoStack = { ...state.redoStack };
          
          if (!redoStack[path] || redoStack[path].length === 0) {
            return state;
          }
          
          const fileIndex = state.openFiles.findIndex(f => f.path === path);
          if (fileIndex === -1) return state;
          
          const currentContent = state.openFiles[fileIndex].content;
          const nextContent = redoStack[path].pop()!;
          
          // Add current content to undo stack
          if (!undoStack[path]) {
            undoStack[path] = [];
          }
          undoStack[path].push(currentContent);
          
          const updatedFiles = [...state.openFiles];
          updatedFiles[fileIndex] = {
            ...updatedFiles[fileIndex],
            content: nextContent
          };
          
          return { 
            openFiles: updatedFiles,
            undoStack,
            redoStack
          };
        });
      },

      saveFile: async (path: string) => {
        const { openFiles } = get();
        const file = openFiles.find(f => f.path === path);
        
        if (!file) {
          throw new Error(`File ${path} is not open`);
        }
        
        try {
          // Remove da queue de auto-save já que estamos salvando manualmente
          autoSaveQueue.removeFromQueue(path);
          
          await FileService.writeFile(path, file.content);
          
          // Update file state to mark as not dirty
          set(state => {
            const fileIndex = state.openFiles.findIndex(f => f.path === path);
            if (fileIndex === -1) return state;
            
            const updatedFiles = [...state.openFiles];
            updatedFiles[fileIndex] = {
              ...updatedFiles[fileIndex],
              isDirty: false
            };
            
            return { openFiles: updatedFiles };
          });
          
          // Mark file as clean
          unsavedChangesService.markFileAsClean(path);
        } catch (error) {
          logger.error('editor', `Failed to save file ${path}:`, error);
          throw error;
        }
      },

      saveAllFiles: async () => {
        const { openFiles } = get();
        const dirtyFiles = openFiles.filter(f => f.isDirty);
        
        if (dirtyFiles.length === 0) {
          return;
        }
        
        try {
          // Remove arquivos da queue de auto-save
          dirtyFiles.forEach(file => autoSaveQueue.removeFromQueue(file.path));
          
          // Save all dirty files em batches de 5 para evitar sobrecarga
          const batchSize = 5;
          for (let i = 0; i < dirtyFiles.length; i += batchSize) {
            const batch = dirtyFiles.slice(i, i + batchSize);
            await Promise.all(
              batch.map(file => FileService.writeFile(file.path, file.content))
            );
            
            // Pequena pausa entre batches
            if (i + batchSize < dirtyFiles.length) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          
          // Update file states to mark as not dirty
          set(state => {
            const updatedFiles = state.openFiles.map(file => 
              file.isDirty ? { ...file, isDirty: false } : file
            );
            
            return { openFiles: updatedFiles };
          });
          
          // Mark all files as clean
          dirtyFiles.forEach(file => unsavedChangesService.markFileAsClean(file.path));
        } catch (error) {
          logger.error('editor', 'Failed to save all files:', error);
          throw error;
        }
      },

      refreshFileContent: async (path: string) => {
        try {
          logger.debug('editor', 'Refreshing file content for:', path);
          const content = await FileService.readFile(path);
          
          set(state => {
            const fileIndex = state.openFiles.findIndex(f => f.path === path);
            if (fileIndex === -1) return state;
            
            const updatedFiles = [...state.openFiles];
            updatedFiles[fileIndex] = {
              ...updatedFiles[fileIndex],
              content,
              isDirty: false // Reset dirty flag since we're loading fresh content
            };
            
            return { openFiles: updatedFiles };
          });
        } catch (error) {
          logger.error('editor', `Failed to refresh file content ${path}:`, error);
          throw error;
        }
      },

      renameOpenFile: (oldPath: string, newPath: string) => {
        set(state => {
          let openFiles = state.openFiles.map(f => f.path === oldPath ? { ...f, path: newPath } : f);

          let activeFile = state.activeFile === oldPath ? newPath : state.activeFile;

          const cursorPositions: Record<string, [number, number]> = {};
          Object.entries(state.cursorPositions).forEach(([k, v]) => {
            cursorPositions[k === oldPath ? newPath : k] = v;
          });

          const remapStack = (stack: Record<string, string[]>) => {
            const next: Record<string, string[]> = {};
            Object.entries(stack).forEach(([k, v]) => {
              next[k === oldPath ? newPath : k] = v;
            });
            return next;
          };

          const undoStack = remapStack(state.undoStack);
          const redoStack = remapStack(state.redoStack);

          return { openFiles, activeFile, cursorPositions, undoStack, redoStack };
        });
      },
      closeAllFiles: () => {
        set(() => ({ openFiles: [], activeFile: null, cursorPositions: {}, undoStack: {}, redoStack: {} }))
      }
    }),
    {
      name: 'editor-storage',
      partialize: (state) => ({ 
        openFiles: state.openFiles.map(f => ({ 
          path: f.path, 
          content: f.content, 
          language: f.language,
          isDirty: f.isDirty
        })),
        activeFile: state.activeFile,
        cursorPositions: state.cursorPositions
      }),
    }
  )
);