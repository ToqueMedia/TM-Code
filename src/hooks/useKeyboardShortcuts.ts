// src/hooks/useKeyboardShortcuts.ts
import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useDialog } from './useDialog';
import DebuggerService from '../services/debuggerService';
import { useEditorRepository } from '../stores/editorStore';
import MonacoBridge from '../utils/monacoBridge';

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
        return;
      }

      // Go to Symbol: Cmd+Shift+O — disabled (Monaco QuickPick freezes in Tauri WebView)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        if (MonacoBridge.getInstance().getCurrentEditor()) { e.preventDefault(); return; }
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'o') {
        e.preventDefault();
        openProject();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        newProject();
        return;
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
        return;
      }

      // Quick Open: Cmd+P
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('quickopen:toggle'));
        return;
      }

      // Command Palette: Cmd+Shift+P
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('command:palette'));
        return;
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
        return;
      }

      // Split Editor: Cmd+\
      if (currentProject && (e.ctrlKey || e.metaKey) && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('editor:split'));
        return;
      }

      // Toggle Sidebar: Cmd+B (only in editor view)
      if (currentProject && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('sidebar:toggle'));
        return;
      }

      // Go to Line: Cmd+G
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'g' && MonacoBridge.getInstance().getCurrentEditor()) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('editor:go-to-line'));
        return;
      }

      if (currentProject) {
        if (e.key === 'F5' && !e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:start'));
          return;
        }

        if (e.key === 'F5' && e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:stop'));
          return;
        }

        if (e.key === 'F9') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:toggle-breakpoint'));
          return;
        }

        if (e.key === 'F10') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-over'));
          return;
        }

        if (e.key === 'F11' && !e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-into'));
          return;
        }

        if (e.key === 'F11' && e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:step-out'));
          return;
        }

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('search:open'));
          return;
        }

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:open'));
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentProject, closeProject, openProject, newProject, debuggerService]);
}
