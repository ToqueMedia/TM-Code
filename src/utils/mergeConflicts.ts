// Parser de marcadores de conflito de merge — porte do modelo do VS Code
// (extensions/merge-conflict/mergeConflictParser): um conflito é
//   <<<<<<< [label atual]
//   ...conteúdo atual...
//   ||||||| [ancestral]        (opcional, diff3)
//   ...conteúdo ancestral...
//   =======
//   ...conteúdo recebido...
//   >>>>>>> [label recebido]
// Puro e sem dependências do Monaco para ser testável em jest.

export interface MergeConflict {
  /** Linha (1-based) do `<<<<<<<`. */
  headerLine: number
  /** Linha (1-based) do `|||||||`, quando o conflito tem bloco ancestral. */
  ancestorsLine?: number
  /** Linha (1-based) do `=======`. */
  splitterLine: number
  /** Linha (1-based) do `>>>>>>>`. */
  footerLine: number
  /** Texto a seguir ao `<<<<<<<` (ex.: HEAD). */
  currentLabel: string
  /** Texto a seguir ao `>>>>>>>` (ex.: feature-branch). */
  incomingLabel: string
}

export type MergeAcceptKind = 'current' | 'incoming' | 'both'

export function parseMergeConflicts(lines: string[]): MergeConflict[] {
  const conflicts: MergeConflict[] = []
  let header = -1
  let ancestors = -1
  let splitter = -1
  let currentLabel = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('<<<<<<<')) {
      // Um novo header reinicia qualquer conflito malformado em curso.
      header = i + 1
      ancestors = -1
      splitter = -1
      currentLabel = line.slice(7).trim()
    } else if (line.startsWith('|||||||') && header > 0 && splitter < 0 && ancestors < 0) {
      ancestors = i + 1
    } else if (/^=======\s*$/.test(line) && header > 0 && splitter < 0) {
      splitter = i + 1
    } else if (line.startsWith('>>>>>>>') && header > 0 && splitter > 0) {
      conflicts.push({
        headerLine: header,
        ancestorsLine: ancestors > 0 ? ancestors : undefined,
        splitterLine: splitter,
        footerLine: i + 1,
        currentLabel,
        incomingLabel: line.slice(7).trim(),
      })
      header = -1
      ancestors = -1
      splitter = -1
      currentLabel = ''
    }
  }
  return conflicts
}

/**
 * Texto que substitui o bloco de conflito inteiro (header..footer) quando o
 * developer aceita uma das versões — a semântica dos comandos Accept
 * Current/Incoming/Both do VS Code.
 */
export function resolvedTextFor(lines: string[], conflict: MergeConflict, kind: MergeAcceptKind): string {
  const currentEnd = (conflict.ancestorsLine ?? conflict.splitterLine) - 1
  const current = lines.slice(conflict.headerLine, currentEnd)
  const incoming = lines.slice(conflict.splitterLine, conflict.footerLine - 1)
  const kept = kind === 'current' ? current : kind === 'incoming' ? incoming : [...current, ...incoming]
  return kept.join('\n')
}
