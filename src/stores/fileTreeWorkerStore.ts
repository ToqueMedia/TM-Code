import { create } from 'zustand'
import type { FileTreeOptions, FileTreeFilter } from '../hooks/useFileTreeWorker'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  parent?: string
  extension?: string
  metadata?: {
    size: number
    created: string
    modified: string
    isHidden: boolean
    permissions: string
  }
  selected?: boolean
  expanded?: boolean
}

export interface FileTreeIndex {
  pathToNode: Record<string, FileNode>
  parentToChildren: Record<string, FileNode[]>
  typeIndex: {
    files: string[]
    directories: string[]
  }
  extensionIndex: Record<string, string[]>
}

interface FileTreeWorkerState {
  worker: Worker | null
  isLoading: boolean
  error: Error | null
  lastProcessed: {
    timestamp: number
    processingTime: number
    nodeCount: number
  } | null
  index: FileTreeIndex | null
  pendingOperations: Map<string, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>
}

interface FileTreeWorkerActions {
  initWorker: () => void
  sendMessage: (type: string, payload: any) => Promise<any>
  processTree: (tree: FileNode, options?: FileTreeOptions) => Promise<FileNode>
  searchInTree: (tree: FileNode, query: string) => Promise<Array<FileNode>>
  filterTree: (tree: FileNode, filter: FileTreeFilter) => Promise<FileNode>
  createIndex: (tree: FileNode) => Promise<FileTreeIndex>
  getNodeByPath: (path: string) => FileNode | null
  getChildrenByPath: (path: string) => FileNode[] | null
  getFilesByExtension: (extension: string) => string[] | null
  getDirectories: () => string[] | null
  getFiles: () => string[] | null
  resetState: () => void
}

// Singleton para o worker que pode ser compartilhado entre componentes
let globalWorker: Worker | null = null

// Store para gerenciar Web Worker de processamento do FileTree
export const useFileTreeWorkerStore = create<FileTreeWorkerState & FileTreeWorkerActions>((set, get) => ({
  worker: null,
  isLoading: false,
  error: null,
  lastProcessed: null,
  index: null,
  pendingOperations: new Map(),

  // Inicializa o worker (deve ser chamado após o componente montar)
  initWorker: () => {
    // Se já temos uma instância global, use-a
    if (globalWorker) {
      set({ worker: globalWorker })
      return
    }

    // Certifique-se de estar no browser
    if (typeof window !== 'undefined') {
      try {
        // Cria a instância do worker diretamente
        const worker = new Worker('/workers/fileTreeWorker.js')
        
        // Configura listener para respostas do worker
        worker.onmessage = (event) => {
          const { id, success, payload } = event.data
          const { pendingOperations } = get()
          
          const callbacks = pendingOperations.get(id)
          if (!callbacks) return
          
          pendingOperations.delete(id)
          set({ pendingOperations: new Map(pendingOperations) })
          
          if (success) {
            callbacks.resolve(payload)
          } else {
            const error = payload.message ? new Error(payload.message) : new Error('Worker error')
            callbacks.reject(error)
          }
        }
        
        // Configura handler para erros do worker
        worker.onerror = (error) => {
          console.error('FileTree Worker error:', error)
          const { pendingOperations } = get()
          
          // Rejeita todas as promises pendentes
          for (const [, callbacks] of pendingOperations.entries()) {
            callbacks.reject(new Error('Worker crashed'))
          }
          
          set({ 
            pendingOperations: new Map(),
            error: new Error('Worker crashed')
          })
        }
        
        globalWorker = worker
        set({ worker })
      } catch (error) {
        console.error('Failed to initialize FileTree Worker:', error)
        set({ error: error instanceof Error ? error : new Error('Failed to initialize worker') })
      }
    }
  },

  // Helper para enviar mensagem para o worker
  sendMessage: (type: string, payload: any): Promise<any> => {
    const { worker, pendingOperations } = get()
    
    if (!worker) {
      return Promise.reject(new Error('Worker not initialized'))
    }
    
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substring(2, 15)
      
      // Armazena callbacks para esta operação
      const newPendingOps = new Map(pendingOperations)
      newPendingOps.set(id, { resolve, reject })
      set({ pendingOperations: newPendingOps })
      
      // Envia mensagem para o worker
      worker.postMessage({
        type,
        payload,
        id
      })
      
      // Timeout de 30 segundos
      setTimeout(() => {
        const { pendingOperations } = get()
        const callbacks = pendingOperations.get(id)
        if (callbacks) {
          const updatedPendingOps = new Map(pendingOperations)
          updatedPendingOps.delete(id)
          set({ pendingOperations: updatedPendingOps })
          callbacks.reject(new Error('Worker timeout'))
        }
      }, 30000)
    })
  },

  // Processa a árvore de arquivos usando o worker
  processTree: async (tree: FileNode, options: FileTreeOptions = {}) => {
    try {
      set({ isLoading: true, error: null })
      
      const result = await get().sendMessage('PARSE_FILE_TREE', {
        tree,
        options
      })
      
      // Atualiza o estado com informações de processamento
      set({
        isLoading: false,
        lastProcessed: {
          timestamp: Date.now(),
          processingTime: result.stats.processingTime,
          nodeCount: result.stats.nodeCount
        },
        index: result.index || null
      })
      
      return result.tree
    } catch (error) {
      set({ 
        isLoading: false, 
        error: error instanceof Error ? error : new Error('Failed to process file tree') 
      })
      throw error
    }
  },

  // Busca arquivos na árvore
  searchInTree: async (tree: FileNode, query: string) => {
    try {
      set({ isLoading: true, error: null })
      
      const results = await get().sendMessage('SEARCH_FILES', { tree, query })
      
      set({ isLoading: false })
      
      // Converte resultados para o tipo FileNode
      return results.map((result: any) => ({
        name: result.name,
        path: result.path,
        type: result.type as 'file' | 'directory',
        parent: result.parent
      }))
    } catch (error) {
      set({ 
        isLoading: false, 
        error: error instanceof Error ? error : new Error('Failed to search in file tree') 
      })
      throw error
    }
  },

  // Filtra árvore baseado em critérios
  filterTree: async (tree: FileNode, filter: FileTreeFilter) => {
    try {
      set({ isLoading: true, error: null })
      
      const filteredTree = await get().sendMessage('FILTER_FILES', { tree, filter })
      
      set({ isLoading: false })
      
      return filteredTree
    } catch (error) {
      set({ 
        isLoading: false, 
        error: error instanceof Error ? error : new Error('Failed to filter file tree') 
      })
      throw error
    }
  },

  // Cria índice para operações rápidas na árvore
  createIndex: async (tree: FileNode) => {
    try {
      set({ isLoading: true, error: null })
      
      const index = await get().sendMessage('INDEX_DIRECTORY', { tree })
      
      set({ isLoading: false, index })
      
      return index
    } catch (error) {
      set({ 
        isLoading: false, 
        error: error instanceof Error ? error : new Error('Failed to create file tree index') 
      })
      throw error
    }
  },

  // Recupera nó pelo path do índice
  getNodeByPath: (path: string) => {
    const { index } = get()
    if (!index) return null
    return index.pathToNode[path] || null
  },

  // Recupera filhos de um path
  getChildrenByPath: (path: string) => {
    const { index } = get()
    if (!index) return null
    return index.parentToChildren[path] || null
  },

  // Recupera arquivos por extensão
  getFilesByExtension: (extension: string) => {
    const { index } = get()
    if (!index) return null
    return index.extensionIndex[extension] || null
  },

  // Recupera todos os diretórios
  getDirectories: () => {
    const { index } = get()
    if (!index) return null
    return index.typeIndex.directories
  },

  // Recupera todos os arquivos
  getFiles: () => {
    const { index } = get()
    if (!index) return null
    return index.typeIndex.files
  },

  // Reseta o estado
  resetState: () => {
    const { worker, pendingOperations } = get()
    
    // Rejeita todas as operações pendentes
    for (const [, callbacks] of pendingOperations.entries()) {
      callbacks.reject(new Error('Worker reset'))
    }
    
    // Termina o worker se existir
    if (worker) {
      worker.terminate()
      globalWorker = null
    }
    
    set({
      worker: null,
      isLoading: false,
      error: null,
      lastProcessed: null,
      index: null,
      pendingOperations: new Map()
    })
  }
}))