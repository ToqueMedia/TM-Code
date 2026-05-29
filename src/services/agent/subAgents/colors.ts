/**
 * Agent color palette for SubAgentCard UI accents.
 *
 * Port of claude-vaz's agentColorManager palette, narrowed to the three
 * built-in sub-agent types.
 */

export const AGENT_COLORS: Record<string, string> = {
  Explore: '#3fb8af',   // cyan — codebase search
  Research: '#a371f7',  // purple — web research
  Verify: '#f77f00',    // orange — adversarial verification
}

export function getAgentColor(agentType: string): string {
  return AGENT_COLORS[agentType] ?? '#8b949e'
}
