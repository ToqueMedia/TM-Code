import { useCelebrationStore, triggerGoalCelebration } from '@/stores/celebrationStore'

describe('celebrationStore', () => {
  beforeEach(() => {
    useCelebrationStore.setState({ goalToken: 0, lastReason: null })
  })

  it('celebrateGoal increments the token and records the reason', () => {
    useCelebrationStore.getState().celebrateGoal('welcome_kickoff')
    expect(useCelebrationStore.getState().goalToken).toBe(1)
    expect(useCelebrationStore.getState().lastReason).toBe('welcome_kickoff')
  })

  it('is monotonic across back-to-back goals (no coalescing)', () => {
    const { celebrateGoal } = useCelebrationStore.getState()
    celebrateGoal()
    celebrateGoal()
    celebrateGoal()
    expect(useCelebrationStore.getState().goalToken).toBe(3)
  })

  it('triggerGoalCelebration fires while the feature is enabled', () => {
    triggerGoalCelebration('agent_run_complete')
    expect(useCelebrationStore.getState().goalToken).toBe(1)
    expect(useCelebrationStore.getState().lastReason).toBe('agent_run_complete')
  })
})

describe('triggerGoalCelebration with the kill switch off', () => {
  afterEach(() => {
    jest.dontMock('@/utils/worldCup')
    jest.resetModules()
  })

  it('is a no-op when FOOTBALL_MODE_ENABLED is false', () => {
    jest.isolateModules(() => {
      jest.doMock('@/utils/worldCup', () => ({ FOOTBALL_MODE_ENABLED: false }))
      // Re-require so the store module binds the mocked flag.
      const mod = require('@/stores/celebrationStore') as typeof import('@/stores/celebrationStore')
      mod.useCelebrationStore.setState({ goalToken: 0, lastReason: null })
      mod.triggerGoalCelebration('agent_run_complete')
      expect(mod.useCelebrationStore.getState().goalToken).toBe(0)
      expect(mod.useCelebrationStore.getState().lastReason).toBeNull()
    })
  })
})
