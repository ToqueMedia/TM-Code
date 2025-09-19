import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  isActive: boolean;
  processId?: number;
  createdAt: number;
  lastActivity: number;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSectionId: string | null;
  isVisible: boolean;
  isCreating: boolean; // 🔒 Previne criação simultânea de sessões
}

interface TerminalActions {
  createSession: (name?: string, cwd?: string) => Promise<string>;
  removeSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
  updateSessionActivity: (sessionId: string) => void;
  toggleVisibility: () => void;
  setVisibility: (visible: boolean) => void;
  clearSessions: () => void;
  getSession: (sessionId: string) => TerminalSession | undefined;
}

export const useTerminalStoreV2 = create<TerminalState & TerminalActions>()(
  subscribeWithSelector((set, get) => ({
    // Estado inicial
    sessions: [],
    activeSectionId: null,
    isVisible: true,
    isCreating: false,

    // 🚀 Ações otimizadas
    createSession: async (name?: string, cwd?: string) => {
      // 🔒 Previne criação simultânea
      if (get().isCreating) {
        console.warn('Session creation already in progress');
        return '';
      }

      set({ isCreating: true });

      try {
        const timestamp = Date.now();
        const sessionId = `terminal-${timestamp}-${Math.random().toString(36).substr(2, 9)}`;
        const sessionName = name || `Terminal ${get().sessions.length + 1}`;
        
        // Get working directory from Tauri backend if not provided
        let workingDir = cwd;
        if (!workingDir) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            workingDir = await invoke('get_current_directory') as string;
          } catch (error) {
            console.warn('Failed to get current directory from Tauri, using fallback');
            workingDir = '/'; // Fallback for Unix-like systems
          }
        }

        const newSession: TerminalSession = {
          id: sessionId,
          name: sessionName,
          cwd: workingDir,
          isActive: true,
          createdAt: timestamp,
          lastActivity: timestamp,
        };

        set(state => ({
          sessions: [...state.sessions, newSession],
          activeSectionId: sessionId,
          isCreating: false,
        }));

        return sessionId;
      } catch (error) {
        console.error('Failed to create terminal session:', error);
        set({ isCreating: false });
        throw error;
      }
    },

    removeSession: async (sessionId: string) => {
      const { sessions, activeSectionId } = get();
      
      // Não permitir remover a última sessão
      if (sessions.length <= 1) {
        console.warn('Cannot remove the last terminal session');
        return;
      }

      const updatedSessions = sessions.filter(session => session.id !== sessionId);
      
      let newActiveId = activeSectionId;
      if (activeSectionId === sessionId) {
        // Priorizar a sessão mais recente ou a primeira disponível
        const sortedSessions = updatedSessions.sort((a, b) => b.lastActivity - a.lastActivity);
        newActiveId = sortedSessions[0]?.id || null;
      }

      set({
        sessions: updatedSessions,
        activeSectionId: newActiveId,
      });
    },

    setActiveSession: (sessionId: string) => {
      const { sessions } = get();
      const session = sessions.find(s => s.id === sessionId);
      
      if (session) {
        set(state => ({
          activeSectionId: sessionId,
          sessions: state.sessions.map(s => 
            s.id === sessionId 
              ? { ...s, lastActivity: Date.now() }
              : s
          ),
        }));
      }
    },

    updateSessionCwd: (sessionId: string, cwd: string) => {
      set(state => ({
        sessions: state.sessions.map(session => 
          session.id === sessionId 
            ? { ...session, cwd, lastActivity: Date.now() }
            : session
        ),
      }));
    },

    updateSessionActivity: (sessionId: string) => {
      set(state => ({
        sessions: state.sessions.map(session => 
          session.id === sessionId 
            ? { ...session, lastActivity: Date.now() }
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

    getSession: (sessionId: string) => {
      return get().sessions.find(session => session.id === sessionId);
    },
  }))
);

// 🎯 Seletores otimizados para evitar re-renders desnecessários
export const useTerminalSessions = () => useTerminalStoreV2(state => state.sessions);
export const useActiveTerminalSession = () => {
  const activeSectionId = useTerminalStoreV2(state => state.activeSectionId);
  const sessions = useTerminalStoreV2(state => state.sessions);
  return sessions.find(s => s.id === activeSectionId);
};
export const useTerminalSession = (sessionId: string) => 
  useTerminalStoreV2(state => state.sessions.find(s => s.id === sessionId));

// 🚀 Actions separadas para melhor performance
export const useTerminalActions = () => useTerminalStoreV2(state => ({
  createSession: state.createSession,
  removeSession: state.removeSession,
  setActiveSession: state.setActiveSession,
  updateSessionCwd: state.updateSessionCwd,
  updateSessionActivity: state.updateSessionActivity,
  toggleVisibility: state.toggleVisibility,
  setVisibility: state.setVisibility,
  clearSessions: state.clearSessions,
}));

export default useTerminalStoreV2;