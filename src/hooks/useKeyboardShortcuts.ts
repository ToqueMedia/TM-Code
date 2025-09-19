// src/hooks/useKeyboardShortcuts.ts
import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useDialog } from './useDialog';
import DebuggerService from '../services/debuggerService';

export function useKeyboardShortcuts() {
  const { currentProject, closeProject } = useProjectStore();
  const { open: openProject } = useDialog();
  const { open: newProject } = useDialog();
  const debuggerService = DebuggerService.getInstance();

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (currentProject && (e.ctrlKey || e.metaKey) && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('panel:toggle-bottom'));
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        openProject();
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        newProject();
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'w' && currentProject) {
        e.preventDefault();
        closeProject();
      }

      if (currentProject) {
        if (e.key === 'F5' && !e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:start'));
        }

        if (e.key === 'F5' && e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:stop'));
        }

        if (e.key === 'F9') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:toggle-breakpoint'));
        }

        if (e.key === 'F10') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-over'));
        }

        if (e.key === 'F11' && !e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-into'));
        }

        if (e.key === 'F11' && e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-out'));
        }

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('search:open'));
        }

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:open'));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentProject, closeProject, openProject, newProject, debuggerService]);
}
