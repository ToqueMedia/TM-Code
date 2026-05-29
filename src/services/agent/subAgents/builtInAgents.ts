/**
 * Built-in sub-agent definitions.
 *
 * Single entry point for the tool executor and context builder.
 */

import type { SubAgentDefinition, SubAgentType } from './types'
import { EXPLORE_AGENT } from './exploreAgent'
import { RESEARCH_AGENT } from './researchAgent'
import { VERIFY_AGENT } from './verifyAgent'

export const BUILT_IN_AGENTS: SubAgentDefinition[] = [
  EXPLORE_AGENT,
  RESEARCH_AGENT,
  VERIFY_AGENT,
]

const AGENT_MAP = new Map<SubAgentType, SubAgentDefinition>(
  BUILT_IN_AGENTS.map(a => [a.agentType, a])
)

export function getAgentDefinition(type: SubAgentType): SubAgentDefinition | undefined {
  return AGENT_MAP.get(type)
}

export { EXPLORE_AGENT, RESEARCH_AGENT, VERIFY_AGENT }
