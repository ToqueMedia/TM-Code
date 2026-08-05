import { useChatStore } from '../../../stores/chatStore'
import { getActiveContextWindow } from '../activeContextWindow'
import {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  getToolResultBudgetTokens,
} from '../../../utils/contextWindow'
import type { RequestUsageEntry } from '../../../types/chat'

/**
 * `/context` — o que está a ocupar a janela, agora.
 *
 * PORQUÊ EXISTE
 * ─────────────
 * A pílula de pressão responde "quanto falta"; não responde "porquê". Numa
 * sessão longa a pergunta útil é a segunda: são os tool results? é o system
 * prompt? são os schemas das tools? — porque cada uma tem uma ação diferente
 * (compactar, tirar uma secção auxiliar, reduzir o toolset).
 *
 * O TM Code já recolhia TUDO isto por pedido (payloadInspector →
 * `session.requestUsageLog`), incluindo coisas que o /context do claude-vaz não
 * tem: as maiores secções do system prompt e os hashes por mensagem que
 * diagnosticam quedas de cache. O que faltava era a superfície. Este comando é
 * só leitura — não fala com o modelo, não gasta tokens.
 *
 * As percentagens são sobre a janela EFETIVA (bruta menos a reserva do sumário),
 * o mesmo denominador da pílula e do limiar de auto-compactação, para os três
 * números nunca se contradizerem.
 */
export async function executeContext(): Promise<void> {
  const chatStore = useChatStore.getState()
  const session = chatStore.getActiveSession()
  const last = session?.requestUsageLog?.[session.requestUsageLog.length - 1]

  if (!last) {
    chatStore.addSystemMessage(
      'Ainda não há pedidos nesta sessão — o mapa do contexto aparece depois da primeira resposta do modelo.',
    )
    return
  }

  chatStore.addSystemMessage(renderContextReport(last))
}

/** Resolve a janela ativa pela MESMA cadeia que o pill e o runtime.
 *
 *  Este comentário prometia "a mesma ordem que o resto da app" e era falso:
 *  ignorava BYOK e persona, por isso numa sessão de 1M lia contra 200K e
 *  imprimia "94% cheio" onde o pill mostrava 19% — e o "auto-compacta aos X"
 *  não era o limiar por que o agente compactava (auditoria 05-08). */
function resolveWindow(): { window: number; maxOutput: number | null; modelName: string } {
  const { contextWindow, maxOutputTokens, modelName } = getActiveContextWindow()
  return { window: contextWindow, maxOutput: maxOutputTokens, modelName }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Barra de proporção em blocos — legível em texto monoespaçado. */
function bar(fraction: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Etiquetas legíveis para as categorias do payloadInspector. */
const CATEGORY_LABELS: Record<string, string> = {
  system: 'System prompt',
  tool_result: 'Resultados de tools',
  tool_call: 'Chamadas de tools',
  text: 'Conversa (texto)',
  thinking: 'Raciocínio',
  mention_context: 'Contexto de @menções',
  image: 'Imagens',
  unknown: 'Outro',
}

export function renderContextReport(entry: RequestUsageEntry): string {
  const { window, maxOutput, modelName } = resolveWindow()
  const effective = getEffectiveContextWindowSize(window, maxOutput)
  const threshold = getAutoCompactThreshold(window, maxOutput)
  const toolBudget = getToolResultBudgetTokens(window, maxOutput)

  // O real do provider manda; a estimativa só entra quando não houve usage.
  const occupied = entry.usageAvailable === false
    ? entry.estimatedInputTokens
    : entry.inputTokens
  const pct = effective > 0 ? occupied / effective : 0

  const lines: string[] = []
  lines.push(`# Mapa do contexto — ${modelName}`)
  lines.push('')
  lines.push(
    `Janela ${fmt(window)} · efetiva ${fmt(effective)} (menos a reserva do sumário) · auto-compactação aos ${fmt(threshold)}`,
  )
  lines.push('')
  lines.push(`\`${bar(pct)}\` ${Math.round(pct * 100)}% — ${fmt(occupied)} de ${fmt(effective)}`)
  if (entry.usageAvailable === false) {
    lines.push('')
    lines.push('_O provider não devolveu contagem neste pedido; os números são a estimativa do inspector._')
  }
  lines.push('')

  // ── Repartição ──
  const rows = Object.entries(entry.breakdown ?? {})
    .map(([key, v]) => ({ key, tokens: v.tokens, blocks: v.blocks }))
    .filter(r => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  const defsTokens = entry.toolDefsTokens ?? 0
  if (defsTokens > 0) {
    rows.push({
      key: 'tool_defs',
      tokens: defsTokens,
      blocks: entry.toolCount ?? 0,
    })
  }
  rows.sort((a, b) => b.tokens - a.tokens)

  const totalCounted = rows.reduce((s, r) => s + r.tokens, 0) || 1

  lines.push('## Onde estão os tokens')
  lines.push('')
  for (const r of rows) {
    const label = r.key === 'tool_defs'
      ? `Schemas de tools (${entry.toolCount ?? '?'}${entry.toolCountTotal ? ` de ${entry.toolCountTotal}` : ''})`
      : CATEGORY_LABELS[r.key] ?? r.key
    const share = r.tokens / totalCounted
    lines.push(`- \`${bar(share, 16)}\` **${fmt(r.tokens)}** · ${label}`)
  }

  // O orçamento de tool results segue a janela — dizer onde está ajuda a
  // perceber porque é que resultados antigos aparecem resumidos.
  const toolResultTokens = entry.breakdown?.tool_result?.tokens ?? 0
  if (toolBudget > 0) {
    lines.push('')
    lines.push(
      `Orçamento de resultados de tools: ${fmt(toolResultTokens)} / ${fmt(toolBudget)} ` +
      `(30% da janela efetiva). Acima disso, os mais antigos passam a resumo estruturado — ` +
      `continuam relegíveis com \`read_file\` / \`read_large_result\`.`,
    )
  }

  // ── Maiores secções do system prompt ──
  const sections = (entry.systemPromptSections ?? [])
    .slice()
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8)
  if (sections.length > 0) {
    lines.push('')
    lines.push('## Maiores secções do system prompt')
    lines.push('')
    for (const s of sections) {
      // `static` vive no prefixo cacheável; `dynamic` é reconstruído a cada
      // turno e paga preço cheio — a distinção é o que torna a lista acionável.
      lines.push(`- **${fmt(s.tokens)}** · ${s.name} _(${s.location === 'static' ? 'cacheável' : 'por turno'})_`)
    }
  }

  // ── Cache ──
  const cacheRead = entry.cacheReadInputTokens ?? 0
  const cacheWrite = entry.cacheCreationInputTokens ?? 0
  if (cacheRead > 0 || cacheWrite > 0) {
    const denom = cacheRead + cacheWrite + (entry.inputTokens || 0)
    lines.push('')
    lines.push('## Cache de prefixo')
    lines.push('')
    lines.push(
      `Lido ${fmt(cacheRead)} · escrito ${fmt(cacheWrite)}` +
      (denom > 0 ? ` · ${Math.round((cacheRead / denom) * 100)}% do pedido veio de cache` : ''),
    )
  }

  if (entry.occupancySource) {
    const how = entry.occupancySource === 'anchored'
      ? 'ancorada no real do turno anterior + estimativa do que veio depois'
      : entry.occupancySource === 'estimate-only'
        ? 'só estimativa (primeiro turno, ainda sem resposta do provider)'
        : 'fallback: o maior entre estimativa e real (âncora inutilizável)'
    lines.push('')
    lines.push(`_Decisão de compactação ${how}._`)
  }

  return lines.join('\n')
}
