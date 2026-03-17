// src/hooks/useKeyboardShortcuts.ts
import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useDialog } from './useDialog';
import DebuggerService from '../services/debuggerService';
import { useEditorRepository } from '../stores/editorStore';

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

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && currentProject) {
        e.preventDefault();
        try {
          const { activeFile, closeFile } = useEditorRepository.getState();
          if (activeFile) {
            closeFile(activeFile);
            return;
          }
        } catch {}
        closeProject();
      }

      // Quick Open: Cmd+P
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('quickopen:toggle'));
      }

      // Command Palette: Cmd+Shift+P
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('command:palette'));
      }

      // Settings: Cmd+,
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        const layout = useLayoutStore.getState();
        if (layout.viewMode === 'settings') {
          layout.goBack();
        } else {
          layout.setViewMode('settings');
        }
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
