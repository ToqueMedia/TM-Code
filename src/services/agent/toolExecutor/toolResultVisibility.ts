/**
 * Tool-result visibility registry — a camada de coordenação entre a EVICÇÃO
 * de contexto (toolResultGlobalBudget, autoCompact, snip de emergência) e a
 * SUPRESSÃO de releituras (dedup exato + overlap).
 *
 * PORQUÊ (raiz da "dança do force: true", 2026-07-13)
 * ───────────────────────────────────────────────────
 * As duas camadas tinham modelos do mundo contraditórios e nunca falavam
 * entre si:
 *
 *   - O pipeline de contexto (query.ts) compacta tool_results antigos para
 *     sumários e diz ao modelo "Re-read via Read on <path> if needed".
 *   - O dedup de leituras (readDedup / readRangeTracker) bloqueava exatamente
 *     essa releitura com um stub que afirmava "the content you previously
 *     read is still current in the conversation" — FALSO quando o pipeline
 *     já o tinha despejado — e mandava o modelo gastar MAIS um turno com
 *     `force: true` para recuperar o que o próprio sistema apagou.
 *
 * Cada recuperação custava 1–2 round-trips completos ao provider (a conversa
 * inteira re-enviada). Este registo torna o dedup VERDADEIRO: um stub só é
 * devolvido quando o tool_result que contém o conteúdo seguiu INTACTO no
 * último pedido ao provider; caso contrário o read serve o conteúdo
 * diretamente, sem turno extra.
 *
 * COMO
 * ────
 * query.ts chama `updateToolResultVisibility(historyMessages, sentMessages)`
 * imediatamente antes de construir o payload de cada pedido:
 *
 *   - `sentMessages` é o array EXATO que segue para o provider (pós budget /
 *     collapse / autoCompact / snip / compactação de mention-context).
 *   - `historyMessages` é o histórico canónico do loop — delimita QUAIS
 *     toolCallIds pertencem a ESTE loop. Ids de outros loops concorrentes
 *     (sub-agentes partilham estes singletons de módulo) nunca aparecem no
 *     histórico deste loop e ficam intocados — cada loop só reclassifica os
 *     seus próprios resultados.
 *
 * Um tool_result conta como INTACTO quando o seu content não foi substituído
 * por um marcador de compactação. Ids ausentes de `sentMessages` mas presentes
 * no histórico (removidos por autoCompact/snip) ficam explicitamente NÃO
 * visíveis.
 *
 * Default deliberado: id desconhecido → visível (true). Cobre (a) releituras
 * no MESMO turno de um read acabado de executar (o resultado vai intacto no
 * próximo pedido — o stub é correto) e (b) entradas sem toolCallId (mentions,
 * caminhos legados) — comportamento antigo preservado. O primeiro update()
 * de cada pedido reclassifica tudo o que está no histórico, por isso o
 * default só vive dentro de um turno.
 *
 * Singleton de módulo (como readRangeTracker/fsVersion): o ToolExecutor
 * consulta, query.ts alimenta. Limpo em resetSessionState().
 */

import type { ContentBlockAPI } from '../../../types/chat'
import { CLEARED_MESSAGE } from '../compact/microcompact'

// ── Marcadores de compactação ────────────────────────────────────────────

/** Prefixo do sumário estruturado do toolResultGlobalBudget. */
const GLOBAL_BUDGET_SUMMARY_PREFIX = '[tool-result-summary]'

/** Marcador de truncagem do budget per-message (compact/toolResultBudget). */
const PER_MESSAGE_TRUNCATED_MARKER = '[... content truncated by tool result budget ...]'

/**
 * True quando o content de um tool_result já NÃO é o corpo integral que o
 * tool devolveu — foi sumarizado, limpo ou truncado por alguma camada de
 * gestão de contexto. Conteúdo truncado conta como não-intacto: a direção
 * segura é servir o conteúdo numa releitura, nunca fazer stub de algo que o
 * modelo só viu parcialmente.
 */
function isCompactedToolResultContent(content: string): boolean {
  return (
    content.startsWith(GLOBAL_BUDGET_SUMMARY_PREFIX) ||
    content === CLEARED_MESSAGE ||
    content.includes(PER_MESSAGE_TRUNCATED_MARKER)
  )
}

// ── Estado (singleton de módulo) ─────────────────────────────────────────

interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

/** toolCallId → o último pedido enviou este tool_result intacto? */
const visibility = new Map<string, boolean>()

/** Recolhe todos os toolCallIds de tool_results num array de mensagens. */
function collectToolResultIds(
  messages: MessageLike[],
  onEach?: (id: string, content: string) => void,
): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as ContentBlockAPI[]) {
      if (block.type !== 'tool_result') continue
      ids.add(block.toolCallId)
      if (onEach) {
        const content = typeof block.content === 'string' ? block.content : ''
        onEach(block.toolCallId, content)
      }
    }
  }
  return ids
}

// ── API ──────────────────────────────────────────────────────────────────

/**
 * Reclassifica a visibilidade dos tool_results DESTE loop com base no payload
 * que está prestes a ser enviado. Chamado por query.ts uma vez por pedido.
 *
 * @param historyMessages Histórico canónico do loop (delimita os ids a
 *                        reclassificar — ids de outros loops ficam intocados).
 * @param sentMessages    O array exato que segue para o provider.
 */
export function updateToolResultVisibility(
  historyMessages: MessageLike[],
  sentMessages: MessageLike[],
): void {
  const intact = new Set<string>()
  collectToolResultIds(sentMessages, (id, content) => {
    if (!isCompactedToolResultContent(content)) intact.add(id)
  })
  const owned = collectToolResultIds(historyMessages)
  for (const id of owned) {
    visibility.set(id, intact.has(id))
  }
}

/**
 * O tool_result deste toolCallId seguiu intacto no último pedido? Ids nunca
 * classificados devolvem true (ver "Default deliberado" no cabeçalho).
 */
export function isToolResultContextVisible(toolCallId: string | undefined): boolean {
  if (!toolCallId) return true
  return visibility.get(toolCallId) ?? true
}

/** Limpa o registo. Chamado em resetSessionState(). */
export function clearToolResultVisibility(): void {
  visibility.clear()
}
