/**
 * Gate de typecheck FINAL — injetado como USER MESSAGE DIRETA (não
 * `<system-reminder>`) quando o modelo para sem tool calls depois de editar.
 *
 * PORQUÊ: o `editDiagnostics` já corre `tsc --noEmit` inter-turno e entrega o
 * delta via `<system-reminder>` — mas (a) o `<system-reminder>` é um canal
 * que o modelo PODE ignorar, (b) no TURNO TERMINAL (modelo para sem tool
 * calls) o `collectInterTurnContext` NÃO corre — o `dirty` fica por avaliar,
 * e (c) o delta reportado é o da última ronda, não o estado final. O caso
 * falhado medido: o modelo introduz `VStack is not defined` (TS2304), diz
 * "done" e termina — o erro nunca chega ao modelo, porque não há ronda de
 * tool results para o levar a vê-lo.
 *
 * Este gate roda UMA vez na saída (no `query.ts`, imediatamente antes do
 * guardrail do task tracker): o caller chama `markProjectEdited()` (põe o
 * `dirty` do editDiagnostics) e `collectNewDiagnostics(root)` (delta vs
 * baseline — NÃO reporta erros pré-existentes do projeto do developer). Se
 * houver erros, injeta uma user message explícita (não `<system-reminder>` —
 * não ignorável) e faz `continue` para forçar uma ronda de correção. Uma
 * ronda só: se o modelo não corrigir, o run termina com os erros por
 * resolver — preferível a um loop infinito, e melhor do que o silêncio
 * atual (o modelo que introduziu o erro nunca o chega a ver).
 *
 * Partilha a FORMATAÇÃO do `formatDiagnosticsReminder` (editDiagnostics),
 * mas SEM a marca `<system-reminder>` e com um imperativo que não deixa
 * margem para interpretar como "dica opcional". Só errors: warnings não
 * impedem a compilação e não justificam segurar o run.
 */
import type { EditDiagnostic } from './editDiagnostics'

/** Teto do texto entregue — paridade com o inter-turno (`MAX_SHOWN` lá). */
const MAX_SHOWN = 12

/** Há ALGUM erro de severidade 'error'? Warnings não bloqueiam o run. */
export function hasTypeErrors(found: EditDiagnostic[]): boolean {
  return found.some((d) => d.severity === 'error')
}

/**
 * Texto da user message FINAL de typecheck, como o MODELO o vê. SEM a marca
 * `<system-reminder>`: é uma mensagem direta no mesmo canal das tool results
 * e do steering — não um anexo que o modelo pode dispensar. O caller injeta
 * isto como `role: "user"` e faz `continue` para forçar a correção.
 *
 * Filtra SÓ errors (warnings são informativos e não impedem o run de
 * terminar). Devolve string vazia quando não há errors — o caller não deve
 * injetar nada nesse caso.
 */
export function formatFinalTypecheckReminder(
  found: EditDiagnostic[],
  projectRoot = '',
): string {
  const errors = found.filter((d) => d.severity === 'error')
  if (errors.length === 0) return ''
  const rel = (p: string) =>
    projectRoot && p.startsWith(projectRoot)
      ? p.slice(projectRoot.length).replace(/^[/\\]/, '')
      : p
  const shown = errors.slice(0, MAX_SHOWN)
  const body = shown
    .map((d) => `  ✗ ${rel(d.file)}:${d.line}:${d.column} — ${d.message} (TS${d.code})`)
    .join('\n')
  const more = errors.length > MAX_SHOWN ? `\n  …+${errors.length - MAX_SHOWN} more` : ''
  return (
    `The project does not typecheck after your edits. ` +
    `\`tsc --noEmit\` reports ${errors.length} error${errors.length === 1 ? '' : 's'} ` +
    `that were NOT present before this run:\n${body}${more}\n\n` +
    `Fix every error above now — a file that does not compile is not done. ` +
    `This is the project's own type checker, not a guess; do not end the run ` +
    `until \`tsc\` is clean for the files you touched.`
  )
}
