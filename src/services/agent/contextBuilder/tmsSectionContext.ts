export type TmsSectionKey =
  | 'overview'
  | 'stack'
  | 'commands'
  | 'structure'
  | 'entrypoints'
  | 'project_patterns'
  | 'agent_rules'
  | 'confirmed'
  | 'inferred'
  | 'pending_confirmation'

interface TmsSectionSpec {
  key: TmsSectionKey
  title: string
  aliases: string[]
}

const TMS_SECTION_SPECS: TmsSectionSpec[] = [
  { key: 'overview', title: 'Overview', aliases: ['overview', 'project overview'] },
  { key: 'stack', title: 'Stack', aliases: ['stack', 'tech stack', 'technology stack'] },
  { key: 'commands', title: 'Commands', aliases: ['commands', 'scripts', 'build test commands'] },
  { key: 'structure', title: 'Structure', aliases: ['structure', 'project structure', 'directory structure'] },
  { key: 'entrypoints', title: 'EntryPoints', aliases: ['entrypoints', 'entry points', 'entrypoint'] },
  { key: 'project_patterns', title: 'Project Patterns', aliases: ['project patterns', 'patterns', 'conventions'] },
  { key: 'agent_rules', title: 'Agent Rules', aliases: ['agent rules', 'agent instructions', 'rules'] },
  { key: 'confirmed', title: 'Confirmed', aliases: ['confirmed', 'confirmed facts'] },
  { key: 'inferred', title: 'Inferred', aliases: ['inferred', 'inferences'] },
  { key: 'pending_confirmation', title: 'Pending Confirmation', aliases: ['pending confirmation', 'pending confirmations', 'pending'] },
]

const SPEC_BY_KEY = new Map(TMS_SECTION_SPECS.map(spec => [spec.key, spec]))
const TMS_CONTEXT_PREFIX = 'tms.'

export function isTmsSectionContextId(id: string): boolean {
  return id.startsWith(TMS_CONTEXT_PREFIX) && SPEC_BY_KEY.has(id.slice(TMS_CONTEXT_PREFIX.length) as TmsSectionKey)
}

export function tmsSectionContextKeyFromId(id: string): TmsSectionKey | null {
  if (!isTmsSectionContextId(id)) return null
  return id.slice(TMS_CONTEXT_PREFIX.length) as TmsSectionKey
}

function normalizeHeading(value: string): string {
  return value
    .replace(/^#+\s*/, '')
    .replace(/[`*_]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function aliasesFor(key: TmsSectionKey): Set<string> {
  const spec = SPEC_BY_KEY.get(key)
  return new Set((spec?.aliases ?? []).map(normalizeHeading))
}

export function extractTmsSection(content: string | null | undefined, key: TmsSectionKey): string | null {
  if (!content) return null
  const wanted = aliasesFor(key)
  const lines = content.split('\n')
  let start = -1
  let end = lines.length

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const match = /^(#{2})\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const normalized = normalizeHeading(match[2])
    if (start === -1 && wanted.has(normalized)) {
      start = i + 1
      continue
    }
    if (start !== -1) {
      end = i
      break
    }
  }

  if (start === -1) return null
  return lines.slice(start, end).join('\n').trim()
}

/**
 * @param foreignRelPath When TMS.md is missing, point the model at the
 *   foreign instructions file (AGENTS.md / CLAUDE.md) already discovered
 *   by the compat loader.
 */
export function buildTmsSectionContext(
  content: string | null | undefined,
  key: TmsSectionKey,
  foreignRelPath?: string | null,
): string | null {
  const spec = SPEC_BY_KEY.get(key)
  if (!spec) return null

  if (!content) {
    return [
      `# TMS.md: ${spec.title}`,
      'No TMS.md in this project — structured TMS sections are unavailable.',
      foreignRelPath
        ? `Use project.docs_full or Read ${foreignRelPath} for developer instructions (not structured TMS.md).`
        : 'Use project.docs_full or Read TMS.md only if the exact project memory content is needed.',
    ].join('\n')
  }

  const body = extractTmsSection(content, key)
  if (body == null) {
    return [
      `# TMS.md: ${spec.title}`,
      `Section "${spec.title}" was not found in TMS.md.`,
      'Use project.docs_full or Read TMS.md only if the exact project memory content is needed.',
    ].join('\n')
  }

  return [
    `# TMS.md: ${spec.title}`,
    body || '(empty)',
    '',
    'This is project memory, not source code. Verify exact code ranges with Read before editing files.',
  ].join('\n')
}
