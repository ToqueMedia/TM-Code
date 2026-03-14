import { useCallback, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorRepository } from '../stores/editorStore';

// Hook para projeto atual - só re-renderiza quando currentProject muda
export function useCurrentProject() {
  return useProjectStore(state => state.currentProject);
}

// Hook para projetos recentes - só re-renderiza quando recentProjects muda
export function useRecentProjects() {
  return useProjectStore(state => state.recentProjects);
}

// Hook para estado de loading - só re-renderiza quando loading muda
export function useProjectLoading() {
  return useProjectStore(state => state.loading);
}

// Hook para erro - só re-renderiza quando error muda
export function useProjectError() {
  return useProjectStore(state => state.error);
}

// Hook para window state - só re-renderiza quando windowState muda
export function useWindowState() {
  return useProjectStore(state => state.windowState);
}

// Hook para mudanças não salvas — derivado do editorStore (source of truth)
export function useUnsavedChanges() {
  return useEditorRepository(state =>
    state.openFiles.some(f => f.isDirty)
  );
}

// Hook para ações do projeto - memoizado para evitar re-renders desnecessários
export function useProjectActions() {
  return useProjectStore(
    state => ({
      openProject: state.openProject,
      createProject: state.createProject,
      closeProject: state.closeProject,
      loadRecentProjects: state.loadRecentProjects,
      saveProjectState: state.saveProjectState,
      loadProjectState: state.loadProjectState,
      setWindowState: state.setWindowState,
      updateWindowState: state.updateWindowState,
      setLoading: state.setLoading,
      setError: state.setError,
    })
  );
}

// Hook combinado otimizado para a WelcomeScreen
export function useWelcomeScreenState() {
  const currentProject = useCurrentProject();
  const recentProjects = useRecentProjects();
  const loading = useProjectLoading();
  const error = useProjectError();
  const actions = useProjectActions();

  const handleOpenProject = useCallback((path?: string) => {
    if (path) {
      actions.openProject(path);
    }
  }, [actions]);

  const handleCreateProject = useCallback((path: string, template: string) => {
    actions.createProject(path, template);
  }, [actions]);

  const hasRecentProjects = useMemo(() => recentProjects.length > 0, [recentProjects.length]);
  const isProjectOpen = useMemo(() => currentProject !== null, [currentProject]);

  return {
    currentProject,
    recentProjects,
    loading,
    error,
    hasRecentProjects,
    isProjectOpen,
    handleOpenProject,
    handleCreateProject,
    loadRecentProjects: actions.loadRecentProjects,
  };
}

// Hook combinado otimizado para o App component
export function useAppState() {
  const currentProject = useCurrentProject();
  const recentProjects = useRecentProjects();
  const actions = useProjectActions();

  const handleOpenProject = useCallback((path?: string) => {
    if (path) {
      actions.openProject(path);
    }
  }, [actions]);

  const isInitialized = useMemo(() => {
    return currentProject !== null || recentProjects.length >= 0;
  }, [currentProject, recentProjects.length]);

  return {
    currentProject,
    recentProjects,
    isInitialized,
    handleOpenProject,
    openProject: actions.openProject,
  };
}

// Hook para estado de mudanças não salvas com helpers — derivado do editorStore
export function useUnsavedChangesState() {
  const hasUnsavedChanges = useUnsavedChanges();
  const unsavedFilesList = useEditorRepository(state =>
    state.openFiles.filter(f => f.isDirty).map(f => f.path)
  );

  return {
    hasUnsavedChanges,
    unsavedFilesList,
    unsavedFilesCount: unsavedFilesList.length,
  };
}

// Hook para gerenciamento de window state
export function useWindowStateManager() {
  const windowState = useWindowState();
  const { setWindowState, updateWindowState } = useProjectActions();

  const handleWindowResize = useCallback((width: number, height: number) => {
    setWindowState({
      ...windowState,
      width,
      height,
    });
  }, [windowState, setWindowState]);

  const handleWindowMove = useCallback((x: number, y: number) => {
    setWindowState({
      ...windowState,
      x,
      y,
    });
  }, [windowState, setWindowState]);

  const handleWindowMaximize = useCallback((maximized: boolean) => {
    setWindowState({
      ...windowState,
      maximized,
    });
  }, [windowState, setWindowState]);

  return {
    windowState,
    handleWindowResize,
    handleWindowMove,
    handleWindowMaximize,
    updateWindowState,
  };
}
