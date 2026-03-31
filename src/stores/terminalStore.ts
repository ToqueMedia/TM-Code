import { create } from 'zustand';
import { isProjectIsolated, getContainerProjectPath } from './containerStore';

interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  isActive: boolean;
  processId?: number;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  isVisible: boolean;
}

interface TerminalActions {
  createSession: (name?: string, cwd?: string) => Promise<string>;
  removeSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
  toggleVisibility: () => void;
  setVisibility: (visible: boolean) => void;
  clearSessions: () => void;
}

export const useTerminalStore = create<TerminalState & TerminalActions>((set, get) => ({
  // Estado inicial
  sessions: [],
  activeSessionId: null,
  isVisible: true,

  // Ações
  createSession: async (name?: string, cwd?: string) => {
    const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const sessionName = name || `Terminal ${get().sessions.length + 1}`;
    
    // Determine working directory:
    // 1. Use explicit cwd if provided
    // 2. In container mode, use the project path (maps to /workspace in container)
    // 3. Fall back to Tauri current directory
    let workingDir = cwd;
    if (!workingDir) {
      const projectPath = getContainerProjectPath();
      if (isProjectIsolated() && projectPath) {
        workingDir = projectPath;
      } else {
        // Use project path if available, otherwise user's home directory
        const project = (await import('./projectStore')).useProjectStore.getState().currentProject
        if (project?.path) {
          workingDir = project.path
        } else {
          try {
            const { homeDir } = await import('@tauri-apps/api/path')
            workingDir = await homeDir()
          } catch {
            workingDir = '/'
          }
        }
      }
    }

    const newSession: TerminalSession = {
      id: sessionId,
      name: sessionName,
      cwd: workingDir,
      isActive: true,
    };

    set(state => ({
      sessions: [...state.sessions, newSession],
      activeSessionId: sessionId,
    }));

    return sessionId;
  },

  removeSession: async (sessionId: string) => {
    const { sessions, activeSessionId } = get();
    const updatedSessions = sessions.filter(session => session.id !== sessionId);
    
    let newActiveId = activeSessionId;
    if (activeSessionId === sessionId) {
      newActiveId = updatedSessions.length > 0 ? updatedSessions[0].id : null;
    }

    set({
      sessions: updatedSessions,
      activeSessionId: newActiveId,
    });
  },

  setActiveSession: (sessionId: string) => {
    const { sessions } = get();
    const sessionExists = sessions.some(session => session.id === sessionId);
    
    if (sessionExists) {
      set({
        activeSessionId: sessionId,
      });
    }
  },

  renameSession: (sessionId: string, name: string) => {
    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId
          ? { ...session, name }
          : session
      ),
    }));
  },

  updateSessionCwd: (sessionId: string, cwd: string) => {
    set(state => ({
      sessions: state.sessions.map(session => 
        session.id === sessionId 
          ? { ...session, cwd }
          : session
      ),
    }));
  },

  toggleVisibility: () => {
    set(state => ({
      isVisible: !state.isVisible,
    }));
  },

  setVisibility: (visible: boolean) => {
    set({
      isVisible: visible,
    });
  },

  clearSessions: () => {
    // Kill all running processes before clearing
    const { sessions } = get();
    for (const session of sessions) {
      if (session.processId) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('kill_process', { pid: session.processId }).catch(() => {});
        }).catch(() => {});
      }
    }
    set({
      sessions: [],
      activeSessionId: null,
    });
  },
}));

export default useTerminalStore;