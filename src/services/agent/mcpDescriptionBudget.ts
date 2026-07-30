/**
 * Orçamento das descrições de ferramentas MCP.
 *
 * PORQUE EXISTE
 * ─────────────
 * A descrição de uma ferramenta MCP é o único texto do prompt que NÃO foi
 * escrito nem revisto por este repo: vem do servidor externo que o developer
 * ligou. E entra em todos os pedidos, por duas vias independentes:
 *
 *   1. `ToolExecutor.registerMCPTools` → tool definitions da API (o peso real);
 *   2. `sharedMcpBlock` → secção `agent_runtime.mcp_routing` do system prompt.
 *
 * Um servidor gerado a partir de uma spec OpenAPI traz rotineiramente dezenas
 * de milhares de caracteres. Sem teto, ligar um MCP degrada silenciosamente
 * todos os turnos da sessão — e o custo não aparece em lado nenhum da UI.
 *
 * TRÊS TETOS, NUNCA SILENCIOSOS
 * ──────────────────────────────
 * Por ferramenta, por servidor e no agregado. Um corte silencioso seria pior
 * que o problema: o modelo trataria meia descrição como a especificação
 * inteira. Todo o corte deixa marca legível, e uma descrição inteiramente
 * omitida diz porquê e nomeia a ferramenta, para o modelo saber que ela
 * existe e poder perguntar em vez de assumir que não existe.
 *
 * ÂMBITO — LÊ ANTES DE ALARGAR
 * ─────────────────────────────
 * Só a DESCRIÇÃO é limitada. O `input_schema` fica intacto de propósito: é
 * JSON estruturado que o provider valida, e cortá-lo por caracteres dava um
 * schema INVÁLIDO em vez de um schema mais pequeno — a chamada da ferramenta
 * passaria a falhar em vez de ficar mais barata. Reduzir schemas gordos exige
 * podar propriedades com conhecimento da forma, não truncar texto.
 *
 * Isto é economia de contexto e de cache — NÃO é defesa contra prompt
 * injection. Truncar uma descrição maliciosa a 1500 chars deixa 1500 chars de
 * injecção. Quem quiser tratar o risco de instruções vindas de integrações
 * externas tem de o fazer noutro sítio; não te fies neste módulo para isso.
 */

import {
  MCP_TOOL_DESCRIPTION_MAX_CHARS,
  MCP_SERVER_DESCRIPTIONS_MAX_CHARS,
  MCP_TOTAL_DESCRIPTIONS_MAX_CHARS,
} from './agentConfig'

/** Forma mínima partilhada por MCPTool (toolExecutor) e MCPToolSummary (prompt). */
export interface McpDescribable {
  serverName: string
  name: string
  description: string
}

export interface McpBudgetStats {
  /** Ferramentas cuja descrição foi cortada a meio. */
  truncated: number
  /** Ferramentas cuja descrição foi inteiramente omitida por teto agregado. */
  omitted: number
  /** Total de caracteres de descrição depois do orçamento. */
  totalChars: number
}

/** Corta uma descrição isolada, deixando marca. Exportado para uso directo. */
export function capMcpDescription(
  description: string,
  maxChars: number = MCP_TOOL_DESCRIPTION_MAX_CHARS,
): string {
  if (description.length <= maxChars) return description
  return (
    `${description.slice(0, maxChars).trimEnd()}\n` +
    `…[descrição MCP truncada: ${description.length} → ${maxChars} chars]`
  )
}

function omissionNotice(serverName: string, name: string): string {
  return `[descrição MCP omitida (teto de contexto atingido) — a ferramenta mcp__${serverName}__${name} EXISTE e pode ser chamada; pergunta ao developer o que ela faz em vez de assumir.]`
}

/**
 * Aplica os três tetos por ordem de chegada e devolve cópias com a descrição
 * já orçamentada. Não muta a entrada.
 *
 * A ordem da lista é a ordem de prioridade: as primeiras ferramentas de cada
 * servidor ficam com descrição real, as que excedem o teto ficam com a nota
 * de omissão. Determinístico para uma dada ordem de entrada.
 */
export function budgetMcpDescriptions<T extends McpDescribable>(
  tools: readonly T[],
): { tools: T[]; stats: McpBudgetStats } {
  const perServerUsed = new Map<string, number>()
  let totalUsed = 0
  const stats: McpBudgetStats = { truncated: 0, omitted: 0, totalChars: 0 }

  const out = tools.map(tool => {
    const original = tool.description ?? ''
    const capped = capMcpDescription(original)
    const serverUsed = perServerUsed.get(tool.serverName) ?? 0

    const fitsServer = serverUsed + capped.length <= MCP_SERVER_DESCRIPTIONS_MAX_CHARS
    const fitsTotal = totalUsed + capped.length <= MCP_TOTAL_DESCRIPTIONS_MAX_CHARS

    if (!fitsServer || !fitsTotal) {
      const notice = omissionNotice(tool.serverName, tool.name)
      stats.omitted++
      stats.totalChars += notice.length
      // A nota de omissão conta para o total mas NÃO para o teto do servidor:
      // caso contrário um servidor no limite parava de emitir até a própria
      // nota, e as ferramentas restantes desapareciam sem deixar rasto.
      totalUsed += notice.length
      return { ...tool, description: notice }
    }

    if (capped.length !== original.length) stats.truncated++
    perServerUsed.set(tool.serverName, serverUsed + capped.length)
    totalUsed += capped.length
    stats.totalChars += capped.length
    return { ...tool, description: capped }
  })

  return { tools: out, stats }
}
