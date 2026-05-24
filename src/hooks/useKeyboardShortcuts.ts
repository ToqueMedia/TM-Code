// src/hooks/useKeyboardShortcuts.ts
import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore, matchesBinding } from '../stores/settingsStore';
import { useEditorRepository } from '../stores/editorStore';
import MonacoBridge from '../utils/monacoBridge';

export function useKeyboardShortcuts() {
  const { currentProject } = useProjectStore();

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const sc = useSettingsStore.getState().shortcuts

      // Skip shortcuts when user is typing in an input (except Escape and modifier combos)
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      const isTyping = tag === 'input' || tag === 'select' || (tag === 'textarea' && !(e.metaKey || e.ctrlKey))
      if (isTyping && !['Escape'].includes(e.key)) return

      // Go to Symbol: Cmd+Shift+O — disabled (Monaco QuickPick freezes in Tauri WebView)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        if (MonacoBridge.getInstance().getCurrentEditor()) { e.preventDefault(); return; }
      }

      if (currentProject && matchesBinding(e, sc.toggleTerminal)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('panel:toggle-bottom'));
        return;
      }

      // Open File: Cmd+Shift+O (open file dialog)
      if (matchesBinding(e, sc.openFile)) {
        e.preventDefault();
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ directory: true, multiple: false, title: 'Select project directory' });
          if (selected) {
            const { useProjectStore } = await import('../stores/projectStore');
            await useProjectStore.getState().openProject(selected as string);
          }
        } catch { /* user cancelled */ }
        return;
      }

      // New Project: Cmd+N / Ctrl+N
      if (matchesBinding(e, sc.newProject)) {
        e.preventDefault();
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ directory: true, title: 'Choose folder' });
          if (selected) {
            const { useProjectStore } = await import('../stores/projectStore');
            await useProjectStore.getState().openProject(selected as string, { initGit: true });
          }
        } catch { /* user cancelled */ }
        return;
      }

      if (currentProject && matchesBinding(e, sc.closeFile)) {
        e.preventDefault();
        try {
          const { activeFile, closeFile } = useEditorRepository.getState();
          if (activeFile) {
            closeFile(activeFile);
            return;
          }
        } catch {}
        useProjectStore.getState().closeProject();
        return;
      }

      if (matchesBinding(e, sc.quickOpen)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('quickopen:toggle'));
        return;
      }

      if (matchesBinding(e, sc.commandPalette)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('command:palette'));
        return;
      }

      if (matchesBinding(e, sc.settings)) {
        e.preventDefault();
        const layout = useLayoutStore.getState();
        if (layout.viewMode === 'settings') {
          layout.goBack();
        } else {
          layout.setViewMode('settings');
        }
        return;
      }

      if (currentProject && matchesBinding(e, sc.splitEditor)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('editor:split'));
        return;
      }

      if (currentProject && matchesBinding(e, sc.toggleSidebar)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('sidebar:toggle'));
        return;
      }

      if (matchesBinding(e, sc.goToLine) && MonacoBridge.getInstance().getCurrentEditor()) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('editor:go-to-line'));
        return;
      }

      if (currentProject && matchesBinding(e, sc.searchInProject)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('search:open'));
        return;
      }

      // Debugger shortcuts (F-keys, not customizable via settings)
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
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('debugger:open'));
          return;
        }
      }

      // === Diff approval shortcuts (only when diffs are pending, prompt not focused, no dialogs open) ===
      const activeEl = document.activeElement
      const isPromptFocused = activeEl?.tagName === 'TEXTAREA'
      const isInputFocused = activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'SELECT'
      const hasDialogOpen = !!document.querySelector('[role="dialog"], [data-command-palette]')
      const hasPendingDiffs = useChatStore.getState().pendingDiffs.length > 0

      if (hasPendingDiffs && !isPromptFocused && !isInputFocused && !hasDialogOpen) {
        if (matchesBinding(e, sc.diffAccept)) {
          e.preventDefault()
          const state = useChatStore.getState()
          const session = state.getActiveSession()
          if (session) {
            for (const msg of session.messages) {
              const tc = msg.toolCalls?.find(t => t.diffStatus === 'pending')
              if (tc) {
                state.approveDiff(msg.id, tc.id, tc.diffResultId)
                break
              }
            }
          }
          return
        }

        if (matchesBinding(e, sc.diffAcceptAll)) {
          e.preventDefault()
          useChatStore.getState().approveAllPendingDiffs()
          return
        }

        if (matchesBinding(e, sc.diffReject)) {
          e.preventDefault()
          const state = useChatStore.getState()
          const session = state.getActiveSession()
          if (session) {
            for (const msg of session.messages) {
              const tc = msg.toolCalls?.find(t => t.diffStatus === 'pending')
              if (tc) {
                state.rejectDiff(msg.id, tc.id, tc.diffResultId)
                break
              }
            }
          }
          return
        }

        if (matchesBinding(e, sc.diffRejectAll)) {
          e.preventDefault()
          useChatStore.getState().rejectAllAndStop()
          return
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  // Only re-register on project change — function refs are stable via useRef
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject]);
}
