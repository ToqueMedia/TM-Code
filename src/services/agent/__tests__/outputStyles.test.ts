import {
  AGENT_OUTPUT_STYLES,
  DEFAULT_AGENT_OUTPUT_STYLE,
  getOutputStyleSection,
  getOutputStyleSectionForPlan,
  isAgentOutputStyle,
} from '../outputStyles'

describe('outputStyles', () => {
  it('default is collaborator', () => {
    expect(DEFAULT_AGENT_OUTPUT_STYLE).toBe('collaborator')
    expect(isAgentOutputStyle('collaborator')).toBe(true)
    expect(isAgentOutputStyle('verbose')).toBe(false)
  })

  it('cada estilo injecta o seu cabeçalho e nenhum substitui as instruções de código', () => {
    for (const style of AGENT_OUTPUT_STYLES) {
      const section = getOutputStyleSection(style)
      expect(section.startsWith('# Output style:')).toBe(true)
      expect(section.toLowerCase()).not.toContain('ignore previous')
    }
  })

  it('learning pede contribuição; concise não entrevista por pastas', () => {
    expect(getOutputStyleSection('learning')).toContain('ask_user_question')
    expect(getOutputStyleSection('learning')).toContain('blocks this turn')
    expect(getOutputStyleSection('learning')).toContain('do not add an Other option yourself')
    expect(getOutputStyleSection('concise')).toContain('Do not skip')
    expect(getOutputStyleSection('collaborator')).toContain('pair-programming partner')
  })

  it('no /plan o estilo Learning não pede código-fonte', () => {
    const plan = getOutputStyleSectionForPlan('learning')
    expect(plan).toContain('PLAN.md only')
    expect(plan).not.toContain('hand the keyboard back')
    expect(getOutputStyleSectionForPlan('collaborator')).toContain('pair-programming partner')
  })
})
