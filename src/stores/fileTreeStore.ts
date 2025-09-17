import { create } from 'zustand';
import { FileTreeService } from '../services/fileTreeService';
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
  
  // Real-time update methods
  addNode: (parentPath: string, node: FileTreeNode) => {
    set(state => {
      if (!state.root) return state;
      
      // Function to recursively add node to the tree
      const addNodeToTree = (currentNode: FileTreeNode): FileTreeNode => {
        if (currentNode.path === parentPath && currentNode.type === 'directory') {
          // Found the parent directory, add the new node
          const updatedNode = {
            ...currentNode,
            children: [...(currentNode.children || []), node]
          };
          
          // Sort children (directories first, then alphabetically)
          updatedNode.children?.sort((a, b) => {
            if (a.type === 'directory' && b.type === 'file') return -1;
            if (a.type === 'file' && b.type === 'directory') return 1;
            return a.name.localeCompare(b.name);
          });
          
          return updatedNode;
        } else if (currentNode.type === 'directory' && currentNode.children) {
          // Recursively search in children
          const updatedChildren = currentNode.children.map(child => addNodeToTree(child));
          return {
            ...currentNode,
            children: updatedChildren
          };
        }
        return currentNode;
      };
      
      const newRoot = addNodeToTree(state.root);
      return { root: newRoot };
    });
  },
  
  removeNode: (path: string) => {
    set(state => {
      if (!state.root) return state;
      
      // Function to recursively remove node from the tree
      const removeNodeFromTree = (currentNode: FileTreeNode): FileTreeNode | null => {
        if (currentNode.path === path) {
          // Found the node to remove
          return null;
        } else if (currentNode.type === 'directory' && currentNode.children) {
          // Recursively search in children
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
      return { root: newRoot || state.root };
    });
  },
  
  updateNode: (path: string, updatedNode: Partial<FileTreeNode>) => {
    set(state => {
      if (!state.root) return state;
      
      // Function to recursively update node in the tree
      const updateNodeInTree = (currentNode: FileTreeNode): FileTreeNode => {
        if (currentNode.path === path) {
          // Found the node to update
          return {
            ...currentNode,
            ...updatedNode
          };
        } else if (currentNode.type === 'directory' && currentNode.children) {
          // Recursively search in children
          const updatedChildren = currentNode.children.map(child => updateNodeInTree(child));
          return {
            ...currentNode,
            children: updatedChildren
          };
        }
        return currentNode;
      };
      
      const newRoot = updateNodeInTree(state.root);
      return { root: newRoot };
    });
  }
}));