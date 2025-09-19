import { create } from 'zustand';

interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  isActive: boolean;
  processId?: number;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSectionId: string | null;
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
  activeSectionId: null,
  isVisible: true,

  // Ações
  createSession: async (name?: string, cwd?: string) => {
    const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const sessionName = name || `Terminal ${get().sessions.length + 1}`;
    const workingDir = cwd || process.env.HOME || '/';

    const newSession: TerminalSession = {
      id: sessionId,
      name: sessionName,
      cwd: workingDir,
      isActive: true,
    };

    set(state => ({
      sessions: [...state.sessions, newSession],
      activeSectionId: sessionId,
    }));

    return sessionId;
  },

  removeSession: async (sessionId: string) => {
    const { sessions, activeSectionId } = get();
    const updatedSessions = sessions.filter(session => session.id !== sessionId);
    
    let newActiveId = activeSectionId;
    if (activeSectionId === sessionId) {
      newActiveId = updatedSessions.length > 0 ? updatedSessions[0].id : null;
    }

    set({
      sessions: updatedSessions,
      activeSectionId: newActiveId,
    });
  },

  setActiveSession: (sessionId: string) => {
    const { sessions } = get();
    const sessionExists = sessions.some(session => session.id === sessionId);
    
    if (sessionExists) {
      set({
        activeSectionId: sessionId,
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
      activeSectionId: null,
    });
  },
}));

export default useTerminalStore;