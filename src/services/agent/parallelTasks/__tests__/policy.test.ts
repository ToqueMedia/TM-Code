import {
  ONE_AGENT_PER_PROJECT,
  ONE_AGENT_PER_PROJECT_TOOL_ERROR,
  assertOneAgentPolicyActive,
} from '../policy'

describe('parallelTasks/policy (F3)', () => {
  it('keeps ONE_AGENT_PER_PROJECT enabled (Current parallel model)', () => {
    expect(ONE_AGENT_PER_PROJECT).toBe(true)
    expect(() => assertOneAgentPolicyActive()).not.toThrow()
  })

  it('exposes a stable tool error string for send_agent_message', () => {
    expect(ONE_AGENT_PER_PROJECT_TOOL_ERROR.toLowerCase()).toContain('one agent')
  })
})
