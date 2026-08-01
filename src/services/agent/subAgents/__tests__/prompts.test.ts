/**
 * Snapshot tests for built-in sub-agent system prompts.
 *
 * Verifies each agent's prompt contains all required sections and
 * produces correct output for both project and cwd-scoped contexts.
 */

import { EXPLORE_AGENT } from '../exploreAgent'
import { RESEARCH_AGENT } from '../researchAgent'
import { VERIFY_AGENT } from '../verifyAgent'
import { BUILT_IN_AGENTS, getAgentDefinition } from '../builtInAgents'
import type { SubAgentParentContext } from '../types'
import {
  GREP_ALIAS, GLOB_ALIAS, READ_ALIAS, LS_ALIAS,
  WEB_SEARCH_ALIAS, WEB_FETCH_ALIAS, BASH_ALIAS,
} from '../../toolNames'

const LEGACY_MODE_LABEL = ['Terminal', 'Mode'].join(' ')

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
    // DOIS dialectos: o prompt nomeia as tools como o modelo as vê (alias de
    // treino); `EXPLORE_AGENT.tools` é a allow-list interna, em canónico.
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain(GREP_ALIAS)
    expect(prompt).toContain(GLOB_ALIAS)
    expect(prompt).toContain(READ_ALIAS)
    expect(prompt).toContain(LS_ALIAS)
    expect(prompt).toContain('read_around')
    expect(prompt).toContain('read_large_result')
    expect(EXPLORE_AGENT.tools).toContain('read_large_result')
    expect(EXPLORE_AGENT.tools).toContain('search_files')
  })

  it('includes project root', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('/home/user/my-project')
  })

  it('includes language directive', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('respond in en')
  })

  it('includes cwd guidance when cmdOnlyMode is true', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CMD_CTX)
    expect(prompt).toContain('CWD is the working directory for tool calls')
    expect(prompt).not.toContain(LEGACY_MODE_LABEL)
  })

  it('does NOT mention the legacy mode label when cmdOnlyMode is false', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).not.toContain(LEGACY_MODE_LABEL)
  })
})

describe('Research agent prompt', () => {
  it('includes web research tools', () => {
    // DOIS dialectos: o prompt nomeia as tools como o modelo as vê (alias de
    // treino); `RESEARCH_AGENT.tools` é a allow-list interna, em canónico.
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain(WEB_SEARCH_ALIAS)
    expect(prompt).toContain(WEB_FETCH_ALIAS)
    expect(prompt).toContain(BASH_ALIAS)
    expect(prompt).toContain('read_skill')
    expect(prompt).toContain('read_around')
    expect(prompt).toContain('read_large_result')
    expect(RESEARCH_AGENT.tools).toContain('read_large_result')
    expect(RESEARCH_AGENT.tools).toContain('execute_command')
  })

  it('includes read-only rule', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('READ-ONLY')
  })

  it('includes typical flow section', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('Typical flow')
    expect(prompt).toContain(WEB_SEARCH_ALIAS)
  })

  it('does not treat a failed web fetch as final proof of inaccessibility', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('Fetch Failure Policy')
    expect(prompt).toContain('primary fetch failing')
    expect(prompt).toContain('curl -L -A Mozilla/5.0')
  })

  it('includes completion rule', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('Completion')
  })

  it('includes cwd guidance when cmdOnlyMode is true', () => {
    const prompt = RESEARCH_AGENT.getSystemPrompt(CMD_CTX)
    expect(prompt).toContain('CWD is the working directory for tool calls')
    expect(prompt).not.toContain(LEGACY_MODE_LABEL)
  })
})

describe('Verify agent prompt', () => {
  it('includes execute_command in tools', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('execute_command')
  })

  it('has supervised dev server tools for backend/API verification', () => {
    expect(VERIFY_AGENT.tools).toContain('start_dev_server')
    expect(VERIFY_AGENT.tools).toContain('stop_dev_server')
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).toContain('Use start_dev_server for dev servers')
    expect(prompt).toContain('Do not run npm/yarn/pnpm dev servers through execute_command')
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

  it('does NOT mention the legacy mode label when cmdOnlyMode is false', () => {
    const prompt = VERIFY_AGENT.getSystemPrompt(CHAT_CTX)
    expect(prompt).not.toContain(LEGACY_MODE_LABEL)
  })
})
