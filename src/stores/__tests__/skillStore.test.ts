import { useSkillStore } from '../skillStore'
import type { Skill } from '../../services/agent/skillService'

function resetStore() {
  useSkillStore.setState({
    skills: [],
    isLoading: false,
    error: null,
  })
}

const mockSkill = (name: string, scope: Skill['scope'] = 'bundled'): Skill => ({
  id: `${scope}:${name}`,
  name,
  description: `Mock skill: ${name}`,
  path: `/path/${name}`,
  content: `# ${name}`,
  references: [],
  scope,
})

describe('skillStore', () => {
  beforeEach(resetStore)

  describe('setSkills', () => {
    it('sets skills and clears loading/error', () => {
      useSkillStore.getState().setLoading(true)
      useSkillStore.getState().setError('old error')

      const skills = [mockSkill('react-patterns'), mockSkill('general-coding')]
      useSkillStore.getState().setSkills(skills)

      const state = useSkillStore.getState()
      expect(state.skills).toHaveLength(2)
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })
  })

  describe('setLoading', () => {
    it('toggles loading state', () => {
      useSkillStore.getState().setLoading(true)
      expect(useSkillStore.getState().isLoading).toBe(true)

      useSkillStore.getState().setLoading(false)
      expect(useSkillStore.getState().isLoading).toBe(false)
    })
  })

  describe('setError', () => {
    it('sets error and clears loading', () => {
      useSkillStore.getState().setLoading(true)
      useSkillStore.getState().setError('something failed')

      const state = useSkillStore.getState()
      expect(state.error).toBe('something failed')
      expect(state.isLoading).toBe(false)
    })
  })

  describe('reset', () => {
    it('clears everything', () => {
      useSkillStore.getState().setSkills([mockSkill('test')])
      useSkillStore.getState().setLoading(true)

      useSkillStore.getState().reset()

      const state = useSkillStore.getState()
      expect(state.skills).toEqual([])
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })
  })
})
