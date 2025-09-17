import { QueryClient } from '@tanstack/react-query';

// Configuração otimizada do QueryClient
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Tempo que os dados são considerados "fresh" (não fazem nova requisição)
      staleTime: 5 * 60 * 1000, // 5 minutos
      
      // Tempo que os dados ficam no cache após não serem mais utilizados
      gcTime: 10 * 60 * 1000, // 10 minutos
      
      // Retry configuration
      retry: (failureCount, error) => {
        // Não retry para erros específicos (arquivo não encontrado, permissão)
        if (error && typeof error === 'object' && 'message' in error) {
          const errorMessage = (error as Error).message.toLowerCase();
          if (errorMessage.includes('not found') || 
              errorMessage.includes('permission') ||
              errorMessage.includes('access denied')) {
            return false;
          }
        }
        
        // Máximo de 3 tentativas para outros erros
        return failureCount < 3;
      },
      
      // Retry delay exponencial
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
      
      // Não refetch automaticamente quando a janela volta ao foco
      refetchOnWindowFocus: false,
      
      // Não refetch quando reconecta à internet (pode ser habilitado se necessário)
      refetchOnReconnect: true,
      
      // Refetch quando o componente monta (útil para dados que podem mudar)
      refetchOnMount: 'always',
    },
    mutations: {
      // Retry para mutations (salvamento de arquivos)
      retry: 2,
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 5000),
    },
  },
});

// Configurações específicas para diferentes tipos de cache
export const cacheConfig = {
  // Para conteúdo de arquivos (pode ser grande e muda frequentemente)
  fileContent: {
    staleTime: 2 * 60 * 1000, // 2 minutos
    gcTime: 5 * 60 * 1000, // 5 minutos
  },
  
  // Para estrutura de diretórios (muda menos frequentemente)
  fileTree: {
    staleTime: 10 * 60 * 1000, // 10 minutos
    gcTime: 20 * 60 * 1000, // 20 minutos
  },
  
  // Para metadata de arquivos (muda raramente)
  fileMetadata: {
    staleTime: 15 * 60 * 1000, // 15 minutos
    gcTime: 30 * 60 * 1000, // 30 minutos
  },
  
  // Para configurações de projeto (muito estável)
  projectConfig: {
    staleTime: 30 * 60 * 1000, // 30 minutos
    gcTime: 60 * 60 * 1000, // 1 hora
  },
} as const;

// Utilitários para gerenciamento do cache
export const cacheUtils = {
  // Limpar todo o cache (útil para logout ou refresh completo)
  clearAllCache: () => {
    queryClient.clear();
  },
  
  // Limpar cache de arquivos específicos
  clearFileCache: (pathPattern?: string) => {
    queryClient.removeQueries({
      predicate: (query) => {
        const [category, type, path] = query.queryKey;
        if (category !== 'files') return false;
        
        if (pathPattern && typeof path === 'string') {
          return path.includes(pathPattern);
        }
        
        return type === 'content' || type === 'metadata';
      }
    });
  },
  
  // Invalidar cache de um diretório e todos os seus filhos
  invalidateDirectory: async (dirPath: string) => {
    await queryClient.invalidateQueries({
      predicate: (query) => {
        const [category, , path] = query.queryKey;
        if (category !== 'files') return false;
        
        if (typeof path === 'string') {
          return path.startsWith(dirPath);
        }
        
        return false;
      }
    });
  },
  
  // Prefetch arquivos relacionados (quando abrir um arquivo, prefetch arquivos similares)
  prefetchRelatedFiles: async (filePath: string) => {
    const directory = filePath.substring(0, filePath.lastIndexOf('/'));
    const extension = filePath.split('.').pop();
    
    // Aqui você poderia implementar lógica para prefetch de arquivos relacionados
    // Por exemplo, outros arquivos na mesma pasta com a mesma extensão
    console.log(`Prefetching related files for ${filePath} in ${directory} with extension ${extension}`);
  },
  
  // Estatísticas do cache
  getCacheStats: () => {
    const cache = queryClient.getQueryCache();
    const queries = cache.getAll();
    
    return {
      totalQueries: queries.length,
      activeQueries: queries.filter(q => q.getObserversCount() > 0).length,
      staleSeries: queries.filter(q => q.isStale()).length,
      cacheSize: queries.reduce((acc, query) => {
        const data = query.state.data;
        if (typeof data === 'string') {
          return acc + data.length;
        }
        return acc + JSON.stringify(data || '').length;
      }, 0),
    };
  }
};

// Event listeners para limpeza automática do cache
if (typeof window !== 'undefined') {
  // Limpar cache quando a página for descarregada
  window.addEventListener('beforeunload', () => {
    // Opcional: persiste algumas queries importantes
    const importantQueries = queryClient.getQueryCache().getAll()
      .filter(query => {
        const [category] = query.queryKey;
        return category === 'project' || category === 'config';
      });
    
    // Salva no localStorage se necessário
    if (importantQueries.length > 0) {
      try {
        localStorage.setItem('cached_queries', JSON.stringify(
          importantQueries.map(q => ({
            queryKey: q.queryKey,
            data: q.state.data,
            dataUpdatedAt: q.state.dataUpdatedAt,
          }))
        ));
      } catch (error) {
        console.warn('Failed to persist queries:', error);
      }
    }
  });
  
  // Restaurar cache importante quando a página carregar
  window.addEventListener('load', () => {
    try {
      const cachedQueries = localStorage.getItem('cached_queries');
      if (cachedQueries) {
        const queries = JSON.parse(cachedQueries);
        
        queries.forEach((query: any) => {
          queryClient.setQueryData(query.queryKey, query.data);
        });
        
        // Limpa o cache persistido após restaurar
        localStorage.removeItem('cached_queries');
      }
    } catch (error) {
      console.warn('Failed to restore cached queries:', error);
    }
  });
}