import {
  GLOB,
  LIST_DIRECTORY,
  READ_FILE,
  SEARCH_FILES,
} from './toolNames'

export type ExecuteCommandPurpose = 'validation' | 'file_read' | 'unknown'

export type ConvertedShellReadCommand = {
  toolName: typeof READ_FILE | typeof SEARCH_FILES | typeof LIST_DIRECTORY | typeof GLOB
  input: Record<string, unknown>
}

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase()
}

function unwrapShell(command: string): string {
  const trimmed = command.trim()
  const shellCommand = /^(?:(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|fish|sh)|pwsh|powershell|cmd(?:\.exe)?)\b/i.test(trimmed)
  if (!shellCommand) return trimmed

  const markers = [' -lc ', ' -c ']
  for (const marker of markers) {
    const idx = trimmed.indexOf(marker)
    if (idx === -1) continue
    const rest = trimmed.slice(idx + marker.length).trim()
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      return rest.slice(1, -1).trim()
    }
    return rest
  }
  return trimmed
}

function hasUnquotedShellControl(command: string): boolean {
  let single = false
  let double = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === "'" && !double) {
      single = !single
      continue
    }
    if (ch === '"' && !single) {
      double = !double
      continue
    }
    if (!single && !double) {
      if (ch === '\n' || ch === '|' || ch === ';' || ch === '<' || ch === '>' || ch === '&' || ch === '`') {
        return true
      }
    }
    if (!single && (ch === '`' || (ch === '$' && command[i + 1] === '('))) {
      return true
    }
  }

  return single || double || escaped
}

function tokenizeSimpleShell(command: string): string[] | null {
  if (hasUnquotedShellControl(command)) return null

  const tokens: string[] = []
  let current = ''
  let single = false
  let double = false
  let escaped = false

  const push = () => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === "'" && !double) {
      single = !single
      continue
    }
    if (ch === '"' && !single) {
      double = !double
      continue
    }
    if (!single && !double && /\s/.test(ch)) {
      push()
      continue
    }
    current += ch
  }

  if (single || double || escaped) return null
  push()
  return tokens
}

function commandTokens(command: string): string[] | null {
  const unwrapped = unwrapShell(command)
  return tokenizeSimpleShell(unwrapped)
}

function readFileInput(filePath: string, range?: { offset?: number; limit?: number }): ConvertedShellReadCommand {
  return {
    toolName: READ_FILE,
    input: {
      file_path: filePath,
      ...(range?.offset ? { offset: range.offset } : {}),
      ...(range?.limit ? { limit: range.limit } : {}),
    },
  }
}

function singlePathOperand(tokens: string[], valueOptions = new Set<string>()): string | null {
  const operands: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') {
      operands.push(...tokens.slice(i + 1))
      break
    }
    if (token.startsWith('-') && token !== '-') {
      if (valueOptions.has(token)) i++
      continue
    }
    operands.push(token)
  }
  return operands.length === 1 ? operands[0] : null
}

function parseCat(tokens: string[]): ConvertedShellReadCommand | null {
  const filePath = singlePathOperand(tokens)
  return filePath ? readFileInput(filePath) : null
}

function parseHead(tokens: string[]): ConvertedShellReadCommand | null {
  let limit: number | undefined
  const operands: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') {
      operands.push(...tokens.slice(i + 1))
      break
    }
    if (token === '-n' || token === '--lines') {
      const parsed = Number(tokens[i + 1])
      if (!Number.isInteger(parsed) || parsed <= 0) return null
      limit = parsed
      i++
      continue
    }
    const attached = token.match(/^(?:-n|--lines=)(\d+)$/)
    if (attached) {
      limit = Number(attached[1])
      continue
    }
    const short = token.match(/^-(\d+)$/)
    if (short) {
      limit = Number(short[1])
      continue
    }
    if (token.startsWith('-')) continue
    operands.push(token)
  }

  return operands.length === 1 ? readFileInput(operands[0], limit ? { limit } : undefined) : null
}

function parseSed(tokens: string[]): ConvertedShellReadCommand | null {
  let printOnly = false
  let script: string | undefined
  const files: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-n' || token === '--quiet' || token === '--silent') {
      printOnly = true
      continue
    }
    if (token === '-e') {
      if (script) return null
      script = tokens[i + 1]
      i++
      continue
    }
    if (token.startsWith('-')) return null
    if (!script) {
      script = token
      continue
    }
    files.push(token)
  }

  if (!printOnly || !script || files.length !== 1) return null

  const exact = script.match(/^(\d+)p$/)
  if (exact) {
    return readFileInput(files[0], { offset: Number(exact[1]), limit: 1 })
  }

  const range = script.match(/^(\d+),(\d+)p$/)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (end < start) return null
    return readFileInput(files[0], { offset: start, limit: end - start + 1 })
  }

  const plus = script.match(/^(\d+),\+(\d+)p$/)
  if (plus) {
    const start = Number(plus[1])
    const extra = Number(plus[2])
    return readFileInput(files[0], { offset: start, limit: extra + 1 })
  }

  return null
}

function parseList(tokens: string[]): ConvertedShellReadCommand | null {
  let directory = '.'
  let maxDepth: number | undefined
  const paths: string[] = []
  const first = tokens[0].toLowerCase()

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') {
      paths.push(...tokens.slice(i + 1))
      break
    }
    if (first === 'tree' && token === '-L') {
      const parsed = Number(tokens[i + 1])
      if (!Number.isInteger(parsed) || parsed <= 0) return null
      maxDepth = parsed
      i++
      continue
    }
    if (first === 'ls' && (token === '--recursive' || /^-[A-Za-z]*R[A-Za-z]*$/.test(token))) {
      maxDepth = 3
      continue
    }
    if (token.startsWith('-')) continue
    paths.push(token)
  }

  if (paths.length > 1) return null
  if (paths.length === 1) directory = paths[0]

  return {
    toolName: LIST_DIRECTORY,
    input: {
      file_path: directory,
      ...(maxDepth ? { maxDepth } : { maxDepth: first === 'ls' ? 1 : 3 }),
    },
  }
}

const SEARCH_VALUE_OPTIONS = new Set([
  '-A', '--after-context',
  '-B', '--before-context',
  '-C', '--context',
  '-g', '--glob',
  '-m', '--max-count',
  '-t', '--type',
  '--include',
  '--exclude',
])

function addIncludePattern(includePatterns: string[], pattern: string | undefined): boolean {
  if (!pattern) return false
  includePatterns.push(pattern)
  return true
}

function parseSearch(tokens: string[]): ConvertedShellReadCommand | null {
  let query: string | undefined
  let directory = '.'
  let caseSensitive = false
  let useRegex = true
  const includePatterns: string[] = []
  const paths: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') {
      const rest = tokens.slice(i + 1)
      if (!query && rest.length > 0) {
        query = rest[0]
        paths.push(...rest.slice(1))
      } else {
        paths.push(...rest)
      }
      break
    }
    if (token === '-e' || token === '--regexp') {
      if (query) return null
      query = tokens[i + 1]
      i++
      continue
    }
    if (token.startsWith('--regexp=')) {
      if (query) return null
      query = token.slice('--regexp='.length)
      continue
    }
    if (token === '-i' || token === '--ignore-case') {
      caseSensitive = false
      continue
    }
    if (token === '-s' || token === '--case-sensitive') {
      caseSensitive = true
      continue
    }
    if (token === '-F' || token === '--fixed-strings') {
      useRegex = false
      continue
    }
    if (token === '-E' || token === '--extended-regexp' || token === '-P' || token === '--perl-regexp') {
      useRegex = true
      continue
    }
    if (token === '-g' || token === '--glob' || token === '--include') {
      if (!addIncludePattern(includePatterns, tokens[i + 1])) return null
      i++
      continue
    }
    if (token.startsWith('--glob=')) {
      addIncludePattern(includePatterns, token.slice('--glob='.length))
      continue
    }
    if (token.startsWith('--include=')) {
      addIncludePattern(includePatterns, token.slice('--include='.length))
      continue
    }
    if (token.startsWith('-g') && token.length > 2) {
      addIncludePattern(includePatterns, token.slice(2))
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      if (SEARCH_VALUE_OPTIONS.has(token)) i++
      continue
    }
    if (!query) {
      query = token
      continue
    }
    paths.push(token)
  }

  if (!query) return null
  if (paths.length > 1) return null
  if (paths.length === 1) directory = paths[0]

  return {
    toolName: SEARCH_FILES,
    input: {
      query,
      directory,
      caseSensitive,
      useRegex,
      ...(includePatterns.length ? { includePatterns } : {}),
    },
  }
}

function recursiveGlob(pattern: string): string {
  if (pattern.includes('/')) return pattern
  if (pattern.startsWith('**/')) return pattern
  return `**/${pattern}`
}

function parseFind(tokens: string[]): ConvertedShellReadCommand | null {
  let directory = '.'
  let i = 1
  if (tokens[i] && !tokens[i].startsWith('-')) {
    directory = tokens[i]
    i++
  }

  let pattern: string | undefined
  for (; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-name' || token === '-iname') {
      if (pattern) return null
      pattern = tokens[i + 1]
      i++
      continue
    }
    if (token === '-type') {
      const type = tokens[i + 1]
      if (type !== 'f' && type !== 'd') return null
      i++
      continue
    }
    if (token === '-print') continue
    return null
  }

  if (!pattern) return null
  return {
    toolName: GLOB,
    input: {
      pattern: recursiveGlob(pattern),
      directory,
    },
  }
}

export function convertShellReadCommand(command: string): ConvertedShellReadCommand | null {
  const tokens = commandTokens(command)
  if (!tokens || tokens.length === 0) return null

  const first = tokens[0].toLowerCase()
  switch (first) {
    case 'cat':
      return parseCat(tokens)
    case 'head':
      return parseHead(tokens)
    case 'sed':
      return parseSed(tokens)
    case 'ls':
    case 'tree':
      return parseList(tokens)
    case 'grep':
    case 'rg':
    case 'ack':
    case 'ag':
      return parseSearch(tokens)
    case 'find':
      return parseFind(tokens)
    default:
      return null
  }
}

export function classifyExecuteCommandPurpose(command: string): ExecuteCommandPurpose {
  const normalized = normalizeCommand(unwrapShell(command))
  if (!normalized) return 'unknown'

  const validationTerms = [
    'yarn test',
    'npm test',
    'pnpm test',
    'bun test',
    'jest',
    'vitest',
    'playwright',
    'cypress',
    'tsc',
    'typecheck',
    'type-check',
    'lint',
    'build',
  ]
  if (validationTerms.some((term) => normalized.includes(term))) {
    return 'validation'
  }

  if (convertShellReadCommand(command)) {
    return 'file_read'
  }

  const first = normalized.split(/\s+/)[0]
  if ([
    'ack',
    'ag',
    'awk',
    'cat',
    'fd',
    'find',
    'grep',
    'head',
    'ls',
    'rg',
    'sed',
    'tail',
    'tree',
  ].includes(first)) {
    return 'file_read'
  }

  if (
    ['node', 'bun', 'deno'].includes(first) &&
    /(?:readfilesync|readfile|createreadstream|require\(["']fs["']\)|from\s+["']node:fs["']|from\s+["']fs["'])/.test(normalized)
  ) {
    return 'file_read'
  }

  if (
    ['python', 'python3', 'py'].includes(first) &&
    /(?:\bopen\s*\(|read_text\s*\(|pathlib|os\.listdir|glob\.glob)/.test(normalized)
  ) {
    return 'file_read'
  }

  if (
    ['ruby', 'perl'].includes(first) &&
    /(?:file\.read|open\s*\(|readline|glob)/.test(normalized)
  ) {
    return 'file_read'
  }

  return 'unknown'
}
