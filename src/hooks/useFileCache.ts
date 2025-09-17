import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileService } from '../services/fileService';

// Query keys para organizção do cache
export const fileKeys = {
  all: ['files'] as const,
  file: (path: string) => ['files', 'content', path] as const,
  directory: (path: string) => ['files', 'directory', path] as const,
  metadata: (path: string) => ['files', 'metadata', path] as const,
};

// Hook para cache de conteúdo de arquivo com React Query
export function useFileContent(path: string, enabled: boolean = true) {
  return useQuery({
    queryKey: fileKeys.file(path),
    queryFn: async () => {
      if (!path) throw new Error('Path is required');
      return await FileService.readFile(path);
    },
    enabled: enabled && Boolean(path),
    staleTime: 5 * 60 * 1000, // 5 minutos - dados são "fresh"
    gcTime: 10 * 60 * 1000, // 10 minutos - tempo no cache
    retry: 2,
    retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
  });
}

// Hook para salvar arquivo com cache invalidation
export function useSaveFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ path, content }: { path: string; content: string }) => {
      return await FileService.writeFile(path, content);
    },
    onSuccess: (_, variables) => {
      // Invalida o cache do arquivo específico
      queryClient.invalidateQueries({ queryKey: fileKeys.file(variables.path) });
      
      // Opcionalmente, atualiza o cache diretamente
      queryClient.setQueryData(fileKeys.file(variables.path), variables.content);
    },
    onError: (error) => {
      console.error('Failed to save file:', error);
    },
  });
}

// Hook para metadata de arquivo
export function useFileMetadata(path: string, enabled: boolean = true) {
  return useQuery({
    queryKey: fileKeys.metadata(path),
    queryFn: async () => {
      if (!path) throw new Error('Path is required');
      // Assumindo que o FileService tem um método para metadata
      return null; // TODO: Implement getFileMetadata
    },
    enabled: enabled && Boolean(path),
    staleTime: 2 * 60 * 1000, // 2 minutos
    gcTime: 5 * 60 * 1000, // 5 minutos
  });
}

// Hook para pré-carregar arquivo (prefetch)
export function usePrefetchFile() {
  const queryClient = useQueryClient();

  return function prefetchFile(path: string) {
    return queryClient.prefetchQuery({
      queryKey: fileKeys.file(path),
      queryFn: () => FileService.readFile(path),
      staleTime: 5 * 60 * 1000,
    });
  };
}

// Hook para limpar cache de arquivo
export function useInvalidateFileCache() {
  const queryClient = useQueryClient();

  return {
    invalidateFile: (path: string) => {
      queryClient.invalidateQueries({ queryKey: fileKeys.file(path) });
    },
    invalidateDirectory: (dirPath: string) => {
      queryClient.invalidateQueries({ queryKey: fileKeys.directory(dirPath) });
    },
    invalidateAll: () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
    removeFile: (path: string) => {
      queryClient.removeQueries({ queryKey: fileKeys.file(path) });
    },
  };
}

// Hook para otimistic updates
export function useOptimisticFileUpdate() {
  const queryClient = useQueryClient();

  return function updateFileOptimistically(path: string, newContent: string) {
    // Atualiza imediatamente o cache sem aguardar o servidor
    queryClient.setQueryData(fileKeys.file(path), newContent);

    // Retorna função de rollback em caso de erro
    return () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.file(path) });
    };
  };
}

// Hook para batching de operações de arquivo
export function useBatchFileOperations() {
  const queryClient = useQueryClient();
  const saveFile = useSaveFile();

  return {
    saveMultipleFiles: async (files: Array<{ path: string; content: string }>) => {
      // Salva todos os arquivos em paralelo
      const savePromises = files.map(file => 
        saveFile.mutateAsync(file)
      );

      try {
        await Promise.all(savePromises);
        
        // Invalida queries relacionadas após sucesso
        files.forEach(file => {
          queryClient.invalidateQueries({ queryKey: fileKeys.file(file.path) });
        });
        
        return { success: true };
      } catch (error) {
        console.error('Batch save failed:', error);
        return { success: false, error };
      }
    },

    prefetchMultipleFiles: async (paths: string[]) => {
      const prefetchPromises = paths.map(path =>
        queryClient.prefetchQuery({
          queryKey: fileKeys.file(path),
          queryFn: () => FileService.readFile(path),
          staleTime: 5 * 60 * 1000,
        })
      );

      try {
        await Promise.all(prefetchPromises);
        return { success: true };
      } catch (error) {
        console.error('Batch prefetch failed:', error);
        return { success: false, error };
      }
    },
  };
}