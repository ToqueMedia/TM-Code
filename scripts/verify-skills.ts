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
import { parseSkillFrontmatter, MAX_DESCRIPTION_CHARS, SkillFrontmatterError } from '../src/services/agent/skillFrontmatter'
import { TOOL_NAMES, isKnownToolName } from '../src/services/agent/toolNames'

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

/**
 * Aspa por fechar num bloco de shell.
 *
 * ANTES contava-se a PARIDADE de cada tipo de aspa em separado, e isso dava
 * falsos positivos em shell perfeitamente válido — a paridade não é o mesmo que
 * estar fechado. O caso que rebentou (skill `hooks`):
 *
 *   sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*\/\\1\/p'
 *
 * Sete aspas duplas, número ímpar, "unbalanced" — mas o comando está certo: as
 * aspas estão DENTRO de uma string com plicas, portanto são caracteres
 * literais e não têm par nenhum a cumprir. O simétrico também acontecia:
 * `echo "it's fine"` acusava plicas desequilibradas.
 *
 * Agora percorre-se o texto com estado, como a shell faz: uma aspa só abre ou
 * fecha quando NÃO está dentro do outro tipo de citação. É mais correcto e
 * mais estrito ao mesmo tempo — detecta a aspa por FECHAR em vez de contar.
 */
function unclosedQuote(text: string): "'" | '"' | null {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue } // escapado: consome o seguinte
    if (ch !== "'" && ch !== '"') continue
    if (quote === null) quote = ch
    else if (quote === ch) quote = null
    // dentro do OUTRO tipo de aspa → literal, ignora-se
  }
  return quote
}

// Shallow lint: just check quotes balance and absence of obvious typos.
function lintShellBlock(body: string): string[] {
  const problems: string[] = []
  // Count unescaped quotes on non-comment lines
  const nonComment = body
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.trim().startsWith('#'))
    .join('\n')
  const unclosed = unclosedQuote(nonComment)
  if (unclosed === "'") problems.push('unbalanced single quotes')
  if (unclosed === '"') problems.push('unbalanced double quotes')
  // Catch `pip install --break-system-packages` which we deprecated — prevents regression
  if (/--break-system-packages/.test(body)) {
    problems.push('uses --break-system-packages (deprecated — use a venv instead)')
  }
  return problems
}

// ─── Tool-name reference check ────────────────────────────────────
//
// Catches the case where a SKILL.md mentions `provision_auth_old` (or
// any other stale name) in backticks or as a function-call form. The
// model would happily try to call it and the harness would reject —
// detecting the drift here keeps the prompt + tool registry in sync.

/** Words inside backticks OR immediately followed by `(` that look like
 *  tool identifiers (snake_case, ≥4 chars). Captures real tool refs while
 *  ignoring english prose like `auth` or `idToken`. */
const TOOL_REF_PATTERN = /(?:`([a-z][a-z0-9_]*)`|\b([a-z][a-z0-9_]+)\s*\()/g

/** Snake-case tokens that look like tool names but are platform/library
 *  identifiers we deliberately reference in SKILLs without registering. */
const TOOL_REF_ALLOWLIST = new Set([
  // Firebase / Identity Toolkit endpoints + payload fields
  'sign_in', 'sign_up', 'sign_out', 'id_token', 'refresh_token',
  'returnSecureToken', 'tenantId', 'localId', 'displayName',
  // Common shell / build tool names
  'npm_install', 'yarn_install', 'pnpm_install', 'npm_run', 'yarn_run',
  'tsx_watch', 'firebase_admin',
  // Stdlib-ish
  'set_user', 'set_auth_token', 'get_auth_token', 'auth_fetch', 'init_app',
  // Test-runner / framework names
  'use_effect', 'create_root',
])

function findStaleToolRefs(body: string): string[] {
  const seen = new Set<string>()
  const stale: string[] = []
  for (const match of body.matchAll(TOOL_REF_PATTERN)) {
    const candidate = (match[1] ?? match[2] ?? '').trim()
    if (!candidate || candidate.length < 4) continue
    // Heuristic: must contain at least one underscore (eliminates `await`,
    // `console`, `fetch`, etc.) AND not be in the allowlist.
    if (!candidate.includes('_')) continue
    if (TOOL_REF_ALLOWLIST.has(candidate)) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    // Only flag candidates that *resemble* a tool we register but with
    // a typo. We say "resembles" when the candidate shares a 4+ char
    // prefix with a known tool — catches `provision_authh`, `read_skil`,
    // `start_dev_servers`, etc., without false-positiving every snake_case
    // word in the SKILL.
    if (isKnownToolName(candidate)) continue
    // Only flag candidates that start with a TM-Code-owned prefix —
    // names nobody else in the JS/Python ecosystem uses. Generic verbs
    // (`create_`, `read_`) collide with library APIs (xlsx `create_sheet`,
    // python `read_csv`, etc.) so we exclude them from the drift check.
    const TM_OWNED_PREFIXES = [
      'provision_', 'request_credentials', 'spawn_background_',
      'check_background_', 'update_tasks', 'start_dev_server',
      'read_dev_server_logs', 'read_skill', 'read_large_result',
    ]
    const looksLikeTool = TM_OWNED_PREFIXES.some((p) => candidate.startsWith(p))
    if (looksLikeTool) stale.push(candidate)
  }
  return stale
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

  let parsed: ReturnType<typeof parseSkillFrontmatter>
  try {
    parsed = parseSkillFrontmatter(raw, dir)
  } catch (err) {
    if (err instanceof SkillFrontmatterError) {
      failures.push({ skill: dir, issue: err.message })
      continue
    }
    throw err
  }

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

  // Drift check: tool-name references that look like a real tool but don't
  // match any registered name. Catches typos and stale renames.
  const stale = findStaleToolRefs(parsed.body)
  for (const ref of stale) {
    failures.push({
      skill: dir,
      issue: `references unknown tool name "${ref}" — either fix the typo or add to TOOL_NAMES in src/services/agent/toolNames.ts`,
    })
  }

  console.log(`✓ ${dir} — "${parsed.description.slice(0, 80)}${parsed.description.length > 80 ? '…' : ''}"`)
}

if (failures.length > 0) {
  console.error('\n✗ Skill verification failed:\n')
  for (const f of failures) console.error(`  [${f.skill}] ${f.issue}`)
  process.exit(1)
}

console.log(`\n${listSkillDirs().length} skills validated.`)
