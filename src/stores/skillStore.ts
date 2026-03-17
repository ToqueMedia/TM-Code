import { create } from 'zustand'
import type { Skill } from '../services/agent/skillService'

interface SkillState {
  skills: Skill[]
  isLoading: boolean
  error: string | null
}

interface SkillActions {
  setSkills: (skills: Skill[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const useSkillStore = create<SkillState & SkillActions>()((set) => ({
  skills: [],
  isLoading: false,
  error: null,

  setSkills: (skills: Skill[]) => set({ skills, isLoading: false, error: null }),
  setLoading: (isLoading: boolean) => set({ isLoading }),
  setError: (error: string | null) => set({ error, isLoading: false }),
  reset: () => set({ skills: [], isLoading: false, error: null }),
}))
