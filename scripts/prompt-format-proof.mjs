#!/usr/bin/env node
/**
 * Level-3 partial proof: exercise production TypeScript serialize modules.
 *
 *   yarn proof:prompt-format
 *
 * Avoids importing mcpService (pulls viteEnv/tauri). Mirrors parseMcpToolResult
 * structured branch only.
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const serializePath = join(root, 'src/services/agent/promptSerialize.ts')
const domainPath = join(root, 'src/services/agent/domainFormats.ts')

const {
  serializeStructuredForPromptDetailed,
  resetPromptSerializeStats,
  getPromptSerializeStats,
  TOON_WIN_RATIO,
} = await import(pathToFileURL(serializePath).href)

const { formatGitStatusDomain } = await import(pathToFileURL(domainPath).href)

/** Same branch as parseMcpToolResult when result has no content[] array. */
function parseMcpStructured(result) {
  if (typeof result === 'string') return { text: result }
  return serializeStructuredForPromptDetailed(result)
}

resetPromptSerializeStats()
const cases = []

function runCase(name, value) {
  const before = { ...getPromptSerializeStats() }
  const r = serializeStructuredForPromptDetailed(value)
  const after = getPromptSerializeStats()
  cases.push({
    name,
    format: r.format,
    chars: r.chars,
    deltaWins: after.toonWins - before.toonWins,
    deltaSaved: after.charsSavedVsMini - before.charsSavedVsMini,
  })
  return r
}

// Script B — MCP tabular sweet spot
const tabular = {
  tools: Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    server: 'docs',
    description: `op ${i}`,
    inputCount: (i % 5) + 1,
  })),
}
runCase('MCP tabular ×40', tabular)

// Nested irregular
runCase('MCP nested irregular', {
  ok: true,
  page: { title: 'x', nested: { a: 1, body: 'long '.repeat(20) } },
})

// Diff-like
runCase('diff payload', {
  type: 'diff',
  path: '/tmp/a.ts',
  oldContent: 'a\n'.repeat(50),
  newContent: 'b\n'.repeat(50),
  isNewFile: false,
})

// Tiny tabular — may no-win
runCase('tiny tabular 2 rows', [
  { a: 1, b: 2 },
  { a: 3, b: 4 },
])

// Permissions-like (TOON candidate)
runCase('permissions grants ×25', {
  projectId: 'p1',
  mode: 'auto',
  grants: Array.from({ length: 25 }, (_, i) => ({
    tool: ['execute_command', 'write_file', 'edit_file', 'web_fetch'][i % 4],
    pattern: i % 2 ? 'npm *' : 'src/**',
    scope: i % 3 === 0 ? 'session' : 'project',
    createdAt: 1720000000 + i * 1000,
  })),
})

// Domain git vs mini
const gitRows = Array.from({ length: 40 }, (_, i) => ({
  path: `src/f${i}.ts`,
  status: 'M',
  staged: i % 2 === 0,
}))
const gitDomain = formatGitStatusDomain(gitRows)
const gitMini = JSON.stringify(gitRows)

// MCP structured parse path (no content[])
const mcpParsed = parseMcpStructured(tabular)

const stats = getPromptSerializeStats()

const report = {
  level: '3-partial-production-path',
  toonWinRatio: TOON_WIN_RATIO,
  cases,
  stats,
  gitDomainVsMini: {
    domainChars: gitDomain.length,
    miniChars: gitMini.length,
    domainVsMiniPct: Math.round((gitDomain.length / gitMini.length) * 1000) / 10,
  },
  mcpStructuredParse: {
    format: mcpParsed.format,
    chars: mcpParsed.chars,
    looksLikeToon: /^tools\[\d+\]\{/.test(mcpParsed.text),
  },
  verdict: {
    toonUsedInProductionPath: stats.toonWins > 0,
    charsSavedVsMini: stats.charsSavedVsMini,
    jsonMiniFallbacks: stats.jsonMini,
    proofPass: stats.toonWins >= 1 && stats.charsSavedVsMini > 0,
  },
}

console.log(JSON.stringify(report, null, 2))

if (!report.verdict.proofPass) {
  console.error('PROOF FAIL: expected toonWins >= 1 and charsSavedVsMini > 0')
  process.exitCode = 1
} else {
  console.error('PROOF PASS: production serialize path used TOON and saved chars vs mini')
}
