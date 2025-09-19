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
  createFileOrDirectory: (parentPath: string, name: string, isDirectory: boolean) => Promise<boolean>;
  deleteNode: (path: string) => Promise<boolean>;
  renameNode: (oldPath: string, newName: string) => Promise<boolean>;
  copyNode: (sourcePath: string, destinationPath: string) => Promise<boolean>;
  refresh: () => Promise<void>;
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

// Helper function para reconstruir árvore baseada no índice
function rebuildTreeFromIndex(rootPath: string, originalRoot: FileTreeNode): FileTreeNode | null {
  try {
    const index = fileTreeIndexer.getIndex(rootPath);
    if (!index) return null;
    
    const rootNode = fileTreeIndexer.getNode(rootPath, rootPath);
    if (!rootNode) return null;
    
    // Função recursiva para reconstruir a árvore
    function buildNodeWithChildren(node: FileTreeNode): FileTreeNode {
      const children = fileTreeIndexer.getChildren(rootPath, node.path);
      if (children.length === 0) {
        return { ...node, children: undefined };
      }
      
      const rebuiltChildren = children.map(child => buildNodeWithChildren(child));
      return { ...node, children: rebuiltChildren };
    }
    
    return buildNodeWithChildren(rootNode);
  } catch (error) {
    console.error('Failed to rebuild tree from index:', error);
    return originalRoot; // Fallback para árvore original
  }
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
        set({ loading: true, error: null });
        try {
          // Default to showing hidden files to ensure all files are visible
          const filterWithDefaults = filter || { showHidden: true };
          const root = await FileTreeService.buildFileTree(rootPath, filterWithDefaults);
          
          // Constrói índice para operações rápidas O(1)
          fileTreeIndexer.buildIndex(root);
          
          set({ root, loading: false });
        } catch (error) {
          set({ error: (error as Error).message, loading: false });
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
        set({ selectedPath: path });
      },

      createFileOrDirectory: async (parentPath: string, name: string, isDirectory: boolean) => {
        try {
          const hasNested = name.includes('/') || name.includes('\\');
          const fullPath = `${parentPath}${parentPath.endsWith('/') ? '' : '/'}${name}`;

          if (hasNested) {
            if (isDirectory) {
              // Create all directories along the path via Tauri
              const result = await FileTreeService.createDirectoriesAll(fullPath);
              if (!result.success) {
                set({ error: result.message });
                return false;
              }
            } else {
              // Create file and parents as needed
              await FileService.createFile(fullPath, '');
            }
            // Nested creation can affect multiple branches; refresh tree
            await get().refresh();
            return true;
          }

          const result = await FileTreeService.createFileOrDirectory(parentPath, name, isDirectory);
          if (result.success) {
            // Instead of refreshing the entire tree, add the new node directly
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
            // Instead of refreshing the entire tree, update the node directly
            const newPath = result.path;
            const updatedNode: Partial<FileTreeNode> = {
              name: newName,
              path: newPath
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
      
      // Real-time update methods - Otimizado com indexer O(1)
      addNode: (parentPath: string, node: FileTreeNode) => {
        set(state => {
          if (!state.root) return state;
          
          // Usa o indexer para operação O(1) se possível
          const success = fileTreeIndexer.addNode(state.root.path, parentPath, node);
          if (success) {
            // Se o indexer conseguiu adicionar, reconstrói a árvore baseada no índice
            const newRoot = rebuildTreeFromIndex(state.root.path, state.root);
            if (newRoot) {
              return { root: newRoot };
            }
          }
          
          // Fallback para método anterior se indexer falhar
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
              return {
                ...currentNode,
                children: updatedChildren
              };
            }
            return currentNode;
          };
          
          const newRoot = addNodeToTree(state.root);
          
          // Reconstrói o índice após mudança
          if (newRoot !== state.root) {
            fileTreeIndexer.rebuildIndex(state.root.path, newRoot);
          }
          
          return { root: newRoot };
        });
      },
      
      removeNode: (path: string) => {
        set(state => {
          if (!state.root) return state;
          
          // Usa o indexer para operação O(k) otimizada onde k = descendentes
          const success = fileTreeIndexer.removeNode(state.root.path, path);
          if (success) {
            // Se o indexer conseguiu remover, reconstrói a árvore baseada no índice
            const newRoot = rebuildTreeFromIndex(state.root.path, state.root);
            if (newRoot) {
              return { root: newRoot };
            }
          }
          
          // Fallback para método anterior se indexer falhar
          const removeNodeFromTree = (currentNode: FileTreeNode): FileTreeNode | null => {
            if (currentNode.path === path) {
              return null;
            } else if (currentNode.type === 'directory' && currentNode.children) {
              const updatedChildren = currentNode.children
                .map(child => removeNodeFromTree(child))
                .filter(child => child !== null) as FileTreeNode[];
              
              return {
                ...currentNode,
                children: updatedChildren
              };
            }
            return currentNode;
          };
          
          const newRoot = removeNodeFromTree(state.root);
          const finalRoot = newRoot || state.root;
          
          // Reconstrói o índice após mudança
          if (finalRoot !== state.root) {
            fileTreeIndexer.rebuildIndex(state.root.path, finalRoot);
          }
          
          return { root: finalRoot };
        });
      },
      
      updateNode: (path: string, updatedNode: Partial<FileTreeNode>) => {
        set(state => {
          if (!state.root) return state;
          
          // Usa o indexer para operação O(1) otimizada
          const success = fileTreeIndexer.updateNode(state.root.path, path, updatedNode);
          if (success) {
            // Se o indexer conseguiu atualizar, reconstrói a árvore baseada no índice
            const newRoot = rebuildTreeFromIndex(state.root.path, state.root);
            if (newRoot) {
              return { root: newRoot };
            }
          }
          
          // Fallback para método anterior se indexer falhar
          const updateNodeInTree = (currentNode: FileTreeNode): FileTreeNode => {
            if (currentNode.path === path) {
              return {
                ...currentNode,
                ...updatedNode
              };
            } else if (currentNode.type === 'directory' && currentNode.children) {
              const updatedChildren = currentNode.children.map(child => updateNodeInTree(child));
              return {
                ...currentNode,
                children: updatedChildren
              };
            }
            return currentNode;
          };
          
          const newRoot = updateNodeInTree(state.root);
          
          // Reconstrói o índice após mudança
          if (newRoot !== state.root) {
            fileTreeIndexer.rebuildIndex(state.root.path, newRoot);
          }
          
          return { root: newRoot };
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
      onRehydrateStorage: (_state) => {
        return (state, error) => {
          if (error) {
            console.error('Failed to hydrate file tree store:', error);
          } else if (state) {
            // Convert array back to Set after hydration
            state.expandedPaths = new Set(state.expandedPaths);
          }
        };
      }
    }
  )
);