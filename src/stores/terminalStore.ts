import { create } from 'zustand';
import { logger } from '../utils/logger';

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
    
    // Get working directory from Tauri backend if not provided
    let workingDir = cwd;
    if (!workingDir) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        workingDir = await invoke('get_current_directory') as string;
      } catch (error) {
        logger.warn('terminal', 'Failed to get current directory from Tauri, using fallback');
        workingDir = '/'; // Fallback for Unix-like systems
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
    set({
      sessions: [],
      activeSessionId: null,
    });
  },
}));

export default useTerminalStore;