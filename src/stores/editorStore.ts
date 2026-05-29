import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FileService } from '../services/fileService';
import UnsavedChangesService from '../services/unsavedChangesService';
import { AutoSaveQueue } from '../utils/autoSaveQueue';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { readFile as tauriReadFile } from '@tauri-apps/plugin-fs';
import { logger } from '../utils/logger';

interface EditorFile {
  path: string;
  content: string;
  language: string;
  isDirty: boolean;
  isPreview?: boolean;
  cursorPosition?: { line: number; column: number };
  // Diff mode — when set, MonacoEditor renders a diff view
  diff?: {
    originalContent: string;
    relPath: string;
  };
  // Image preview — set when file is a supported image format
  isImage?: boolean;
  mimeType?: string;
  base64?: string;
}

export interface EditorGroup {
  id: string;
  files: string[];      // ordered file paths in this group's tab bar
  activeFile: string | null;
}

interface EditorState {
  openFiles: EditorFile[];
  activeFile: string | null;
  cursorPositions: Record<string, [number, number]>; // line, column
  undoStack: Record<string, string[]>;
  redoStack: Record<string, string[]>;
  editorGroups: EditorGroup[];
  activeGroupId: string;
  isRehydrating: boolean;
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
  reorderFiles: (newOrder: string[]) => void;
  // Preview mode
  previewFile: (path: string) => Promise<void>;
  pinFile: (path: string) => void;
  // Split editor actions
  splitEditor: () => void;
  unsplitEditor: () => void;
  setActiveGroup: (groupId: string) => void;
  openFileInGroup: (path: string, groupId: string) => Promise<void>;
  closeFileInGroup: (path: string, groupId: string) => void;
  moveFileToGroup: (path: string, fromGroupId: string, toGroupId: string) => void;
}

// Image extensions supported for preview
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);

/** Convert Uint8Array to base64 string — safe for large files */
function uint8ToBase64(bytes: Uint8Array): string {
  // Use built-in btoa with chunked approach to avoid stack overflow
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    for (let j = i; j < end; j++) {
      binary += String.fromCharCode(bytes[j]);
    }
  }
  return btoa(binary);
}

/** Get MIME type from image extension */
function getImageMimeType(ext: string): string {
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'ico': return 'image/x-icon';
    case 'avif': return 'image/avif';
    default: return 'image/png';
  }
}

// Get language from file extension — comprehensive mapping
const getLanguageFromExtension = (filePath: string): string => {
  const name = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // Special filenames first
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === '.gitignore' || name === '.gitattributes') return 'ini';
  if (name === '.env' || name.startsWith('.env.')) return 'ini';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';

  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'ts': case 'mts': case 'cts': case 'tsx': return 'typescript';
    case 'json': case 'jsonc': case 'json5': return 'json';
    case 'html': case 'htm': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'md': case 'mdx': return 'markdown';
    case 'py': case 'pyw': return 'python';
    case 'java': return 'java';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx': return 'cpp';
    case 'c': case 'h': return 'c';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'php': return 'php';
    case 'sql': return 'sql';
    case 'yaml': case 'yml': return 'yaml';
    case 'toml': return 'ini';
    case 'xml': case 'svg': case 'plist': return 'xml';
    case 'graphql': case 'gql': return 'graphql';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'ps1': return 'powershell';
    case 'rb': return 'ruby';
    case 'lua': return 'lua';
    case 'swift': return 'swift';
    case 'kt': case 'kts': return 'kotlin';
    case 'dart': return 'dart';
    case 'r': return 'r';
    case 'perl': case 'pl': return 'perl';
    case 'ini': case 'cfg': case 'conf': return 'ini';
    case 'log': return 'plaintext';
    case 'vue': return 'html';
    case 'svelte': return 'html';
    case 'prisma': return 'graphql';
    case 'hbs': case 'handlebars': return 'handlebars';
    case 'bat': case 'cmd': return 'bat';
    case 'dockerfile': return 'dockerfile';
    default: return 'plaintext';
  }
};

const getUnsavedChangesService = () => UnsavedChangesService.getInstance();
const getAutoSaveQueue = () => AutoSaveQueue.getInstance();

/**
 * Apply dirty-buffer overrides loaded from `<project>/.toquemedia/editor-state.json`.
 * Called from `projectStore.openProject` AFTER the editor has rehydrated its
 * tabs from localStorage (paths + cursor). For each path with a dirty entry,
 * overwrite the in-memory content with the unsaved version and flip
 * `isDirty` back to true so the user sees the dot indicator and Save acts.
 *
 * Paths not currently in `openFiles` are ignored — if the user closed the
 * tab the unsaved buffer is gone with it (consistent with the legacy
 * tab-close-discards behaviour). We could re-open them, but that risks
 * surprising the user with files they thought they closed.
 */
export function applyDirtyOverrides(dirty: Record<string, string>): void {
  if (Object.keys(dirty).length === 0) return
  useEditorRepository.setState(state => {
    let touched = false
    const openFiles = state.openFiles.map(f => {
      const overrideContent = dirty[f.path]
      if (typeof overrideContent !== 'string') return f
      if (f.content === overrideContent) return f // No-op — disk matches dirty buffer somehow.
      touched = true
      return { ...f, content: overrideContent, isDirty: true }
    })
    if (!touched) return state
    // Also re-mark each restored file as dirty in the UnsavedChangesService
    // so the close-tab confirmation reappears.
    for (const f of openFiles) {
      if (f.isDirty) getUnsavedChangesService().markFileAsDirty(f.path)
    }
    return { openFiles }
  })
}

// === Dirty-buffer disk persistence ===
//
// The Zustand localStorage persist middleware only captures tab + cursor
// state (see `partialize` near the bottom of this file). Dirty buffer
// content — the unsaved edits the user has typed into Monaco — is the
// catastrophic data-loss path on crash/reload, so it goes to per-project
// disk at `.toquemedia/editor-state.json` via `editorStatePersistence`.
//
// Debounced 800ms: long enough to coalesce a typing burst into one write,
// short enough to capture before a graceful quit. The autoSaveQueue
// already handles persisting the buffer to its REAL file on disk (when
// autosave is enabled) — this is the belt-and-braces fallback for the
// off-autosave path AND for the window between dirty-flag-set and
// autosave-fire.
let editorPersistTimeout: ReturnType<typeof setTimeout> | null = null
const EDITOR_PERSIST_DEBOUNCE_MS = 800

function scheduleEditorStatePersist(): void {
  if (editorPersistTimeout) clearTimeout(editorPersistTimeout)
  editorPersistTimeout = setTimeout(() => {
    editorPersistTimeout = null
    void persistEditorStateNow()
  }, EDITOR_PERSIST_DEBOUNCE_MS)
}

async function persistEditorStateNow(): Promise<void> {
  const { useProjectStore } = await import('./projectStore')
  const projectPath = useProjectStore.getState().currentProject?.path
  if (!projectPath) return
  const { saveEditorStateToDisk } = await import('../services/editorStatePersistence')
  const dirty: Record<string, string> = {}
  for (const f of useEditorRepository.getState().openFiles) {
    if (f.isDirty) {
      dirty[f.path] = f.content
    }
  }
  await saveEditorStateToDisk(projectPath, dirty)
}
// Concurrency guard for openFile with per-entry timeout (handles hung promises)
const openingFiles = new Set<string>();
function markOpening(path: string) {
  openingFiles.add(path);
  // Auto-expire after 30s in case the promise hangs
  setTimeout(() => openingFiles.delete(path), 30000);
}
function markDoneOpening(path: string) {
  openingFiles.delete(path);
}

export const useEditorRepository = create<EditorState & EditorActions>()(
  persist(
    (set, get) => ({
      openFiles: [],
      activeFile: null,
      cursorPositions: {},
      undoStack: {},
      redoStack: {},
      editorGroups: [{ id: 'main', files: [], activeFile: null }],
      activeGroupId: 'main',
      isRehydrating: false,

      openFile: async (path: string) => {
        logger.debug('editor', 'Opening file:', path);
        // Concurrency guard: skip if this file is already being opened
        if (openingFiles.has(path)) return;
        markOpening(path);

        try {
          // Add to active group's files
          set(state => {
            const groups = state.editorGroups.map(g => {
              if (g.id !== state.activeGroupId) return g;
              if (g.files.includes(path)) return { ...g, activeFile: path };
              return { ...g, files: [...g.files, path], activeFile: path };
            });
            return { activeFile: path, editorGroups: groups };
          });

          // Sync explorer selection (deferred to avoid circular import issues)
          setTimeout(() => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { useFileTreeRepository } = require('./fileTreeStore');
              useFileTreeRepository.getState().selectNode(path);
            } catch {}
          }, 0);

          // Check if file is already open — just activate, skip disk read
          const existingFile = get().openFiles.find(f => f.path === path);
          if (existingFile) {
            return;
          }

          // New file — read from disk
          logger.debug('editor', 'Reading file content for:', path);

          // Detect image files — read as binary/base64 instead of text
          const ext = path.split('.').pop()?.toLowerCase() || '';
          if (IMAGE_EXTENSIONS.has(ext)) {
            try {
              const bytes = await tauriReadFile(path);
              const mimeType = getImageMimeType(ext);
              const base64 = uint8ToBase64(bytes);

              // For SVG files, also store the text content so we can show code view
              let textContent = '';
              if (ext === 'svg') {
                try {
                  textContent = await FileService.readFile(path);
                } catch { /* ignore — base64 fallback will be used */ }
              }

              if (!get().openFiles.some(f => f.path === path)) {
                set(state => ({
                  openFiles: [
                    ...state.openFiles,
                    {
                      path,
                      content: textContent,
                      language: ext === 'svg' ? 'xml' : 'plaintext',
                      isDirty: false,
                      isImage: true,
                      mimeType,
                      base64,
                    }
                  ]
                }));
              }
              logger.debug('editor', `Image loaded: ${path} (${(bytes.length / 1024).toFixed(1)}KB, ${mimeType})`);
            } catch (error) {
              logger.error('editor', `Failed to load image ${path}:`, error);
              throw error;
            }
            return;
          }

          const content = await FileService.readFile(path);
          const language = getLanguageFromExtension(path);
          logger.debug('editor', `File loaded successfully: ${path} (${content.length} chars, ${language})`);

          // Re-check: another concurrent call may have added the file while we awaited
          if (!get().openFiles.some(f => f.path === path)) {
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
          }
        } catch (error) {
          logger.error('editor', `Failed to open file ${path}:`, error);
          throw error;
        } finally {
          markDoneOpening(path);
        }
      },

      closeFile: (path: string) => {
        const removeFile = () => {
          // Notify listeners (e.g. closed-tabs stack for Reopen Closed Tab)
          try { window.dispatchEvent(new CustomEvent('tab:closed', { detail: { path } })) } catch {}
          set(state => {
            // Only remove from the ACTIVE group (not all groups)
            const groups = state.editorGroups.map(g => {
              if (g.id !== state.activeGroupId) return g;
              if (!g.files.includes(path)) return g;
              const files = g.files.filter(f => f !== path);
              let groupActive = g.activeFile;
              if (groupActive === path) {
                const closedIdx = g.files.indexOf(path);
                const adjIdx = Math.min(closedIdx, files.length - 1);
                groupActive = files.length > 0 ? files[Math.max(0, adjIdx)] : null;
              }
              return { ...g, files, activeFile: groupActive };
            });

            // Remove empty split groups (keep main always)
            const filteredGroups = groups.filter(g => g.id === 'main' || g.files.length > 0);
            if (filteredGroups.length === 0) {
              filteredGroups.push({ id: 'main', files: [], activeFile: null });
            }

            // Check if file is still in any group
            const stillInGroup = filteredGroups.some(g => g.files.includes(path));

            // If no group has it, remove from openFiles entirely
            const updated = stillInGroup
              ? state.openFiles
              : state.openFiles.filter(ff => ff.path !== path);

            const cursorPositions = stillInGroup ? state.cursorPositions : { ...state.cursorPositions };
            const undoStack = stillInGroup ? state.undoStack : { ...state.undoStack };
            const redoStack = stillInGroup ? state.redoStack : { ...state.redoStack };
            if (!stillInGroup) {
              delete cursorPositions[path];
              delete undoStack[path];
              delete redoStack[path];
              getUnsavedChangesService().markFileAsClean(path);
              // Notify MonacoEditor to clear cursor cache for this path
              try { window.dispatchEvent(new CustomEvent('editor:clearCursorCache', { detail: path })) } catch {}
            }

            // Update activeGroupId if current group was removed
            let activeGroupId = state.activeGroupId;
            if (!filteredGroups.some(g => g.id === activeGroupId)) {
              activeGroupId = filteredGroups[0].id;
            }

            // Update activeFile from active group
            const activeGroup = filteredGroups.find(g => g.id === activeGroupId);
            let activeFile = activeGroup?.activeFile ?? null;

            // If active group is empty, try switching to another group
            if (!activeFile) {
              const otherGroup = filteredGroups.find(g => g.id !== activeGroupId && g.files.length > 0);
              if (otherGroup) {
                activeFile = otherGroup.activeFile;
                activeGroupId = otherGroup.id;
              }
            }

            return { openFiles: updated, activeFile, cursorPositions, undoStack, redoStack, editorGroups: filteredGroups, activeGroupId };
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
        set(state => {
          if (!path) return { activeFile: null };
          // Ensure the file is in the active group (safety for legacy state migration)
          const groups = state.editorGroups.map(g => {
            if (g.id !== state.activeGroupId) return g;
            if (g.files.includes(path)) return { ...g, activeFile: path };
            return { ...g, files: [...g.files, path], activeFile: path };
          });
          return { activeFile: path, editorGroups: groups };
        });
      },

      updateFileContent: (path: string, content: string) => {
        set(state => {
          const fileIndex = state.openFiles.findIndex(f => f.path === path);
          if (fileIndex === -1) return state;

          // Auto-pin preview tabs when user edits
          let currentFiles = state.openFiles;
          if (currentFiles[fileIndex].isPreview) {
            currentFiles = [...currentFiles];
            currentFiles[fileIndex] = { ...currentFiles[fileIndex], isPreview: false };
          }

          const oldContent = currentFiles[fileIndex].content;

          if (oldContent === content) {
            // Even if content didn't change, return pinned state if auto-pin occurred
            if (currentFiles !== state.openFiles) return { openFiles: currentFiles };
            return state;
          }

          const updatedFiles = [...currentFiles];
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
          getUnsavedChangesService().markFileAsDirty(path);
          
          // Adiciona à queue de auto-save (apenas se realmente mudou)
          getAutoSaveQueue().addToQueue(path, content);

          // Persist dirty buffer to disk — protects against data loss on
          // crash/reload when autosave is off or hasn't fired yet. The
          // `editor-state.json` write is debounced separately from the
          // file-itself autosave (which writes to the REAL path on disk).
          scheduleEditorStatePersist();

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
            content: previousContent,
            isDirty: true,
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
            content: nextContent,
            isDirty: true,
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
          getAutoSaveQueue().removeFromQueue(path);
          
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
          getUnsavedChangesService().markFileAsClean(path);

          // The dirty-buffer file on disk should drop this path now that
          // the real file has been saved. Schedule a persist — the writer
          // recomputes the dirty map and naturally omits this path (or
          // deletes the whole file if nothing else is dirty).
          scheduleEditorStatePersist();
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
          dirtyFiles.forEach(file => getAutoSaveQueue().removeFromQueue(file.path));
          
          // Save all dirty files em batches de 5 para evitar sobrecarga
          // Read fresh content before each write to avoid TOCTOU (user may edit during save)
          const batchSize = 5;
          for (let i = 0; i < dirtyFiles.length; i += batchSize) {
            const batch = dirtyFiles.slice(i, i + batchSize);
            const currentFiles = get().openFiles;
            await Promise.all(
              batch.map(file => {
                const fresh = currentFiles.find(f => f.path === file.path);
                return FileService.writeFile(file.path, fresh?.content ?? file.content);
              })
            );
            
            // Pequena pausa entre batches
            if (i + batchSize < dirtyFiles.length) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          
          // Only mark files as clean if they haven't been re-dirtied during save
          const savedPaths = new Set(dirtyFiles.map(f => f.path));
          set(state => {
            const updatedFiles = state.openFiles.map(file => {
              if (!savedPaths.has(file.path)) return file;
              // Re-check: content may have changed during async save
              const originalFile = dirtyFiles.find(f => f.path === file.path);
              if (originalFile && file.content === originalFile.content) {
                return { ...file, isDirty: false };
              }
              return file; // File was re-dirtied, keep dirty flag
            });
            return { openFiles: updatedFiles };
          });

          // Only mark clean if content matches what was saved
          dirtyFiles.forEach(file => {
            const current = get().openFiles.find(f => f.path === file.path);
            if (current && !current.isDirty) {
              getUnsavedChangesService().markFileAsClean(file.path);
            }
          });

          // Sync the dirty-buffer file on disk — paths that just got
          // cleaned should drop out of `editor-state.json`, and if every
          // dirty file was saved the file itself gets deleted.
          scheduleEditorStatePersist();
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

          // Remap paths inside editorGroups
          const editorGroups = state.editorGroups.map(g => ({
            ...g,
            files: g.files.map(f => f === oldPath ? newPath : f),
            activeFile: g.activeFile === oldPath ? newPath : g.activeFile,
          }));

          return { openFiles, activeFile, cursorPositions, undoStack, redoStack, editorGroups };
        });
      },
      closeAllFiles: () => {
        // Notify listeners for each closed file
        const files = get().openFiles
        for (const f of files) {
          try { window.dispatchEvent(new CustomEvent('tab:closed', { detail: { path: f.path } })) } catch {}
        }
        set(() => ({
          openFiles: [], activeFile: null, cursorPositions: {}, undoStack: {}, redoStack: {},
          editorGroups: [{ id: 'main', files: [], activeFile: null }], activeGroupId: 'main',
        }))
      },

      // ── Preview Mode ────────────────────────────────────────────────

      previewFile: async (path: string) => {
        // If this file is already open (preview or not), just activate it
        const existing = get().openFiles.find(f => f.path === path);
        if (existing) {
          // Single atomic set to avoid race between activeFile and editorGroups
          set(state => {
            const groups = state.editorGroups.map(g => {
              if (g.id !== state.activeGroupId) return g;
              if (g.files.includes(path)) return { ...g, activeFile: path };
              return { ...g, files: [...g.files, path], activeFile: path };
            });
            return { activeFile: path, editorGroups: groups };
          });
          return;
        }

        // Close existing preview tab in the active group (replace it)
        const state = get();
        const activeGroup = state.editorGroups.find(g => g.id === state.activeGroupId);
        const existingPreviewPath = activeGroup?.files.find(fp => {
          const f = state.openFiles.find(of => of.path === fp);
          return f?.isPreview && !f?.isDirty;
        });

        if (existingPreviewPath) {
          // Remove old preview from openFiles and group
          set(st => {
            const stillInOtherGroup = st.editorGroups.some(g => g.id !== st.activeGroupId && g.files.includes(existingPreviewPath));
            const openFiles = stillInOtherGroup ? st.openFiles : st.openFiles.filter(f => f.path !== existingPreviewPath);
            const groups = st.editorGroups.map(g => {
              if (g.id !== st.activeGroupId) return g;
              return { ...g, files: g.files.filter(f => f !== existingPreviewPath) };
            });
            if (!stillInOtherGroup) {
              getUnsavedChangesService().markFileAsClean(existingPreviewPath);
            }
            return { openFiles, editorGroups: groups };
          });
        }

        // Now open the new file as preview
        await get().openFile(path);
        // Mark as preview and ensure activeFile + group are set atomically
        set(st => {
          const openFiles = st.openFiles.map(f =>
            f.path === path ? { ...f, isPreview: true } : f
          );
          const groups = st.editorGroups.map(g => {
            if (g.id !== st.activeGroupId) return g;
            if (g.files.includes(path)) return { ...g, activeFile: path };
            return { ...g, files: [...g.files, path], activeFile: path };
          });
          return { openFiles, activeFile: path, editorGroups: groups };
        });
      },

      pinFile: (path: string) => {
        set(state => {
          const openFiles = state.openFiles.map(f =>
            f.path === path ? { ...f, isPreview: false } : f
          );
          return { openFiles };
        });
      },

      reorderFiles: (newOrder: string[]) => {
        set(state => {
          const groups = state.editorGroups.map(g => {
            if (g.id !== state.activeGroupId) return g;
            // Validate: newOrder must contain exactly the same paths
            if (newOrder.length !== g.files.length) {
              logger.warn('editor', `reorderFiles rejected: length mismatch (${newOrder.length} vs ${g.files.length})`);
              return g;
            }
            const expected = new Set(g.files);
            if (!newOrder.every(p => expected.has(p))) {
              logger.warn('editor', 'reorderFiles rejected: path mismatch');
              return g;
            }
            return { ...g, files: newOrder };
          });
          return { editorGroups: groups };
        });
      },

      // ── Split Editor ──────────────────────────────────────────────────

      splitEditor: () => {
        set(state => {
          if (state.editorGroups.length >= 2) return state;
          const mainGroup = state.editorGroups[0];
          if (!mainGroup || !mainGroup.activeFile) return state;
          if (mainGroup.files.length < 2) return state; // Need at least 2 files to split

          const currentFile = mainGroup.activeFile;
          // Move current file to the new group, remove from main
          const mainFiles = mainGroup.files.filter(f => f !== currentFile);
          const updatedMain = {
            ...mainGroup,
            files: mainFiles,
            activeFile: mainFiles[0] || null,
          };
          const newGroup: EditorGroup = {
            id: 'split',
            files: [currentFile],
            activeFile: currentFile,
          };

          return {
            editorGroups: [updatedMain, newGroup],
            activeGroupId: 'split',
            activeFile: currentFile,
          };
        });
      },

      unsplitEditor: () => {
        set(state => {
          if (state.editorGroups.length <= 1) return state;
          // Merge all files into main group, preserving order
          const allFiles: string[] = [];
          const seen = new Set<string>();
          for (const g of state.editorGroups) {
            for (const f of g.files) {
              if (!seen.has(f)) { allFiles.push(f); seen.add(f); }
            }
          }
          const activeGroup = state.editorGroups.find(g => g.id === state.activeGroupId);
          const activeFile = activeGroup?.activeFile ?? allFiles[0] ?? null;

          return {
            editorGroups: [{ id: 'main', files: allFiles, activeFile }],
            activeGroupId: 'main',
            activeFile,
          };
        });
      },

      setActiveGroup: (groupId: string) => {
        set(state => {
          const group = state.editorGroups.find(g => g.id === groupId);
          if (!group) return state;
          return {
            activeGroupId: groupId,
            activeFile: group.activeFile,
          };
        });
      },

      openFileInGroup: async (path: string, groupId: string) => {
        // If file is already in this group, just activate it
        const store = get();
        const targetGroup = store.editorGroups.find(g => g.id === groupId);
        if (targetGroup?.files.includes(path)) {
          set(state => {
            const groups = state.editorGroups.map(g =>
              g.id === groupId ? { ...g, activeFile: path } : g
            );
            return { editorGroups: groups, activeGroupId: groupId, activeFile: path };
          });
          return;
        }

        // If file is in another group during split, move it instead of duplicating
        const otherGroup = store.editorGroups.find(g => g.id !== groupId && g.files.includes(path));
        if (otherGroup && store.editorGroups.length >= 2) {
          get().moveFileToGroup(path, otherGroup.id, groupId);
          return;
        }

        // Load file data if not already in openFiles
        if (!store.openFiles.some(f => f.path === path)) {
          // Load file content
          markOpening(path);
          try {
            const content = await FileService.readFile(path);
            const language = getLanguageFromExtension(path);
            if (!get().openFiles.some(f => f.path === path)) {
              set(state => ({
                openFiles: [...state.openFiles, { path, content, language, isDirty: false }],
              }));
            }
          } catch (error) {
            logger.error('editor', `Failed to open file ${path}:`, error);
            markDoneOpening(path);
            return;
          } finally {
            markDoneOpening(path);
          }
        }

        // Add to group
        set(state => {
          const groups = state.editorGroups.map(g => {
            if (g.id !== groupId) return g;
            if (g.files.includes(path)) return { ...g, activeFile: path };
            return { ...g, files: [...g.files, path], activeFile: path };
          });
          return {
            editorGroups: groups,
            activeGroupId: groupId,
            activeFile: path,
          };
        });
      },

      closeFileInGroup: (path: string, groupId: string) => {
        const doRemove = () => {
          set(state => {
            const groups = state.editorGroups.map(g => {
              if (g.id !== groupId || !g.files.includes(path)) return g;
              const files = g.files.filter(f => f !== path);
              let groupActive = g.activeFile;
              if (groupActive === path) {
                const idx = g.files.indexOf(path);
                const adjIdx = Math.min(idx, files.length - 1);
                groupActive = files.length > 0 ? files[Math.max(0, adjIdx)] : null;
              }
              return { ...g, files, activeFile: groupActive };
            });

            // If file is not in any group, remove from openFiles
            const stillInGroup = groups.some(g => g.files.includes(path));
            const openFiles = stillInGroup ? state.openFiles : state.openFiles.filter(f => f.path !== path);

            if (!stillInGroup) {
              getUnsavedChangesService().markFileAsClean(path);
            }

            // Remove empty split groups
            const filteredGroups = groups.filter(g => g.id === 'main' || g.files.length > 0);
            if (filteredGroups.length === 0) {
              filteredGroups.push({ id: 'main', files: [], activeFile: null });
            }

            const activeGroup = filteredGroups.find(g => g.id === state.activeGroupId) || filteredGroups[0];
            return {
              openFiles,
              editorGroups: filteredGroups,
              activeGroupId: activeGroup.id,
              activeFile: activeGroup.activeFile,
            };
          });
        };

        // Check isDirty — prompt if unsaved
        const f = get().openFiles.find(f => f.path === path);
        // Only prompt if file is dirty AND no other group has it (i.e., closing last reference)
        const otherGroupHasIt = get().editorGroups.some(g => g.id !== groupId && g.files.includes(path));
        if (f?.isDirty && !otherGroupHasIt) {
          Promise.resolve().then(async () => {
            const current = get().openFiles.find(ff => ff.path === path);
            if (!current || !current.isDirty) { doRemove(); return; }
            const ok = await tauriConfirm(`Close "${path}" without saving?`, { title: 'Unsaved changes', kind: 'warning' });
            if (!ok) return;
            doRemove();
          });
          return;
        }
        doRemove();
      },

      moveFileToGroup: (path: string, fromGroupId: string, toGroupId: string) => {
        set(state => {
          if (fromGroupId === toGroupId) return state;
          const groups = state.editorGroups.map(g => {
            if (g.id === fromGroupId) {
              const files = g.files.filter(f => f !== path);
              let groupActive = g.activeFile;
              if (groupActive === path) {
                const idx = g.files.indexOf(path);
                const adjIdx = Math.min(idx, files.length - 1);
                groupActive = files.length > 0 ? files[Math.max(0, adjIdx)] : null;
              }
              return { ...g, files, activeFile: groupActive };
            }
            if (g.id === toGroupId) {
              if (g.files.includes(path)) return { ...g, activeFile: path };
              return { ...g, files: [...g.files, path], activeFile: path };
            }
            return g;
          });

          // Remove empty split groups
          const filteredGroups = groups.filter(g => g.id === 'main' || g.files.length > 0);
          if (filteredGroups.length === 0) {
            filteredGroups.push({ id: 'main', files: [], activeFile: null });
          }

          return {
            editorGroups: filteredGroups,
            activeGroupId: toGroupId,
            activeFile: path,
          };
        });
      }
    }),
    {
      name: 'editor-storage',
      partialize: (state) => ({
        openFiles: state.openFiles.map(f => ({
          path: f.path,
          language: f.language,
          isDirty: false
        })),
        activeFile: state.activeFile,
        cursorPositions: state.cursorPositions,
        editorGroups: state.editorGroups,
        activeGroupId: state.activeGroupId,
      }),
      onRehydrateStorage: () => {
        return (state) => {
          if (!state) return;
          // Reload file contents from disk for persisted open files
          const files = state.openFiles;
          if (files.length === 0) return;
          // Mark as rehydrating so UI can show loading state
          useEditorRepository.setState({ isRehydrating: true });
          Promise.all(
            files.map(async (f) => {
              try {
                const content = await FileService.readFile(f.path);
                return { ...f, content, isDirty: false };
              } catch {
                // File no longer exists — skip it
                return null;
              }
            })
          ).then((results) => {
            const validFiles = results.filter(Boolean) as EditorFile[];
            const validPaths = new Set(validFiles.map(f => f.path));
            const activePath = state.activeFile;
            const activeExists = validFiles.some(f => f.path === activePath);
            const resolvedActive = activeExists ? activePath : (validFiles[0]?.path ?? null);

            // Build groups from persisted state, falling back to a single group with all files
            const rawGroups = state.editorGroups && state.editorGroups.length > 0
              ? state.editorGroups
              : [{ id: 'main' as string, files: [] as string[], activeFile: null as string | null }];

            let groups = rawGroups.map(g => ({
              ...g,
              files: (g.files || []).filter((p: string) => validPaths.has(p)),
              activeFile: g.activeFile && validPaths.has(g.activeFile) ? g.activeFile : null,
            }));

            // If all groups are empty but we have files, populate main group
            // This handles migration from pre-groups state
            const allGroupFiles = new Set(groups.flatMap(g => g.files));
            if (allGroupFiles.size === 0 && validFiles.length > 0) {
              groups = [{ id: 'main', files: validFiles.map(f => f.path), activeFile: resolvedActive }];
            } else {
              // Ensure every valid file is in at least one group (migration safety)
              const orphans = validFiles.filter(f => !allGroupFiles.has(f.path));
              if (orphans.length > 0) {
                const mainIdx = groups.findIndex(g => g.id === 'main');
                if (mainIdx >= 0) {
                  groups[mainIdx] = {
                    ...groups[mainIdx],
                    files: [...groups[mainIdx].files, ...orphans.map(f => f.path)],
                    activeFile: groups[mainIdx].activeFile || orphans[0].path,
                  };
                }
              }
              // Set active file for any group that has files but no activeFile
              groups = groups.map(g => ({
                ...g,
                activeFile: g.activeFile || (g.files.length > 0 ? g.files[0] : null),
              }));
            }

            // Ensure at least one group exists
            if (groups.length === 0) {
              groups = [{ id: 'main', files: [], activeFile: null }];
            }

            useEditorRepository.setState({
              openFiles: validFiles,
              activeFile: resolvedActive,
              editorGroups: groups,
              activeGroupId: state.activeGroupId || 'main',
              isRehydrating: false,
            });
          });
        };
      },
    }
  )
);