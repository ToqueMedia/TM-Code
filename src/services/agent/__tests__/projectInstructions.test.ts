/**
 * Compat loader for project instructions (TMS.md + AGENTS.md / CLAUDE.md).
 */
import {
  loadProjectInstructions,
  buildInstructionsDocsFullPart,
  buildParallelTaskInstructionsBody,
  extractInstructionHeadings,
  truncateNamed,
  FOREIGN_DOCS_FULL_MAX_CHARS,
  type InstructionSource,
} from '../projectInstructions'
import { getProjectMemorySection } from '../contextBuilder/sections/chatSections'
import type { PromptContext } from '../contextBuilder/types'


jest.mock('../contextBuilder/projectUtils', () => ({
  safeReadFile: jest.fn(),
}))

import { safeReadFile } from '../contextBuilder/projectUtils'

const mockRead = safeReadFile as jest.MockedFunction<typeof safeReadFile>

function fileMap(map: Record<string, string | null>): void {
  mockRead.mockImplementation(async (path: string) => {
    const normalized = path.replace(/\\/g, '/')
    for (const [rel, body] of Object.entries(map)) {
      if (normalized.endsWith(`/${rel}`) || normalized.endsWith(rel)) {
        return body
      }
    }
    return null
  })
}

describe('projectInstructions loader', () => {
  beforeEach(() => {
    mockRead.mockReset()
  })

  it('loads TMS only', async () => {
    fileMap({ 'TMS.md': '# TMS\n## Commands\nnpm test\n' })
    const bundle = await loadProjectInstructions('/proj')
    expect(bundle.tms?.content).toContain('## Commands')
    expect(bundle.foreignPrimary).toBeNull()
    expect(bundle.hasAny).toBe(true)
  })

  it('loads AGENTS.md as foreign when TMS is missing', async () => {
    fileMap({ 'AGENTS.md': '# Agents\n## Deploy\nrun deploy.ps1\n' })
    const bundle = await loadProjectInstructions('/proj')
    expect(bundle.tms).toBeNull()
    expect(bundle.foreignPrimary?.kind).toBe('agents')
    expect(bundle.foreignPrimary?.relPath).toBe('AGENTS.md')
    expect(bundle.foreignPrimary?.content).toContain('deploy.ps1')
  })

  it('prefers AGENTS.md over CLAUDE.md', async () => {
    fileMap({
      'AGENTS.md': 'from agents',
      'CLAUDE.md': 'from claude',
    })
    const bundle = await loadProjectInstructions('/proj')
    expect(bundle.foreignPrimary?.content).toBe('from agents')
  })

  it('falls back to CLAUDE.md then .claude/CLAUDE.md', async () => {
    fileMap({ 'CLAUDE.md': 'root claude' })
    let bundle = await loadProjectInstructions('/proj')
    expect(bundle.foreignPrimary?.relPath).toBe('CLAUDE.md')

    mockRead.mockReset()
    fileMap({ '.claude/CLAUDE.md': 'dot claude' })
    bundle = await loadProjectInstructions('/proj')
    expect(bundle.foreignPrimary?.relPath).toBe('.claude/CLAUDE.md')
  })

  it('discovers foreign even when TMS exists (dual-case)', async () => {
    fileMap({
      'TMS.md': '# TMS\n## Overview\nx\n',
      'AGENTS.md': '# Agents\nrules\n',
    })
    const bundle = await loadProjectInstructions('/proj')
    expect(bundle.tms).not.toBeNull()
    expect(bundle.foreignPrimary?.kind).toBe('agents')
  })

  it('returns empty when nothing exists', async () => {
    fileMap({})
    const bundle = await loadProjectInstructions('/proj')
    expect(bundle.hasAny).toBe(false)
    expect(bundle.tms).toBeNull()
    expect(bundle.foreignPrimary).toBeNull()
  })

  it('ignores empty/whitespace-only files', async () => {
    fileMap({ 'AGENTS.md': '   \n  ' })
    const bundle = await loadProjectInstructions('/proj')
    expect(bundle.foreignPrimary).toBeNull()
  })
})

describe('buildInstructionsDocsFullPart', () => {
  const tms: InstructionSource = {
    kind: 'tms',
    path: '/p/TMS.md',
    relPath: 'TMS.md',
    content: 'tms body',
  }
  const agents: InstructionSource = {
    kind: 'agents',
    path: '/p/AGENTS.md',
    relPath: 'AGENTS.md',
    content: 'agents body',
  }

  it('default omits TMS already in system (docs_full path)', () => {
    const out = buildInstructionsDocsFullPart(tms, null)
    expect(out).toBeNull()
  })

  it('default omits sole foreign already in system', () => {
    const out = buildInstructionsDocsFullPart(null, agents)
    expect(out).toBeNull()
  })

  it('TMS + foreign dual-case: only foreign (TMS already static)', () => {
    const out = buildInstructionsDocsFullPart(tms, agents)!
    expect(out).not.toContain('# TMS.md\ntms body')
    expect(out).toContain('Additional project instructions')
    expect(out).toContain('agents body')
  })

  it('explicit include: TMS only when omitTmsAlreadyInSystem false', () => {
    const out = buildInstructionsDocsFullPart(tms, null, { omitTmsAlreadyInSystem: false })!
    expect(out).toContain('# TMS.md')
    expect(out).toContain('tms body')
  })

  it('truncates large foreign body with named notice when included', () => {
    const huge: InstructionSource = {
      ...agents,
      content: 'x'.repeat(FOREIGN_DOCS_FULL_MAX_CHARS + 500),
    }
    const out = buildInstructionsDocsFullPart(null, huge, { omitForeignAlreadyInSystem: false })!
    expect(out).toContain('truncated AGENTS.md')
    expect(out.length).toBeLessThan(huge.content.length)
  })
})

describe('buildParallelTaskInstructionsBody', () => {
  it('uses TMS heading when TMS present', () => {
    const out = buildParallelTaskInstructionsBody({
      tms: { kind: 'tms', path: '/p/TMS.md', relPath: 'TMS.md', content: 'body' },
      foreignPrimary: {
        kind: 'agents',
        path: '/p/AGENTS.md',
        relPath: 'AGENTS.md',
        content: 'foreign',
      },
      hasAny: true,
    })
    expect(out?.heading).toContain('TMS.md')
    expect(out?.body).toBe('body')
  })

  it('uses foreign when no TMS', () => {
    const out = buildParallelTaskInstructionsBody({
      tms: null,
      foreignPrimary: {
        kind: 'claude',
        path: '/p/CLAUDE.md',
        relPath: 'CLAUDE.md',
        content: 'claude rules',
      },
      hasAny: true,
    })
    expect(out?.heading).toContain('CLAUDE.md')
    expect(out?.body).toContain('claude rules')
  })
})

describe('extractInstructionHeadings + truncateNamed', () => {
  it('extracts H1–H3 headings capped', () => {
    const md = ['# A', '## B', '### C', 'text', '## D'].join('\n')
    expect(extractInstructionHeadings(md)).toEqual(['# A', '## B', '### C', '## D'])
  })

  it('truncateNamed is silent-free', () => {
    const out = truncateNamed('hello world', 5, 'X')
    expect(out).toContain('truncated X')
    expect(out.startsWith('hello')).toBe(true)
  })
})

describe('getProjectMemorySection inject policy', () => {
  const base = {
    normalizedProjectPath: '/proj',
  } as unknown as PromptContext

  it('TMS present → full body (ignores foreign in default path)', () => {
    const ctx = {
      ...base,
      tmsContent: '# TMS\n## Commands\nnpm test\n',
      foreignInstructions: {
        kind: 'agents' as const,
        path: '/proj/AGENTS.md',
        relPath: 'AGENTS.md',
        content: '# Agents\nsecret foreign body that must not appear when TMS wins\n',
      },
    } as PromptContext
    const section = getProjectMemorySection(ctx)!
    expect(section).toContain('Project memory (TMS.md)')
    expect(section).toContain('## Commands')
    expect(section).toContain('npm test')
    expect(section).toContain('FINAL CHECKPOINT')
    expect(section).not.toContain('secret foreign body')
    expect(section).not.toContain('stub')
  })

  it('soft-caps oversized TMS body with named notice', () => {
    const { STATIC_PROJECT_INSTRUCTIONS_MAX_CHARS } = require('../projectInstructions') as typeof import('../projectInstructions')
    const ctx = {
      ...base,
      tmsContent: 'y'.repeat(STATIC_PROJECT_INSTRUCTIONS_MAX_CHARS + 200),
      foreignInstructions: null,
    } as PromptContext
    const section = getProjectMemorySection(ctx)!
    expect(section).toContain('truncated TMS.md')
    // +900 e não +500: quando o TMS falha a validação o cabeçalho nomeia as
    // secções em falta (2026-07-30), o que é mais longo do que o "Follow Agent
    // Rules…" de um TMS válido — e este fixture não tem nenhuma delas. O
    // overhead é de UMA vez por run, no prefixo estático em cache.
    expect(section.length).toBeLessThan(STATIC_PROJECT_INSTRUCTIONS_MAX_CHARS + 900)
  })

  it('foreign only → full AGENTS/CLAUDE body', () => {
    const ctx = {
      ...base,
      tmsContent: null,
      foreignInstructions: {
        kind: 'agents' as const,
        path: '/proj/AGENTS.md',
        relPath: 'AGENTS.md',
        content: '# Deploy\n## Rules\nnever push secrets\n',
      },
    } as PromptContext
    const section = getProjectMemorySection(ctx)!
    expect(section).toContain('AGENTS.md')
    expect(section).toContain('## Rules')
    expect(section).toContain('never push secrets')
  })

  it('neither → null', () => {
    const ctx = {
      ...base,
      tmsContent: null,
      foreignInstructions: null,
    } as PromptContext
    expect(getProjectMemorySection(ctx)).toBeNull()
  })
})

