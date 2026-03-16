/**
 * Syntax highlighting for diff views using refractor (Prism-based).
 * Converts code into per-line arrays of colored tokens.
 */
import { refractor } from 'refractor'
import tsx from 'refractor/tsx'
import jsx from 'refractor/jsx'
import toml from 'refractor/toml'
import dart from 'refractor/dart'

// Register extra languages not in common bundle
refractor.register(tsx)
refractor.register(jsx)
refractor.register(toml)
refractor.register(dart)

// ---------- Types ----------

export interface ColoredToken {
  text: string
  color: string
}

export type HighlightedLine = ColoredToken[]

// ---------- Extension → Language map ----------

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  lua: 'lua',
  r: 'r',
  R: 'r',
  makefile: 'makefile',
  mk: 'makefile',
  pl: 'perl',
  pm: 'perl',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
}

// ---------- Token class → Color map (Dracula-inspired, matching Monaco theme) ----------

const DEFAULT_COLOR = '#f8f9fb'

const TOKEN_COLORS: Record<string, string> = {
  // Keywords – purple
  keyword: '#c547f7',
  'control-flow': '#8b5cf6',

  // Storage (var, let, const, function, class)
  'storage-type': '#c547f7',

  // Built-in / support
  builtin: '#8be9fd',

  // Strings – green
  string: '#50fa7b',
  'template-string': '#50fa7b',
  char: '#50fa7b',
  'attr-value': '#50fa7b',
  regex: '#f1fa8c',

  // Numbers – orange
  number: '#bd93f9',

  // Booleans / constants – pink
  boolean: '#bd93f9',
  constant: '#bd93f9',

  // Comments – muted blue-gray
  comment: '#6272a4',
  prolog: '#6272a4',
  doctype: '#6272a4',
  cdata: '#6272a4',

  // Functions – yellow
  function: '#f1fa8c',
  'function-variable': '#f1fa8c',
  method: '#f1fa8c',

  // Classes / types – purple
  'class-name': '#8be9fd',
  'maybe-class-name': '#8be9fd',

  // Variables
  variable: '#f8f8f2',
  parameter: '#ffb86c',
  property: '#f8f8f2',

  // Operators / punctuation – cyan
  operator: '#ff79c6',
  punctuation: '#f8f8f2',

  // Tags (HTML/JSX)
  tag: '#ff79c6',
  'attr-name': '#50fa7b',

  // Decorators / annotations
  decorator: '#f1fa8c',
  annotation: '#f1fa8c',

  // Module / imports
  'module-keyword': '#c547f7',
  imports: '#f8f8f2',

  // Misc
  selector: '#50fa7b',
  'template-punctuation': '#ff79c6',
  'interpolation-punctuation': '#ff79c6',
  'spread': '#ff79c6',
}

function tokenColor(classes: string[]): string {
  // Check from most specific to least specific
  for (const cls of classes) {
    if (cls === 'token') continue
    if (TOKEN_COLORS[cls]) return TOKEN_COLORS[cls]
  }
  // Fallback: check partial matches
  for (const cls of classes) {
    if (cls === 'token') continue
    for (const [key, color] of Object.entries(TOKEN_COLORS)) {
      if (cls.includes(key)) return color
    }
  }
  return DEFAULT_COLOR
}

// ---------- Hast → Flat tokens ----------

interface FlatToken {
  text: string
  classes: string[]
}

type HastNode = {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

function flattenHast(node: HastNode, parentClasses: string[] = []): FlatToken[] {
  if (node.type === 'text') {
    return [{ text: node.value || '', classes: parentClasses }]
  }
  if (node.type === 'element') {
    const classes = [...parentClasses, ...(node.properties?.className || [])]
    return (node.children || []).flatMap((child: HastNode) => flattenHast(child, classes))
  }
  if (node.type === 'root') {
    return (node.children || []).flatMap((child: HastNode) => flattenHast(child, parentClasses))
  }
  return []
}

function splitTokensIntoLines(tokens: FlatToken[]): FlatToken[][] {
  const lines: FlatToken[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      if (parts[i]) {
        lines[lines.length - 1].push({ text: parts[i], classes: token.classes })
      }
    }
  }
  return lines
}

// ---------- Public API ----------

/**
 * Detect language from file path extension.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext) return null

  const lang = EXT_TO_LANG[ext]
  if (!lang) return null

  // Verify it's registered
  if (refractor.registered(lang)) return lang
  return null
}

/**
 * Highlight a full block of code, returning per-line arrays of colored tokens.
 */
export function highlightLines(code: string, language: string | null): HighlightedLine[] {
  if (!language || !refractor.registered(language)) {
    // No highlighting — return plain text lines
    return code.split('\n').map(line => [{ text: line, color: DEFAULT_COLOR }])
  }

  try {
    const root = refractor.highlight(code, language)
    const flatTokens = flattenHast(root as unknown as HastNode)
    const tokenLines = splitTokensIntoLines(flatTokens)

    return tokenLines.map(lineTokens =>
      lineTokens.map(t => ({ text: t.text, color: tokenColor(t.classes) }))
    )
  } catch {
    // Fallback to plain text on any error
    return code.split('\n').map(line => [{ text: line, color: DEFAULT_COLOR }])
  }
}
