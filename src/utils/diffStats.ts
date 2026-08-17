import { diffLines } from 'diff'

/**
 * Contagens persistíveis de um diff (+N / −M).
 *
 * O conteúdo completo (`diffOldContent` / `diffNewContent`) é libertado
 * depois de o diff ser aprovado ou recusado — duas cópias do ficheiro
 * inchavam a sessão em dezenas de MB. Os números cabem em 8 bytes e são
 * o que o header compacto precisa depois de reabrir o projecto.
 */
export function countDiffLineStats(
  oldContent: string,
  newContent: string,
  isNewFile = false,
): { added: number; removed: number } {
  if (isNewFile) {
    if (!newContent) return { added: 0, removed: 0 }
    return { added: newContent.replace(/\n$/, '').split('\n').length, removed: 0 }
  }
  let added = 0
  let removed = 0
  for (const change of diffLines(oldContent, newContent)) {
    const n = change.value.replace(/\n$/, '').split('\n').length
    if (change.added) added += n
    else if (change.removed) removed += n
  }
  return { added, removed }
}
