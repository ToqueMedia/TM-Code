import { create } from 'zustand'

export type AiCompletionStatus = 'idle' | 'loading' | 'error'

interface AiCompletionState {
  status: AiCompletionStatus
  setStatus: (status: AiCompletionStatus) => void
}

export const useAiCompletionStore = create<AiCompletionState>((set) => ({
  status: 'idle',
  setStatus: (status) => set({ status }),
}))
