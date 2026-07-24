#!/usr/bin/env node
/**
 * Offline proof harness: JSON pretty / mini / TOON / domain / production policy
 * on TM Code agent-input shapes.
 *
 * Usage:
 *   yarn node scripts/prompt-format-bench.mjs
 *   yarn node scripts/prompt-format-bench.mjs --json > /tmp/prompt-format-bench.json
 *
 * Exit 0 when hard regression checks pass; 1 otherwise.
 *
 * Tokenizer: gpt-tokenizer (devDependency). Falls back to chars/4 if missing.
 */

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { encode as toonEncode } from '@toon-format/toon'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const asJson = process.argv.includes('--json')
const writeOut = process.argv.includes('--write')

// ── tokenizer ──────────────────────────────────────────────────────────────
let tok = (s) => Math.ceil(String(s).length / 4)
let tokLabel = 'chars/4 (fallback)'
try {
  const gpt = await import('gpt-tokenizer')
  const encode = gpt.encode ?? gpt.default?.encode
  if (typeof encode === 'function') {
    tok = (s) => encode(String(s)).length
    tokLabel = 'gpt-tokenizer'
  }
} catch {
  // keep fallback
}

// ── production policy (inline mirror of promptSerialize size gate) ─────────
// We cannot import TS sources cleanly here without tsx; mirror the gate so the
// bench proves the same decision. Unit tests cover the real TS module.
const TOON_WIN_RATIO = 0.9

function jsonMini(v) {
  return JSON.stringify(v)
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isPrimitiveLeaf(v) {
  if (v === null || v === undefined) return true
  const t = typeof v
  return t === 'string' || t === 'number' || t === 'boolean'
}

function isPrimitiveObjectArray(value) {
  if (!Array.isArray(value) || value.length < 2) return false
  if (!value.every((row) => isPlainObject(row) && Object.values(row).every(isPrimitiveLeaf))) {
    return false
  }
  return Object.keys(value[0]).length > 0
}

function preferToon(value) {
  if (isPrimitiveObjectArray(value)) return true
  if (!isPlainObject(value)) return false
  let saw = false
  for (const v of Object.values(value)) {
    if (isPrimitiveLeaf(v)) continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      if (isPrimitiveObjectArray(v)) {
        saw = true
        continue
      }
      if (v.every(isPrimitiveLeaf)) continue
      return false
    }
    if (isPlainObject(v)) return false
    return false
  }
  return saw
}

function policySerialize(value) {
  if (typeof value === 'string') return { text: value, format: 'string' }
  const mini = jsonMini(value)
  if (!preferToon(value)) return { text: mini, format: 'json_mini' }
  let toon
  try {
    toon = toonEncode(value)
  } catch {
    return { text: mini, format: 'json_mini' }
  }
  if (toon.length <= mini.length * TOON_WIN_RATIO) {
    return { text: toon, format: 'toon' }
  }
  return { text: mini, format: 'json_mini' }
}

// ── domain formatters (mirror production) ──────────────────────────────────
function formatSearchDomain(result) {
  const files = Array.isArray(result) ? result : result.files || []
  if (!files.length) return 'No matches found.'
  const matchCount =
    result.total_matches ??
    result.totalMatches ??
    files.reduce((s, f) => s + (f.matches?.length || 0), 0)
  const lines = [
    `Found ${matchCount} matches in ${result.total_files ?? result.totalFiles ?? files.length} files`,
  ]
  for (const f of files) {
    const filePath = f.file_path ?? f.path ?? '?'
    for (const m of f.matches || []) {
      const lineNum = m.line_number ?? m.lineNumber ?? '?'
      const col = m.column ?? '?'
      const matchText = (m.match_text || '').replace(/\n/g, ' ').slice(0, 120)
      lines.push(`${filePath}:${lineNum}:${col}: ${matchText}`)
      const n = typeof lineNum === 'number' ? lineNum : parseInt(lineNum, 10)
      const before = m.context_before || []
      const after = m.context_after || []
      if (Number.isFinite(n) && before.length) {
        before.forEach((c, i) => lines.push(`  ${n - before.length + i}: ${String(c).slice(0, 200)}`))
      }
      if (m.text) {
        lines.push(Number.isFinite(n) ? `> ${n}: ${String(m.text).slice(0, 200)}` : `> ${m.text}`)
      }
      if (Number.isFinite(n) && after.length) {
        after.forEach((c, i) => lines.push(`  ${n + i + 1}: ${String(c).slice(0, 200)}`))
      }
    }
  }
  return lines.join('\n')
}

function formatTreeDomain(node, indent = '') {
  if (!node) return ''
  let result = ''
  const name = node.name || node.fileName || ''
  const isDir = node.type === 'directory' || node.children !== undefined
  if (name) result += `${indent}${isDir ? name + '/' : name}\n`
  if (Array.isArray(node.children)) {
    const childIndent = name ? indent + '  ' : indent
    for (const child of node.children) result += formatTreeDomain(child, childIndent)
  }
  return result || '(empty directory)'
}

function formatTasksDomain(tasks) {
  const completed = tasks.filter((t) => t.status === 'completed').length
  const lines = [`Task list updated: ${completed}/${tasks.length} completed.`, 'Active tasks:']
  for (const t of tasks.filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status))) {
    const marker = t.status === 'in_progress' ? '~' : ' '
    lines.push(`- [${marker}] ${t.id}: ${t.description}`)
  }
  return lines.join('\n')
}

function formatGlobDomain(paths) {
  return paths.length ? paths.join('\n') : 'No files found'
}

function formatGitStatusDomain(files) {
  return files
    .map((f) => `${f.status}\t${f.path}\t${f.staged ? 'staged' : 'unstaged'}`)
    .join('\n')
}

// ── payloads ───────────────────────────────────────────────────────────────
function makeSearchPayload(nMatches, withContext = true) {
  const files = []
  let remaining = nMatches
  let fi = 0
  while (remaining > 0) {
    const count = Math.min(remaining, 3 + (fi % 4))
    const matches = []
    for (let i = 0; i < count; i++) {
      const line = 10 + i * 17 + fi * 3
      matches.push({
        line_number: line,
        column: 1 + (i % 12),
        match_text: i % 2 ? 'JSON.stringify' : 'formatSearchResultsCompact',
        text: `  const x = ${i % 2 ? 'JSON.stringify(result, null, 2)' : 'this.formatSearchResultsCompact(result)'}`,
        ...(withContext
          ? {
              context_before: [`  // context before ${line}`, `  function helper${fi}() {`],
              context_after: [`    return true`, `  }`],
            }
          : { context_before: [], context_after: [] }),
      })
    }
    files.push({
      file_path: `/Users/dev/exodus-ide/src/services/agent/file_${fi}.ts`,
      matches,
    })
    remaining -= count
    fi++
  }
  return { total_matches: nMatches, total_files: files.length, files }
}

function makeFileTree(depth, breadth, prefix = 'src') {
  if (depth <= 0) return { name: `${prefix}.ts`, type: 'file' }
  const children = []
  for (let i = 0; i < breadth; i++) {
    if (i % 3 === 0) {
      children.push(makeFileTree(depth - 1, Math.max(1, breadth - 1), `${prefix}/mod${i}`))
    } else {
      children.push({ name: `file_${i}.ts`, type: 'file' })
    }
  }
  return { name: prefix.split('/').pop() || prefix, type: 'directory', children }
}

function makeTasks(n) {
  const statuses = ['pending', 'in_progress', 'completed', 'failed']
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    description: `Implement feature slice ${i + 1}: wire handler and tests`,
    status: statuses[i % statuses.length],
    ...(i > 0 && i % 3 === 0 ? { dependsOn: [`t${i}`] } : {}),
    ...(i % 2 === 0 ? { files: [`src/a${i}.ts`, `src/b${i}.ts`] } : {}),
    ...(statuses[i % statuses.length] === 'completed'
      ? { evidence: 'tsc clean + 3 tests green' }
      : {}),
  }))
}

function makeGlob(n) {
  return Array.from(
    { length: n },
    (_, i) => `/Users/dev/exodus-ide/src/services/agent/module_${i % 20}/file_${i}.ts`,
  )
}

function makeGitStatus(n) {
  const st = ['M', 'A', 'D', '??', 'R']
  return Array.from({ length: n }, (_, i) => ({
    path: `src/components/views/View${i}.tsx`,
    status: st[i % st.length],
    staged: i % 3 === 0,
  }))
}

function makeDiffLarge() {
  const lines = Array.from({ length: 200 }, (_, i) => `  line${i}(): void { console.log(${i}) }`)
  const body = `export class Big {\n${lines.join('\n')}\n}\n`
  return {
    type: 'diff',
    path: '/Users/dev/exodus-ide/src/services/agent/toolExecutor.ts',
    oldContent: body,
    newContent: body.replace('line50', 'line50Fixed'),
    isNewFile: false,
  }
}

function makeMcpTabular() {
  return {
    tools: Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      server: i % 3 === 0 ? 'cloudflare-docs' : i % 3 === 1 ? 'tasks' : 'cloudflare-api',
      description: `Does operation ${i} on resource ${i % 7}`,
      inputCount: (i % 5) + 1,
    })),
  }
}

function makeMcpNested() {
  return {
    ok: true,
    page: {
      title: 'Workers AI',
      url: 'https://developers.cloudflare.com/workers-ai/',
      sections: [
        { h: 'Overview', body: 'Run ML models on Cloudflare network. '.repeat(8) },
        { h: 'Models', items: ['llama', 'whisper', 'bge'], notes: { free: true, limits: { rpm: 300 } } },
      ],
    },
    meta: { fetchedAt: '2026-07-24T12:00:00Z', status: 200 },
  }
}

function makeCommandLog() {
  return Array.from(
    { length: 80 },
    (_, i) => `src/foo.ts:${i + 1}: error TS${2000 + i}: Something went wrong with type '${i}'`,
  ).join('\n')
}

// ── measure ────────────────────────────────────────────────────────────────
function measure(name, data, domainFn) {
  const pretty = JSON.stringify(data, null, 2)
  const mini = jsonMini(data)
  let toonText = ''
  let toonOk = false
  try {
    toonText = toonEncode(data)
    toonOk = true
  } catch {
    toonText = ''
  }
  const domain = domainFn ? domainFn(data) : null
  const policy = policySerialize(data)

  const variants = [
    { label: 'json_pretty', text: pretty },
    { label: 'json_mini', text: mini },
    ...(toonOk ? [{ label: 'toon_raw', text: toonText }] : []),
    ...(domain != null ? [{ label: 'domain', text: domain }] : []),
    { label: 'policy', text: policy.text, policyFormat: policy.format },
  ].map((v) => {
    const tokens = tok(v.text)
    const chars = v.text.length
    const prettyTok = tok(pretty)
    return {
      ...v,
      tokens,
      chars,
      vsPrettyPct: prettyTok ? Math.round((tokens / prettyTok) * 1000) / 10 : null,
      vsMiniPct: Math.round((tokens / tok(mini)) * 1000) / 10,
    }
  })

  const best = variants.reduce((a, b) => (b.tokens < a.tokens ? b : a))
  return { name, variants, best: best.label, bestTokens: best.tokens, policyFormat: policy.format }
}

const scenarios = [
  measure('search_files ×5 (no ctx)', makeSearchPayload(5, false), formatSearchDomain),
  measure('search_files ×30 (with ctx)', makeSearchPayload(30, true), formatSearchDomain),
  measure('search_files ×50 (with ctx)', makeSearchPayload(50, true), formatSearchDomain),
  measure('list_directory tree', makeFileTree(4, 5, 'src'), formatTreeDomain),
  measure('glob ×80 paths', makeGlob(80), formatGlobDomain),
  measure('update_tasks ×12', makeTasks(12), formatTasksDomain),
  measure('git_status ×40', makeGitStatus(40), formatGitStatusDomain),
  measure('write/edit diff large', makeDiffLarge(), null),
  measure('MCP tabular tools ×40', makeMcpTabular(), null),
  measure('MCP nested irregular', makeMcpNested(), null),
  measure('execute_command log', { output: makeCommandLog(), exitCode: 1 }, (d) =>
    `exit: ${d.exitCode}\n${d.output}`,
  ),
]

// ── regression checks (must hold for exit 0) ───────────────────────────────
const checks = []
function check(id, ok, detail) {
  checks.push({ id, ok: !!ok, detail })
}

function variant(s, label) {
  return s.variants.find((v) => v.label === label)
}

// Domain beats pretty when domain exists
for (const s of scenarios) {
  const d = variant(s, 'domain')
  const p = variant(s, 'json_pretty')
  if (d && p) check(`${s.name}: domain <= pretty`, d.tokens <= p.tokens, `${d.tokens} vs ${p.tokens}`)
}

// Policy never emits pretty
for (const s of scenarios) {
  const pol = variant(s, 'policy')
  check(`${s.name}: policy not pretty-shaped`, pol && !pol.text.startsWith('{\n'), pol?.text.slice(0, 40))
}

// MCP tabular: policy is toon OR mini that is within raw toon competitiveness
{
  const s = scenarios.find((x) => x.name.startsWith('MCP tabular'))
  const mini = variant(s, 'json_mini')
  const toon = variant(s, 'toon_raw')
  const pol = variant(s, 'policy')
  check('MCP tabular: raw TOON wins vs mini', toon && mini && toon.tokens < mini.tokens, `${toon?.tokens} vs ${mini?.tokens}`)
  check(
    'MCP tabular: policy is toon when size gate allows',
    s.policyFormat === 'toon' || (toon && toon.chars > mini.chars * TOON_WIN_RATIO),
    `format=${s.policyFormat}`,
  )
  check('MCP tabular: policy <= mini tokens', pol && mini && pol.tokens <= mini.tokens, `${pol?.tokens} vs ${mini?.tokens}`)
}

// Nested irregular: policy = mini, not toon
{
  const s = scenarios.find((x) => x.name.startsWith('MCP nested'))
  check('MCP nested: policy json_mini', s.policyFormat === 'json_mini', s.policyFormat)
}

// Diff large: policy ≈ mini (TOON no win)
{
  const s = scenarios.find((x) => x.name.includes('diff'))
  const mini = variant(s, 'json_mini')
  const pol = variant(s, 'policy')
  check('diff large: policy ≈ mini (±2%)', pol && mini && Math.abs(pol.tokens - mini.tokens) / mini.tokens < 0.02, `${pol?.tokens} vs ${mini?.tokens}`)
}

// Tree domain crushes mini
{
  const s = scenarios.find((x) => x.name.includes('list_directory'))
  const d = variant(s, 'domain')
  const mini = variant(s, 'json_mini')
  check('tree: domain << mini', d && mini && d.tokens < mini.tokens * 0.7, `${d?.tokens} vs ${mini?.tokens}`)
}

// Tasks domain crushes mini
{
  const s = scenarios.find((x) => x.name.includes('update_tasks'))
  const d = variant(s, 'domain')
  const mini = variant(s, 'json_mini')
  check('tasks: domain << mini', d && mini && d.tokens < mini.tokens * 0.5, `${d?.tokens} vs ${mini?.tokens}`)
}

// ── report ─────────────────────────────────────────────────────────────────
const report = {
  tokenizer: tokLabel,
  toonWinRatio: TOON_WIN_RATIO,
  generatedAt: new Date().toISOString(),
  scenarios,
  checks,
  summary: {
    checksPassed: checks.filter((c) => c.ok).length,
    checksFailed: checks.filter((c) => !c.ok).length,
  },
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('=== prompt-format-bench ===')
  console.log(`tokenizer: ${tokLabel}`)
  console.log('')
  for (const s of scenarios) {
    console.log(`## ${s.name}  (best=${s.best}, policy=${s.policyFormat})`)
    console.log(
      'format'.padEnd(14) +
        'tokens'.padStart(8) +
        'chars'.padStart(10) +
        '%pretty'.padStart(10) +
        '%mini'.padStart(8),
    )
    for (const v of s.variants) {
      const mark = v.label === s.best ? ' ← best' : ''
      console.log(
        v.label.padEnd(14) +
          String(v.tokens).padStart(8) +
          String(v.chars).padStart(10) +
          (v.vsPrettyPct != null ? String(v.vsPrettyPct).padStart(9) + '%' : '       -') +
          String(v.vsMiniPct).padStart(7) +
          '%' +
          mark,
      )
    }
    console.log('')
  }
  console.log('=== regression checks ===')
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}${c.detail != null ? `  (${c.detail})` : ''}`)
  }
  console.log('')
  console.log(`summary: ${report.summary.checksPassed} passed, ${report.summary.checksFailed} failed`)
}

if (writeOut) {
  const outPath = join(root, 'scripts', 'prompt-format-bench.results.json')
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  if (!asJson) console.log(`wrote ${outPath}`)
}

// Also exercise production TS modules via jest-less dynamic path when tsx available
// (stats path — level 3 partial). Optional.
let prodStats = null
try {
  const { register } = await import('node:module')
  // Prefer tsx if present
  const tsxPath = require.resolve('tsx/esm/api', { paths: [root] })
  if (tsxPath) {
    // Run a small inline eval via child would be heavy; skip if not trivial
  }
} catch {
  // ignore
}

if (report.summary.checksFailed > 0) {
  process.exitCode = 1
}
