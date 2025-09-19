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

      // Debugger shortcuts (only when a project is open)
      if (currentProject) {
        // F5 - Start/Continue debugging
        if (e.key === 'F5' && !e.shiftKey) {
          e.preventDefault();
          // Emit custom event for debugger to handle
          window.dispatchEvent(new CustomEvent('debugger:start'));
        }

        // Shift + F5 - Stop debugging
        if (e.key === 'F5' && e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:stop'));
        }

        // F9 - Toggle breakpoint
        if (e.key === 'F9') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:toggle-breakpoint'));
        }

        // F10 - Step over
        if (e.key === 'F10') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-over'));
        }

        // F11 - Step into
        if (e.key === 'F11' && !e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-into'));
        }

        // Shift + F11 - Step out
        if (e.key === 'F11' && e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-out'));
        }

        // Ctrl/Cmd + Shift + F - Open global search
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('search:open'));
        }

        // Ctrl/Cmd + Shift + D - Open debugger panel
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