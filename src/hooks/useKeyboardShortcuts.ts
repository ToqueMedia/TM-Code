// src/hooks/useKeyboardShortcuts.ts
import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useDialog } from './useDialog';

export function useKeyboardShortcuts() {
  const { currentProject, closeProject } = useProjectStore();
  const { open: openProject } = useDialog();
  const { open: newProject } = useDialog();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + O to open project
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        openProject();
      }

      // Ctrl/Cmd + Shift + N to create new project
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        newProject();
      }

      // Ctrl/Cmd + W to close project
      if ((e.ctrlKey || e.metaKey) && e.key === 'w' && currentProject) {
        e.preventDefault();
        closeProject();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentProject, closeProject, openProject, newProject]);
}