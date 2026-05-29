import { buildMemoryGuidanceSection } from '../memoryGuidance'
import { getMemoryToolsGuidanceSection } from '../contextBuilder/sections/chatSections'
import { getCmdMemoryToolsGuidanceSection } from '../contextBuilder/sections/cmdSections'

describe('buildMemoryGuidanceSection', () => {
  const guidance = buildMemoryGuidanceSection()

  it('opens with the persistent memory header', () => {
    expect(guidance).toContain('# Persistent memory')
    expect(guidance).toContain('save_memory')
    expect(guidance).toContain('forget_memory')
    expect(guidance).toContain('read_memory')
  })

  it('contains all four memory types in the <types> block', () => {
    expect(guidance).toContain('<types>')
    expect(guidance).toContain('</types>')
    expect(guidance).toContain('<name>user</name>')
    expect(guidance).toContain('<name>feedback</name>')
    expect(guidance).toContain('<name>project</name>')
    expect(guidance).toContain('<name>reference</name>')
  })

  it('includes the What NOT to save section', () => {
    expect(guidance).toContain('## What NOT to save')
    expect(guidance).toContain('Code patterns, conventions, architecture')
    expect(guidance).toContain('Git history, recent changes')
    expect(guidance).toContain('CLAUDE.md or TMS.md')
  })

  it('includes the When to access memories section', () => {
    expect(guidance).toContain('## When to access memories')
    expect(guidance).toContain('read_memory(name, type)')
  })

  it('includes the Before recommending from memory section', () => {
    expect(guidance).toContain('## Before recommending from memory')
    expect(guidance).toContain('"The memory says X exists" is not the same as "X exists now."')
  })

  it('includes body_structure guidance for feedback type', () => {
    expect(guidance).toContain('**Why:**')
    expect(guidance).toContain('**How to apply:**')
  })

  it('includes concrete examples for each type', () => {
    // user
    expect(guidance).toContain('data scientist')
    // feedback
    expect(guidance).toContain('no-trailing-summaries')
    // project
    expect(guidance).toContain('auth-rewrite-driver')
    // reference
    expect(guidance).toContain('oncall-latency-dashboard')
  })

  it('warns about stale memories', () => {
    expect(guidance).toContain('may have been renamed, removed, or never merged')
    expect(guidance).toContain('"The memory says X exists" is not the same as "X exists now."')
  })
})

describe('chat/CMD guidance parity', () => {
  it('getMemoryToolsGuidanceSection returns the same content as buildMemoryGuidanceSection', () => {
    expect(getMemoryToolsGuidanceSection()).toBe(buildMemoryGuidanceSection())
  })

  it('getCmdMemoryToolsGuidanceSection returns the same content as buildMemoryGuidanceSection', () => {
    expect(getCmdMemoryToolsGuidanceSection()).toBe(buildMemoryGuidanceSection())
  })

  it('chat and CMD guidance are identical', () => {
    expect(getMemoryToolsGuidanceSection()).toBe(getCmdMemoryToolsGuidanceSection())
  })
})
