/**
 * Preview de uma escrita para o transcript.
 *
 * 1. Diff do ficheiro inteiro (se ainda estiver no tool call / pending)
 * 2. Hunk do Edit: old_string / new_string — sobrevive ao strip e chega
 *    à UI à medida que o modelo faz stream dos argumentos
 * 3. Conteúdo do Write/Create: input.content
 */

export type WritePreviewSource = 'file' | 'hunk' | 'write'

export interface WritePreview {
  oldContent: string
  newContent: string
  isNewFile: boolean
  source: WritePreviewSource
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function resolveWritePreview(input: {
  diffOld?: string
  diffNew?: string
  isNewFile?: boolean
  args?: Record<string, unknown>
}): WritePreview | null {
  if (input.diffNew !== undefined) {
    return {
      oldContent: input.diffOld ?? '',
      newContent: input.diffNew,
      isNewFile: input.isNewFile === true,
      source: 'file',
    }
  }

  const args = input.args ?? {}
  const oldStr = asString(args.old_string ?? args.oldString ?? args.old_text)
  const newStr = asString(args.new_string ?? args.newString ?? args.new_text)
  if (oldStr !== undefined || newStr !== undefined) {
    return {
      oldContent: oldStr ?? '',
      newContent: newStr ?? '',
      isNewFile: false,
      source: 'hunk',
    }
  }

  const content = asString(args.content)
  if (content !== undefined) {
    return {
      oldContent: '',
      newContent: content,
      isNewFile: true,
      source: 'write',
    }
  }

  return null
}
