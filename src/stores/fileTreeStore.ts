import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FileTreeService } from '../services/fileTreeService';
import { FileService } from '../services/fileService';
import { FileTreeIndexer } from '../utils/fileTreeIndex';
import { useFileTreeWorkerStore, FileNode } from './fileTreeWorkerStore';
import type { FileTreeNode, FileTreeFilter, FileMetadata } from '../types/fileTree';

interface FileTreeState {
  root: FileTreeNode | null;
  loading: boolean;
  error: string | null;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  processingStats: {
    lastProcessingTime?: number;
    nodeCount?: number;
  } | null;
  searchResults: FileTreeNode[];
  isProcessingInBackground: boolean;
}

interface FileTreeActions {
  loadFileTree: (rootPath: string, filter?: FileTreeFilter) => Promise<void>;
  toggleNode: (path: string) => void;
  selectNode: (path: string) => void;
  createFileOrDirectory: (parentPath: string, name: string, isDirectory: boolean) => Promise<string | null>;
  deleteNode: (path: string) => Promise<boolean>;
  renameNode: (oldPath: string, newName: string) => Promise<boolean>;
  copyNode: (sourcePath: string, destinationPath: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  collapseAll: () => void;
  // Real-time update methods
  addNode: (parentPath: string, node: FileTreeNode) => void;
  removeNode: (path: string) => void;
  updateNode: (path: string, updatedNode: Partial<FileTreeNode>) => void;
  // Web Worker methods
  initWorker: () => void;
  processTreeInBackground: (options?: { sort?: boolean; createIndex?: boolean }) => Promise<void>;
  searchInTree: (query: string) => Promise<void>;
  filterTreeInBackground: (filter: FileTreeFilter) => Promise<void>;
  clearSearch: () => void;
}

// FileTree indexer instance para operações O(1)
const fileTreeIndexer = FileTreeIndexer.getInstance();

// Helper function para converter FileNode para FileTreeNode
function convertFileNodeToTreeNode(fileNode: FileNode): FileTreeNode {
  const defaultMetadata: FileMetadata = {
    size: 0,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    isHidden: false,
    permissions: 'rw-r--r--'
  };
  
  return {
    type: fileNode.type,
    name: fileNode.name,
    path: fileNode.path,
    extension: fileNode.extension,
    metadata: fileNode.metadata ? {
      size: fileNode.metadata.size,
      created: fileNode.metadata.created,
      modified: fileNode.metadata.modified,
      isHidden: fileNode.metadata.isHidden,
      permissions: fileNode.metadata.permissions
    } : defaultMetadata,
    children: fileNode.children?.map(convertFileNodeToTreeNode),
    expanded: fileNode.expanded
  };
}

// Helper function para converter FileTreeNode para FileNode
function convertTreeNodeToFileNode(treeNode: FileTreeNode): FileNode {
  return {
    type: treeNode.type,
    name: treeNode.name,
    path: treeNode.path,
    extension: treeNode.extension,
    metadata: {
      size: treeNode.metadata.size,
      created: treeNode.metadata.created,
      modified: treeNode.metadata.modified,
      isHidden: treeNode.metadata.isHidden,
      permissions: treeNode.metadata.permissions
    },
    children: treeNode.children?.map(convertTreeNodeToFileNode),
    expanded: treeNode.expanded
  };
}

export const useFileTreeRepository = create<FileTreeState & FileTreeActions>()(
  persist(
    (set, get) => ({
      root: null,
      loading: false,
      error: null,
      expandedPaths: new Set(),
      selectedPath: null,
      processingStats: null,
      searchResults: [],
      isProcessingInBackground: false,

      loadFileTree: async (rootPath: string, filter?: FileTreeFilter) => {
        // Clear root immediately so ChatView doesn't stale previous project's tree
        set({ loading: true, error: null, root: null });
        try {
          // Default to showing hidden files to ensure all files are visible
          const filterWithDefaults = filter || { showHidden: true };
          const root = await FileTreeService.buildFileTree(rootPath, filterWithDefaults);

          // Constrói índice para operações rápidas O(1)
          fileTreeIndexer.buildIndex(root);

          set({ root, loading: false });
        } catch (error) {
          set({ error: (error as Error).message, loading: false, root: null });
        }
      },

      toggleNode: (path: string) => {
        set(state => {
          const newExpandedPaths = new Set(state.expandedPaths);
          if (newExpandedPaths.has(path)) {
            newExpandedPaths.delete(path);
          } else {
            newExpandedPaths.add(path);
          }
          return { expandedPaths: newExpandedPaths };
        });
      },

      selectNode: (path: string) => {
        // Expand all ancestor folders so the file is visible in the tree
        set(state => {
          const newExpanded = new Set(state.expandedPaths);
          // Normalize separators so ancestor expansion works on Windows
          const normalized = path.replace(/\\/g, '/');
          const parts = normalized.split('/');
          // Build each ancestor path and expand it (use original separator style)
          const sep = path.includes('\\') ? '\\' : '/';
          for (let i = 1; i < parts.length; i++) {
            const ancestor = parts.slice(0, i).join(sep);
            if (ancestor) newExpanded.add(ancestor);
          }
          return { selectedPath: path, expandedPaths: newExpanded };
        });
      },

      createFileOrDirectory: async (parentPath: string, name: string, isDirectory: boolean) => {
        try {
          // Reject path traversal attempts
          if (name.includes('..')) {
            set({ error: 'Name cannot contain ".."' });
            return null;
          }
          const hasNested = name.includes('/') || name.includes('\\');
          const fullPath = `${parentPath}${parentPath.endsWith('/') ? '' : '/'}${name}`;

          if (hasNested) {
            if (isDirectory) {
              const result = await FileTreeService.createDirectoriesAll(fullPath);
              if (!result.success) {
                set({ error: result.message });
                return null;
              }
            } else {
              await FileService.createFile(fullPath, '');
            }
            await get().refresh();
            return fullPath;
          }

          const result = await FileTreeService.createFileOrDirectory(parentPath, name, isDirectory);
          if (result.success) {
            const newNode: FileTreeNode = {
              type: isDirectory ? 'directory' : 'file',
              name: name,
              path: result.path,
              metadata: {
                size: 0,
                created: new Date().toISOString(),
                modified: new Date().toISOString(),
                isHidden: false,
                permissions: 'rw-r--r--'
              },
              extension: isDirectory ? undefined : name.split('.').pop()
            };
            get().addNode(parentPath, newNode);
            return result.path;
          } else {
            set({ error: result.message });
            return null;
          }
        } catch (error) {
          set({ error: (error as Error).message });
          return null;
        }
      },

      deleteNode: async (path: string) => {
        try {
          const result = await FileTreeService.deleteFileOrDirectory(path);
          if (result.success) {
            // Instead of refreshing the entire tree, remove the node directly
            get().removeNode(path);
            return true;
          } else {
            set({ error: result.message });
            return false;
          }
        } catch (error) {
          set({ error: (error as Error).message });
          return false;
        }
      },

      renameNode: async (oldPath: string, newName: string) => {
        try {
          const result = await FileTreeService.renameFileOrDirectory(oldPath, newName);
          if (result.success) {
            const newPath = result.path;
            const newExt = newName.includes('.') ? newName.split('.').pop() : undefined;
            const updatedNode: Partial<FileTreeNode> = {
              name: newName,
              path: newPath,
              extension: newExt
            };
            get().updateNode(oldPath, updatedNode);
            return true;
          } else {
            set({ error: result.message });
            return false;
          }
        } catch (error) {
          set({ error: (error as Error).message });
          return false;
        }
      },

      copyNode: async (sourcePath: string, destinationPath: string) => {
        try {
          const result = await FileTreeService.copyFileOrDirectory(sourcePath, destinationPath);
          if (result.success) {
            // Refresh the tree after successful copy since we don't know the structure of the copied node
            const { root } = get();
            if (root) {
              await get().loadFileTree(root.path);
            }
            return true;
          } else {
            set({ error: result.message });
            return false;
          }
        } catch (error) {
          set({ error: (error as Error).message });
          return false;
        }
      },

      refresh: async () => {
        const { root } = get();
        if (root) {
          await get().loadFileTree(root.path, { showHidden: true });
        }
      },

      collapseAll: () => {
        set({ expandedPaths: new Set() });
      },

      // Real-time update methods - targeted tree patching (no full rebuild)
      addNode: (parentPath: string, node: FileTreeNode) => {
        set(state => {
          if (!state.root) return state;

          // Update indexer for O(1) lookups
          fileTreeIndexer.addNode(state.root.path, parentPath, node);

          // Targeted tree patch — only clone nodes along the path to parent
          const addNodeToTree = (currentNode: FileTreeNode): FileTreeNode => {
            if (currentNode.path === parentPath && currentNode.type === 'directory') {
              const updatedNode = {
                ...currentNode,
                children: [...(currentNode.children || []), node]
              };

              updatedNode.children?.sort((a, b) => {
                if (a.type === 'directory' && b.type === 'file') return -1;
                if (a.type === 'file' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
              });

              return updatedNode;
            } else if (currentNode.type === 'directory' && currentNode.children) {
              const updatedChildren = currentNode.children.map(child => addNodeToTree(child));
              if (updatedChildren === currentNode.children) return currentNode;
              return { ...currentNode, children: updatedChildren };
            }
            return currentNode;
          };

          const newRoot = addNodeToTree(state.root);
          return newRoot !== state.root ? { root: newRoot } : state;
        });
      },
      
      removeNode: (path: string) => {
        set(state => {
          if (!state.root) return state;

          // Update indexer
          fileTreeIndexer.removeNode(state.root.path, path);

          // Targeted tree patch
          const removeNodeFromTree = (currentNode: FileTreeNode): FileTreeNode | null => {
            if (currentNode.path === path) {
              return null;
            } else if (currentNode.type === 'directory' && currentNode.children) {
              const updatedChildren = currentNode.children
                .map(child => removeNodeFromTree(child))
                .filter(child => child !== null) as FileTreeNode[];

              if (updatedChildren.length === currentNode.children.length) return currentNode;
              return { ...currentNode, children: updatedChildren };
            }
            return currentNode;
          };

          const newRoot = removeNodeFromTree(state.root);
          return newRoot && newRoot !== state.root ? { root: newRoot } : state;
        });
      },
      
      updateNode: (path: string, updatedNode: Partial<FileTreeNode>) => {
        set(state => {
          if (!state.root) return state;

          // Update indexer
          fileTreeIndexer.updateNode(state.root.path, path, updatedNode);

          // Targeted tree patch
          const updateNodeInTree = (currentNode: FileTreeNode): FileTreeNode => {
            if (currentNode.path === path) {
              return { ...currentNode, ...updatedNode };
            } else if (currentNode.type === 'directory' && currentNode.children) {
              const updatedChildren = currentNode.children.map(child => updateNodeInTree(child));
              if (updatedChildren === currentNode.children) return currentNode;
              return { ...currentNode, children: updatedChildren };
            }
            return currentNode;
          };

          const newRoot = updateNodeInTree(state.root);
          return newRoot !== state.root ? { root: newRoot } : state;
        });
      },

      // Inicializa o Web Worker
      initWorker: () => {
        const workerStore = useFileTreeWorkerStore.getState();
        workerStore.initWorker();
      },

      // Processa árvore em background usando Web Worker
      processTreeInBackground: async (options = {}) => {
        const { root } = get();
        if (!root) return;

        const workerStore = useFileTreeWorkerStore.getState();
        
        try {
          set({ isProcessingInBackground: true, error: null });
          
          // Converte FileTreeNode para FileNode antes de enviar para o worker
          const fileNodeRoot = convertTreeNodeToFileNode(root);
          const processedFileNode = await workerStore.processTree(fileNodeRoot, {
            sort: options.sort !== false,
            createIndex: options.createIndex !== false,
            ...options
          });
          
          // Converte de volta para FileTreeNode
          const processedTree = convertFileNodeToTreeNode(processedFileNode);

          // Atualiza estatísticas de processamento
          const stats = workerStore.lastProcessed;
          
          set({
            root: processedTree,
            isProcessingInBackground: false,
            processingStats: stats ? {
              lastProcessingTime: stats.processingTime,
              nodeCount: stats.nodeCount
            } : null
          });

          // Reconstrói o índice local também
          fileTreeIndexer.rebuildIndex(root.path, processedTree);
          
        } catch (error) {
          set({ 
            isProcessingInBackground: false,
            error: error instanceof Error ? error.message : 'Failed to process tree in background'
          });
        }
      },

      // Busca arquivos usando Web Worker
      searchInTree: async (query: string) => {
        const { root } = get();
        if (!root || !query.trim()) {
          set({ searchResults: [] });
          return;
        }

        const workerStore = useFileTreeWorkerStore.getState();
        
        try {
          set({ isProcessingInBackground: true, error: null });
          
          // Converte para FileNode antes de enviar para o worker
          const fileNodeRoot = convertTreeNodeToFileNode(root);
          const fileNodeResults = await workerStore.searchInTree(fileNodeRoot, query.trim());
          
          // Converte os resultados de volta para FileTreeNode
          const results = fileNodeResults.map(convertFileNodeToTreeNode);
          
          set({
            searchResults: results,
            isProcessingInBackground: false
          });
          
        } catch (error) {
          set({ 
            isProcessingInBackground: false,
            searchResults: [],
            error: error instanceof Error ? error.message : 'Failed to search in tree'
          });
        }
      },

      // Filtra árvore usando Web Worker
      filterTreeInBackground: async (filter: FileTreeFilter) => {
        const { root } = get();
        if (!root) return;

        const workerStore = useFileTreeWorkerStore.getState();
        
        try {
          set({ isProcessingInBackground: true, error: null });
          
          // Converte para FileNode antes de enviar para o worker
          const fileNodeRoot = convertTreeNodeToFileNode(root);
          const filteredFileNode = await workerStore.filterTree(fileNodeRoot, filter);
          
          // Converte de volta para FileTreeNode
          const filteredTree = convertFileNodeToTreeNode(filteredFileNode);
          
          set({
            root: filteredTree,
            isProcessingInBackground: false
          });

          // Reconstrói o índice com a árvore filtrada
          fileTreeIndexer.rebuildIndex(root.path, filteredTree);
          
        } catch (error) {
          set({ 
            isProcessingInBackground: false,
            error: error instanceof Error ? error.message : 'Failed to filter tree'
          });
        }
      },

      // Limpa resultados de busca
      clearSearch: () => {
        set({ searchResults: [] });
      }
    }),
    {
      name: 'file-tree-storage',
      partialize: (state) => ({ 
        expandedPaths: Array.from(state.expandedPaths),
        selectedPath: state.selectedPath
      }),
      merge: (persisted: unknown, current: FileTreeState & FileTreeActions) => {
        const persistedState = persisted as Partial<FileTreeState> | undefined;
        if (!persistedState) return current;
        return {
          ...current,
          ...persistedState,
          // Immediately convert array back to Set during merge to prevent .has() crashes
          expandedPaths: Array.isArray(persistedState.expandedPaths)
            ? new Set(persistedState.expandedPaths)
            : (persistedState.expandedPaths instanceof Set ? persistedState.expandedPaths : current.expandedPaths),
        };
      }
    }
  )
);