import { useRef, useCallback, useEffect } from 'react'

// Tipos das mensagens do worker
export type WorkerMessageType = 
  | 'PARSE_FILE_TREE' 
  | 'INDEX_DIRECTORY' 
  | 'SEARCH_FILES' 
  | 'SORT_NODES' 
  | 'FILTER_FILES'

export type WorkerResponseType = 
  | 'TREE_PARSED' 
  | 'DIRECTORY_INDEXED' 
  | 'FILES_FOUND' 
  | 'NODES_SORTED' 
  | 'FILES_FILTERED' 
  | 'ERROR'

// Tipos para opções de processamento
export interface FileTreeFilter {
  showHidden?: boolean
  extensions?: string[]
  maxDepth?: number
  searchTerm?: string
}

export interface FileTreeOptions {
  filter?: FileTreeFilter
  sort?: boolean
  createIndex?: boolean
}

// Tipos para resposta do worker
export interface WorkerResponse<T = any> {
  type: WorkerResponseType
  payload: T
  id: string
  success: boolean
}

export interface ParsedFileTreeResult {
  tree: any
  index?: any
  stats: {
    processingTime: number
    nodeCount: number
    fileCount: number
    directoryCount: number
  }
}

// Hook para gerenciar o Web Worker do FileTree
export function useFileTreeWorker() {
  const workerRef = useRef<Worker | null>(null)
  const pendingCallbacks = useRef<Map<string, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>>(new Map())
  
  // Inicializa o worker
  useEffect(() => {
    // Cria o worker apenas no browser
    if (typeof window !== 'undefined') {
      try {
        workerRef.current = new Worker('/workers/fileTreeWorker.js')
        
        // Configura listener para respostas do worker
        workerRef.current.onmessage = (event: MessageEvent<WorkerResponse>) => {
          const { id, success, payload } = event.data
          
          const callbacks = pendingCallbacks.current.get(id)
          if (!callbacks) return
          
          pendingCallbacks.current.delete(id)
          
          if (success) {
            callbacks.resolve(payload)
          } else {
            const error = payload.message ? new Error(payload.message) : new Error('Worker error')
            callbacks.reject(error)
          }
        }
        
        // Configura handler para erros do worker
        workerRef.current.onerror = (error) => {
          console.error('FileTree Worker error:', error)
          
          // Rejeita todas as promises pendentes
          for (const [id, callbacks] of pendingCallbacks.current.entries()) {
            callbacks.reject(new Error('Worker crashed'))
            pendingCallbacks.current.delete(id)
          }
        }
      } catch (error) {
        console.error('Failed to create FileTree Worker:', error)
      }
    }
    
    // Cleanup
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
      
      // Rejeita promises pendentes
      for (const [id, callbacks] of pendingCallbacks.current.entries()) {
        callbacks.reject(new Error('Worker terminated'))
        pendingCallbacks.current.delete(id)
      }
    }
  }, [])
  
  // Função genérica para enviar mensagem para o worker
  const sendMessage = useCallback(<T = any>(
    type: WorkerMessageType, 
    payload: any
  ): Promise<T> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not initialized'))
        return
      }
      
      const id = Math.random().toString(36).substring(2, 15)
      
      // Armazena callbacks para esta operação
      pendingCallbacks.current.set(id, { resolve, reject })
      
      // Envia mensagem para o worker
      workerRef.current.postMessage({
        type,
        payload,
        id
      })
      
      // Timeout de 30 segundos
      setTimeout(() => {
        const callbacks = pendingCallbacks.current.get(id)
        if (callbacks) {
          pendingCallbacks.current.delete(id)
          callbacks.reject(new Error('Worker timeout'))
        }
      }, 30000)
    })
  }, [])
  
  // Parse completo da árvore de arquivos
  const parseFileTree = useCallback(async (
    tree: any, 
    options: FileTreeOptions = {}
  ): Promise<ParsedFileTreeResult> => {
    return sendMessage<ParsedFileTreeResult>('PARSE_FILE_TREE', {
      tree,
      options
    })
  }, [sendMessage])
  
  // Indexa diretório para busca otimizada
  const indexDirectory = useCallback(async (tree: any): Promise<any> => {
    return sendMessage('INDEX_DIRECTORY', { tree })
  }, [sendMessage])
  
  // Busca arquivos na árvore
  const searchFiles = useCallback(async (
    tree: any, 
    query: string
  ): Promise<Array<{ name: string; path: string; type: string; parent: string }>> => {
    return sendMessage('SEARCH_FILES', { tree, query })
  }, [sendMessage])
  
  // Ordena nós da árvore
  const sortNodes = useCallback(async (nodes: any[]): Promise<any[]> => {
    return sendMessage('SORT_NODES', { nodes })
  }, [sendMessage])
  
  // Filtra arquivos baseado em critérios
  const filterFiles = useCallback(async (
    tree: any, 
    filter: FileTreeFilter
  ): Promise<any> => {
    return sendMessage('FILTER_FILES', { tree, filter })
  }, [sendMessage])
  
  // Verifica se o worker está disponível
  const isWorkerReady = useCallback(() => {
    return workerRef.current !== null
  }, [])
  
  return {
    parseFileTree,
    indexDirectory,
    searchFiles,
    sortNodes,
    filterFiles,
    isWorkerReady
  }
}