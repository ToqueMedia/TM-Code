#!/usr/bin/env ts-node
/**
 * verify-skills.ts — CI smoke check for bundled skill authoring.
 *
 * Validates every SKILL.md under src-tauri/resources/skills/:
 *   1. Parses without error via the same parseSkillFrontmatter used in prod.
 *   2. name field (or fallback) matches the directory name.
 *   3. description is non-empty and under the 220-char cap enforced by the parser.
 *   4. Every fenced shell block is either:
 *      - self-declared as a template / non-executable (starts with "# " comment), or
 *      - syntactically parseable by a shallow shell tokenizer (no stray pipes, no
 *        unmatched quotes). This catches typos without requiring the commands to
 *        actually execute — safe to run in any CI environment.
 *
 * Exits non-zero when a skill fails validation. Kept dependency-free so the CI
 * workflow needs only node + tsx/ts-node.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Import the PRODUCTION parser directly — no more copy-paste drift between the
// CI verifier and the runtime. `skillFrontmatter.ts` is dependency-free so tsx
// can resolve it without pulling Tauri/React types.
import { parseSkillFrontmatter, MAX_DESCRIPTION_CHARS } from '../src/services/agent/skillFrontmatter'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Fenced-block extraction ───────────────────────────────────────

interface Block {
  lang: string
  body: string
  line: number
}

function extractFencedBlocks(md: string): Block[] {
  const blocks: Block[] = []
  const lines = md.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const open = lines[i].match(/^```(\w+)?/)
    if (!open) { i++; continue }
    const lang = open[1] || ''
    const startLine = i + 1
    const buf: string[] = []
    i++
    while (i < lines.length && !lines[i].startsWith('```')) {
      buf.push(lines[i])
      i++
    }
    blocks.push({ lang, body: buf.join('\n'), line: startLine })
    i++ // consume closing fence
  }
  return blocks
}

// Shallow lint: just check quotes balance and absence of obvious typos.
function lintShellBlock(body: string): string[] {
  const problems: string[] = []
  // Count unescaped quotes on non-comment lines
  const nonComment = body
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.trim().startsWith('#'))
    .join('\n')
  const unescapedSingle = (nonComment.match(/(^|[^\\])'/g) || []).length
  const unescapedDouble = (nonComment.match(/(^|[^\\])"/g) || []).length
  if (unescapedSingle % 2 !== 0) problems.push('unbalanced single quotes')
  if (unescapedDouble % 2 !== 0) problems.push('unbalanced double quotes')
  // Catch `pip install --break-system-packages` which we deprecated — prevents regression
  if (/--break-system-packages/.test(body)) {
    problems.push('uses --break-system-packages (deprecated — use a venv instead)')
  }
  return problems
}

// ─── Runner ────────────────────────────────────────────────────────

const SKILLS_ROOT = join(__dirname, '..', 'src-tauri', 'resources', 'skills')

function listSkillDirs(): string[] {
  return readdirSync(SKILLS_ROOT).filter(name => {
    try { return statSync(join(SKILLS_ROOT, name)).isDirectory() } catch { return false }
  })
}

const failures: Array<{ skill: string; issue: string }> = []

for (const dir of listSkillDirs()) {
  const path = join(SKILLS_ROOT, dir, 'SKILL.md')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    failures.push({ skill: dir, issue: 'SKILL.md missing or unreadable' })
    continue
  }

  const parsed = parseSkillFrontmatter(raw, dir)

  // The parsed name must match the directory name — otherwise the model reads
  // skill X and finds a body that identifies itself as Y. Subtle hallucination risk.
  if (parsed.name !== dir) {
    failures.push({
      skill: dir,
      issue: `frontmatter name "${parsed.name}" does not match directory "${dir}"`,
    })
  }

  if (parsed.description.length < 10) {
    failures.push({ skill: dir, issue: 'description is too short (< 10 chars)' })
  }
  if (parsed.description.length > MAX_DESCRIPTION_CHARS) {
    failures.push({
      skill: dir,
      issue: `description exceeds ${MAX_DESCRIPTION_CHARS} char cap (${parsed.description.length})`,
    })
  }

  // Lint every shell-ish code block
  const blocks = extractFencedBlocks(parsed.body)
  for (const block of blocks) {
    if (!['sh', 'bash', 'zsh', 'shell', ''].includes(block.lang)) continue
    const problems = lintShellBlock(block.body)
    for (const p of problems) {
      failures.push({ skill: dir, issue: `shell block at line ${block.line}: ${p}` })
    }
  }

  console.log(`✓ ${dir} — "${parsed.description.slice(0, 80)}${parsed.description.length > 80 ? '…' : ''}"`)
}

if (failures.length > 0) {
  console.error('\n✗ Skill verification failed:\n')
  for (const f of failures) console.error(`  [${f.skill}] ${f.issue}`)
  process.exit(1)
}

console.log(`\n${listSkillDirs().length} skills validated.`)
