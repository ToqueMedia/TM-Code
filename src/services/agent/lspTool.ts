// The `lsp` agent tool — precise code intelligence over TypeScript/JavaScript
// via the SAME Monaco TS worker the editor uses (claude-vaz LSPTool contract,
// TS/JS subset + `diagnostics`). This is what upgrades the model from
// grep-and-guess to compiler-grade answers: where a symbol is defined, who
// uses it, what its type is, and whether a file type-checks after an edit —
// each in one cheap call instead of several speculative reads.
//
// Formatting lives here as PURE functions (unit-testable in jsdom); all the
// Monaco access lives in typescriptLspService and is imported lazily so this
// module never drags the editor bundle into the agent graph at load time.

export type LspOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'diagnostics'

export const LSP_OPERATIONS: readonly LspOperation[] = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'diagnostics',
]

const POSITIONAL_OPS = new Set<LspOperation>(['goToDefinition', 'findReferences', 'hover'])

export interface LspLocation {
  path: string
  line: number
  column: number
  preview: string
}

export interface LspSymbol {
  name: string
  kind: string
  line: number
  depth: number
}

export interface LspDiagnostic {
  line: number
  column: number
  message: string
  severity: 'error' | 'warning' | 'info'
  code: number
}

// ── Pure formatters ─────────────────────────────────────────────────────────

export function formatLocations(operation: LspOperation, locations: LspLocation[]): string {
  if (locations.length === 0) {
    return operation === 'findReferences'
      ? 'No references found in the files loaded so far. For an exhaustive project-wide search, use grep.'
      : 'No definition found at that position. Check that line/character point AT the symbol (1-based, as shown by read_file).'
  }
  const header =
    operation === 'findReferences'
      ? `${locations.length} reference(s) (within files loaded so far — use grep for exhaustive search):`
      : `${locations.length} definition(s):`
  const body = locations
    .map((loc) => `${loc.path}:${loc.line}:${loc.column} — ${loc.preview}`)
    .join('\n')
  return `${header}\n${body}`
}

export function formatHover(filePath: string, line: number, character: number, hover: string | null): string {
  if (!hover) {
    return `No type information at ${filePath}:${line}:${character}. Check that the position points AT a symbol.`
  }
  return hover
}

export function formatSymbols(filePath: string, symbols: LspSymbol[]): string {
  if (symbols.length === 0) return `No symbols found in ${filePath}.`
  const body = symbols
    .map((s) => `${'  '.repeat(Math.min(s.depth, 6))}${s.kind} ${s.name} — :${s.line}`)
    .join('\n')
  return `${symbols.length} symbol(s) in ${filePath}:\n${body}`
}

export function formatDiagnostics(filePath: string, diags: LspDiagnostic[]): string {
  if (diags.length === 0) return `No TypeScript/JavaScript errors in ${filePath}.`
  const errors = diags.filter((d) => d.severity === 'error').length
  const warnings = diags.filter((d) => d.severity === 'warning').length
  const body = diags
    .slice(0, 50)
    .map((d) => `:${d.line}:${d.column} ${d.severity} TS${d.code} — ${d.message}`)
    .join('\n')
  const truncated = diags.length > 50 ? `\n(+${diags.length - 50} more)` : ''
  return `${filePath}: ${errors} error(s), ${warnings} warning(s)\n${body}${truncated}`
}

// ── Input validation ────────────────────────────────────────────────────────

export interface LspToolInput {
  operation: LspOperation
  file_path: string
  line?: number
  character?: number
}

/** Returns an error string, or null when the input is valid. */
export function validateLspInput(input: Partial<LspToolInput>): string | null {
  if (!input.operation || !LSP_OPERATIONS.includes(input.operation as LspOperation)) {
    return `Error: lsp requires operation ∈ {${LSP_OPERATIONS.join(', ')}}.`
  }
  if (!input.file_path) return 'Error: lsp requires file_path.'
  if (POSITIONAL_OPS.has(input.operation as LspOperation)) {
    const okInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1
    if (!okInt(input.line) || !okInt(input.character)) {
      return `Error: ${input.operation} requires 1-based integer \`line\` and \`character\` pointing AT the symbol (as shown by read_file).`
    }
  }
  return null
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * Run an lsp operation. `filePath` must already be absolute + access-checked
 * by the executor. `projectRoot` initializes the language service on demand
 * (cwd-scoped runs where the editor never booted it).
 */
export async function executeLspTool(input: LspToolInput, projectRoot: string): Promise<string> {
  const invalid = validateLspInput(input)
  if (invalid) return invalid

  const { default: TypeScriptLspService } = await import('../typescriptLspService')
  const svc = TypeScriptLspService.getInstance()
  if (!svc.ready) {
    await svc.initialize(projectRoot)
  }

  const { operation, file_path: filePath, line = 1, character = 1 } = input
  try {
    switch (operation) {
      case 'goToDefinition':
        return formatLocations(operation, await svc.definitionAt(filePath, line, character))
      case 'findReferences':
        return formatLocations(operation, await svc.referencesAt(filePath, line, character))
      case 'hover':
        return formatHover(filePath, line, character, await svc.hoverAt(filePath, line, character))
      case 'documentSymbol':
        return formatSymbols(filePath, await svc.documentSymbols(filePath))
      case 'diagnostics':
        return formatDiagnostics(filePath, await svc.getDiagnostics(filePath))
    }
  } catch (err) {
    return `Error: lsp ${operation} failed — ${err instanceof Error ? err.message : String(err)}`
  }
}
