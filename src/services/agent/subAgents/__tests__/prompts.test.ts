/**
 * Snapshot tests for built-in sub-agent system prompts.
 *
 * Verifies each agent's prompt contains all required sections and
 * produces correct output for both chat-mode and cmd-mode contexts.
 */

import { EXPLORE_AGENT } from '../exploreAgent'
import { RESEARCH_AGENT } from '../researchAgent'
import { VERIFY_AGENT } from '../verifyAgent'
import { BUILT_IN_AGENTS, getAgentDefinition } from '../builtInAgents'
import type { SubAgentParentContext } from '../types'

const CHAT_CTX: SubAgentParentContext = {
  cmdOnlyMode: false,
  workingPath: '/home/user/my-project',
  agentLanguage: 'en',
  thoroughness: 'medium',
}

const CMD_CTX: SubAgentParentContext = {
  cmdOnlyMode: true,
  workingPath: '/home/user/my-project',
  agentLanguage: 'en',
  thoroughness: 'medium',
}

describe('Sub-agent definitions', () => {
  it('exports exactly 3 built-in agents', () => {
    expect(BUILT_IN_AGENTS).toHaveLength(3)
  })

  it('getAgentDefinition resolves each type', () => {
    expect(getAgentDefinition('Explore')).toBe(EXPLORE_AGENT)
    expect(getAgentDefinition('Research')).toBe(RESEARCH_AGENT)
    expect(getAgentDefinition('Verify')).toBe(VERIFY_AGENT)
  })

  it('getAgentDefinition returns undefined for unknown type', () => {
    // @ts-expect-error — testing invalid input
    expect(getAgentDefinition('Unknown')).toBeUndefined()
  })

  it('each agent has a unique agentType', () => {
    const types = BUILT_IN_AGENTS.map(a => a.agentType)
    expect(new Set(types).size).toBe(types.length)
  })

  it('each agent has a non-empty tools list', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(agent.tools.length).toBeGreaterThan(0)
    }
  })

  it('each agent has maxTurns > 0 and maxWallClockMs > 0', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(agent.maxTurns).toBeGreaterThan(0)
      expect(agent.maxWallClockMs).toBeGreaterThan(0)
    }
  })

  it('each agent has a hex color', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(agent.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('Explore agent prompt', () => {
  it('includes read-only rule', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('READ-ONLY')
  })

  it('includes all allowed tools', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('search_files')
    expect(prompt).toContain('glob')
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('list_directory')
    expect(prompt).toContain('get_diagnostics')
  })

  it('includes project root', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('/home/user/my-project')
  })

  it('includes language directive', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('respond in en')
  })

  it('includes Terminal Mode line when cmdOnlyMode is true', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CMD_CTX)
    expect(prompt).toContain('Terminal Mode')
  })

  it('does NOT include Terminal Mode line when cmdOnlyMode is false', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).not.toContain('Terminal Mode')
  })
})

describe('Research agent prompt', () => {
  it('includes web research tools', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('web_search')
    expect(prompt).toContain('web_fetch')
    expect(prompt).toContain('read_skill')
  })

  it('includes read-only rule', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('READ-ONLY')
  })

  it('includes typical flow section', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('Typical flow')
    expect(prompt).toContain('web_search')
  })

  it('includes completion rule', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('Completion')
  })

  it('includes Terminal Mode line when cmdOnlyMode is true', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CMD_CTX)
    expect(prompt).toContain('Terminal Mode')
  })
})

describe('Verify agent prompt', () => {
  it('includes execute_command in tools', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('execute_command')
  })

  it('includes read-only modification warning', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('CANNOT create, modify, or delete')
  })

  it('includes VERDICT format', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('VERDICT: PASS')
    expect(prompt).toContain('VERDICT: FAIL')
    expect(prompt).toContain('VERDICT: PARTIAL')
  })

  it('includes required steps', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('build')
    expect(prompt).toContain('test suite')
  })

  it('includes rationalization detection', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('RATIONALIZATIONS')
    expect(prompt).toContain('code looks correct')
  })

  it('includes disallowed tools', () => {
    expect(VERIFY_AGENT.disallowedTools).toBeDefined()
    expect(VERIFY_AGENT.disallowedTools).toContain('write_file')
    expect(VERIFY_AGENT.disallowedTools).toContain('edit_file')
  })

  it('does NOT include Terminal Mode line when cmdOnlyMode is false', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).not.toContain('Terminal Mode')
  })
})
