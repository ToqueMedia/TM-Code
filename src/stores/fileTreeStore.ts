import { create } from 'zustand';
import { FileTreeService } from '../services/fileTreeService';
import { FileTreeIndexer } from '../utils/fileTreeIndex';
import type { FileTreeNode, FileTreeFilter } from '../types/fileTree';

interface FileTreeState {
  root: FileTreeNode | null;
  loading: boolean;
  error: string | null;
  expandedPaths: Set<string>;
  selectedPath: string | null;
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
}

// FileTree indexer instance para operações O(1)
const fileTreeIndexer = FileTreeIndexer.getInstance();

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

export const useFileTreeRepository = create<FileTreeState & FileTreeActions>((set, get) => ({
  root: null,
  loading: false,
  error: null,
  expandedPaths: new Set(),
  selectedPath: null,

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
  }
}));