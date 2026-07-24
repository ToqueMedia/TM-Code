import {
  PROJECT_AGENT_STATUS_POLL_FOCUSED_MS,
  PROJECT_AGENT_STATUS_POLL_MS,
  projectAgentStatusPollIntervalMs,
} from '../projectAgentStatusPoll'

describe('projectAgentStatusPoll', () => {
  it('focused poll is faster than background and ≤ writer focused heartbeat (3s)', () => {
    expect(PROJECT_AGENT_STATUS_POLL_FOCUSED_MS).toBe(1_500)
    expect(PROJECT_AGENT_STATUS_POLL_MS).toBe(3_000)
    expect(PROJECT_AGENT_STATUS_POLL_FOCUSED_MS).toBeLessThan(PROJECT_AGENT_STATUS_POLL_MS)
    expect(PROJECT_AGENT_STATUS_POLL_FOCUSED_MS).toBeLessThanOrEqual(3_000)
  })

  it('projectAgentStatusPollIntervalMs switches on visibility', () => {
    expect(projectAgentStatusPollIntervalMs('visible')).toBe(PROJECT_AGENT_STATUS_POLL_FOCUSED_MS)
    expect(projectAgentStatusPollIntervalMs('hidden')).toBe(PROJECT_AGENT_STATUS_POLL_MS)
    // Explicit non-visible states use background cadence
    expect(projectAgentStatusPollIntervalMs('prerender')).toBe(PROJECT_AGENT_STATUS_POLL_MS)
  })
})
