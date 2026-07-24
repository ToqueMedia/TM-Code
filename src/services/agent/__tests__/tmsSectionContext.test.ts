import {
  buildTmsSectionContext,
  extractTmsSection,
  isTmsSectionContextId,
  tmsSectionContextKeyFromId,
} from '../contextBuilder/tmsSectionContext'

describe('tmsSectionContext', () => {
  const tms = [
    '# TMS.md',
    '',
    '## Overview',
    'TM Code desktop IDE.',
    '',
    '## Commands',
    '- `yarn test`: run Jest.',
    '- `yarn build`: type-check and build.',
    '',
    '## Agent Rules',
    '- Read exact ranges before editing.',
    '',
    '## Pending Confirmation',
    '- Confirm release signing flow.',
  ].join('\n')

  it('extracts one top-level TMS section without swallowing the next one', () => {
    expect(extractTmsSection(tms, 'commands')).toBe([
      '- `yarn test`: run Jest.',
      '- `yarn build`: type-check and build.',
    ].join('\n'))
  })

  it('builds a small context block for a specific section', () => {
    const context = buildTmsSectionContext(tms, 'agent_rules')
    expect(context).toContain('# TMS.md: Agent Rules')
    expect(context).toContain('- Read exact ranges before editing.')
    expect(context).toContain('Verify exact code ranges with Read')
    expect(context).not.toContain('Confirm release signing flow')
  })

  it('parses well-formed tms.* section ids (legacy id shape; not request_context auxiliaries)', () => {
    expect(isTmsSectionContextId('tms.commands')).toBe(true)
    expect(tmsSectionContextKeyFromId('tms.pending_confirmation')).toBe('pending_confirmation')
    expect(isTmsSectionContextId('tms.unknown')).toBe(false)
  })
})

