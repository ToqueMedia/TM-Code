import type { FileTreeNode } from '../types/fileTree';

export interface FileTreeIndex {
  pathToNode: Map<string, FileTreeNode>;
  parentToChildren: Map<string, FileTreeNode[]>;
  rootPath: string;
}

export class FileTreeIndexer {
  private static instance: FileTreeIndexer | null = null;
  private indexes: Map<string, FileTreeIndex> = new Map();

  private constructor() {
    // Singleton pattern
  }

  static getInstance(): FileTreeIndexer {
    if (!FileTreeIndexer.instance) {
      FileTreeIndexer.instance = new FileTreeIndexer();
    }
    return FileTreeIndexer.instance;
  }

  static destroy(): void {
    if (FileTreeIndexer.instance) {
      FileTreeIndexer.instance.clearAll();
      FileTreeIndexer.instance = null;
    }
  }

  /**
   * Cria um índice completo para uma árvore de arquivos
   */
  buildIndex(root: FileTreeNode): FileTreeIndex {
    const pathToNode = new Map<string, FileTreeNode>();
    const parentToChildren = new Map<string, FileTreeNode[]>();
    const rootPath = root.path;

    // Função recursiva para percorrer a árvore
    function traverseAndIndex(node: FileTreeNode, parentPath?: string): void {
      // Indexa o nó atual
      pathToNode.set(node.path, node);

      // Se tem pai, adiciona à lista de filhos do pai
      if (parentPath) {
        if (!parentToChildren.has(parentPath)) {
          parentToChildren.set(parentPath, []);
        }
        parentToChildren.get(parentPath)!.push(node);
      }

      // Se é um diretório com filhos, processa recursivamente
      if (node.type === 'directory' && node.children) {
        // Inicializa lista de filhos mesmo que vazia
        if (!parentToChildren.has(node.path)) {
          parentToChildren.set(node.path, []);
        }

        // Processa filhos
        node.children.forEach(child => {
          traverseAndIndex(child, node.path);
        });

        // Ordena filhos (diretórios primeiro, depois por nome)
        const children = parentToChildren.get(node.path)!;
        children.sort((a, b) => {
          if (a.type === 'directory' && b.type === 'file') return -1;
          if (a.type === 'file' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }

    traverseAndIndex(root);

    const index: FileTreeIndex = {
      pathToNode,
      parentToChildren,
      rootPath
    };

    // Armazena o índice para reutilização
    this.indexes.set(rootPath, index);

    return index;
  }

  /**
   * Obtém o índice para um projeto específico
   */
  getIndex(rootPath: string): FileTreeIndex | null {
    return this.indexes.get(rootPath) || null;
  }

  /**
   * Atualiza um nó no índice (operação O(1))
   */
  updateNode(rootPath: string, path: string, updatedNode: Partial<FileTreeNode>): boolean {
    const index = this.indexes.get(rootPath);
    if (!index) return false;

    const existingNode = index.pathToNode.get(path);
    if (!existingNode) return false;

    // Atualiza o nó
    const newNode = { ...existingNode, ...updatedNode };
    index.pathToNode.set(path, newNode);

    // Se mudou o path, precisa atualizar os índices
    if (updatedNode.path && updatedNode.path !== path) {
      index.pathToNode.delete(path);
      index.pathToNode.set(updatedNode.path, newNode);

      // Atualiza também nas listas de filhos dos pais
      const parentPath = this.getParentPath(path);
      if (parentPath && index.parentToChildren.has(parentPath)) {
        const siblings = index.parentToChildren.get(parentPath)!;
        const siblingIndex = siblings.findIndex(s => s.path === path);
        if (siblingIndex !== -1) {
          siblings[siblingIndex] = newNode;
        }
      }
    }

    return true;
  }

  /**
   * Adiciona um novo nó ao índice (operação O(1))
   */
  addNode(rootPath: string, parentPath: string, newNode: FileTreeNode): boolean {
    const index = this.indexes.get(rootPath);
    if (!index) return false;

    // Verifica se o pai existe
    const parentNode = index.pathToNode.get(parentPath);
    if (!parentNode || parentNode.type !== 'directory') {
      return false;
    }

    // Adiciona o nó ao índice
    index.pathToNode.set(newNode.path, newNode);

    // Adiciona à lista de filhos do pai
    if (!index.parentToChildren.has(parentPath)) {
      index.parentToChildren.set(parentPath, []);
    }

    const children = index.parentToChildren.get(parentPath)!;
    children.push(newNode);

    // Reordena os filhos
    children.sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    // Se o novo nó é um diretório, inicializa sua lista de filhos
    if (newNode.type === 'directory') {
      index.parentToChildren.set(newNode.path, []);
    }

    return true;
  }

  /**
   * Remove um nó do índice (operação O(k) onde k é o número de descendentes)
   */
  removeNode(rootPath: string, path: string): boolean {
    const index = this.indexes.get(rootPath);
    if (!index) return false;

    const node = index.pathToNode.get(path);
    if (!node) return false;

    // Remove recursivamente todos os descendentes
    this.removeNodeRecursive(index, path);

    // Remove da lista de filhos do pai
    const parentPath = this.getParentPath(path);
    if (parentPath && index.parentToChildren.has(parentPath)) {
      const siblings = index.parentToChildren.get(parentPath)!;
      const siblingIndex = siblings.findIndex(s => s.path === path);
      if (siblingIndex !== -1) {
        siblings.splice(siblingIndex, 1);
      }
    }

    return true;
  }

  /**
   * Remove recursivamente um nó e seus descendentes
   */
  private removeNodeRecursive(index: FileTreeIndex, path: string): void {
    // Remove filhos primeiro (se houver)
    const children = index.parentToChildren.get(path);
    if (children) {
      children.forEach(child => {
        this.removeNodeRecursive(index, child.path);
      });
      index.parentToChildren.delete(path);
    }

    // Remove o nó
    index.pathToNode.delete(path);
  }

  /**
   * Obtém um nó pelo path (operação O(1))
   */
  getNode(rootPath: string, path: string): FileTreeNode | null {
    const index = this.indexes.get(rootPath);
    if (!index) return null;

    return index.pathToNode.get(path) || null;
  }

  /**
   * Obtém os filhos de um diretório (operação O(1))
   */
  getChildren(rootPath: string, path: string): FileTreeNode[] {
    const index = this.indexes.get(rootPath);
    if (!index) return [];

    return index.parentToChildren.get(path) || [];
  }

  /**
   * Verifica se um path existe (operação O(1))
   */
  hasPath(rootPath: string, path: string): boolean {
    const index = this.indexes.get(rootPath);
    if (!index) return false;

    return index.pathToNode.has(path);
  }

  /**
   * Obtém todos os paths indexados
   */
  getAllPaths(rootPath: string): string[] {
    const index = this.indexes.get(rootPath);
    if (!index) return [];

    return Array.from(index.pathToNode.keys());
  }

  /**
   * Obtém estatísticas do índice
   */
  getIndexStats(rootPath: string): {
    totalNodes: number;
    directories: number;
    files: number;
    maxDepth: number;
  } | null {
    const index = this.indexes.get(rootPath);
    if (!index) return null;

    let directories = 0;
    let files = 0;
    let maxDepth = 0;

    for (const [path, node] of index.pathToNode) {
      if (node.type === 'directory') {
        directories++;
      } else {
        files++;
      }

      // Calcula profundidade baseada no path
      const depth = path.split('/').length - rootPath.split('/').length;
      maxDepth = Math.max(maxDepth, depth);
    }

    return {
      totalNodes: index.pathToNode.size,
      directories,
      files,
      maxDepth
    };
  }

  /**
   * Reconstrói o índice completo (usado quando a estrutura muda drasticamente)
   */
  rebuildIndex(rootPath: string, newRoot: FileTreeNode): FileTreeIndex {
    // Remove índice anterior
    this.indexes.delete(rootPath);
    
    // Constrói novo índice
    return this.buildIndex(newRoot);
  }

  /**
   * Remove um índice específico
   */
  clearIndex(rootPath: string): boolean {
    return this.indexes.delete(rootPath);
  }

  /**
   * Remove todos os índices
   */
  clearAll(): void {
    this.indexes.clear();
  }

  /**
   * Helper para obter o path do pai
   */
  private getParentPath(path: string): string | null {
    const lastSlashIndex = path.lastIndexOf('/');
    if (lastSlashIndex <= 0) return null;
    return path.substring(0, lastSlashIndex);
  }

  /**
   * Busca nós por padrão (útil para filtros)
   */
  searchNodes(rootPath: string, pattern: string): FileTreeNode[] {
    const index = this.indexes.get(rootPath);
    if (!index) return [];

    const results: FileTreeNode[] = [];
    const lowercasePattern = pattern.toLowerCase();

    for (const node of index.pathToNode.values()) {
      if (node.name.toLowerCase().includes(lowercasePattern)) {
        results.push(node);
      }
    }

    return results;
  }

  /**
   * Obtém todos os arquivos de um tipo específico
   */
  getFilesByExtension(rootPath: string, extension: string): FileTreeNode[] {
    const index = this.indexes.get(rootPath);
    if (!index) return [];

    const results: FileTreeNode[] = [];
    const targetExt = extension.toLowerCase();

    for (const node of index.pathToNode.values()) {
      if (node.type === 'file' && node.extension?.toLowerCase() === targetExt) {
        results.push(node);
      }
    }

    return results;
  }
}