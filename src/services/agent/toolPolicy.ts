/**
 * Política de ferramentas — o que sobrou do antigo `toolsetSelector.ts`.
 *
 * O QUE FOI APAGADO E PORQUÊ (2026-07-30)
 * ────────────────────────────────────────
 * Este ficheiro chamava-se `toolsetSelector.ts` e o seu cabeçalho descrevia,
 * no presente, uma selecção dinâmica de ferramentas que poupava "~10K tokens
 * por request". Essa selecção NUNCA CORREU em nenhum run real: a classe
 * `ToolsetSelector` só nascia com `enforceReadOnly`, que exige
 * `auxiliarySelection.readOnly === true`, e nada o produzia — o perfil vem de
 * `profileForSignals` (que devolve só `vision`/`bugfix_local`) e os dois
 * produtores de `intentOverride` (/init e o preflight de TMS) passam
 * `readOnly: false`. Medido na auditoria de 2026-07-29, apagado a 07-30.
 *
 * Com a classe foram embora os grupos de ferramentas (CORE/FILE_OPS/WEB/
 * SUBAGENT/MEMORY/PROVISION), as bases por perfil, e o meta-tool
 * `request_tools` — este último porque só a classe o injectava, portanto o
 * modelo nunca o via e as duas intercepções que respondiam por ele eram
 * inalcançáveis.
 *
 * CONSEQUÊNCIA A NÃO ESQUECER: todas as ferramentas LOCAIS registadas seguem
 * em todos os pedidos. Se um dia isso voltar a doer, a resposta é reintroduzir
 * a selecção com um produtor real e um teste que prove que ela CORRE — não
 * ressuscitar uma classe cuja condição de nascimento nunca se verifica.
 *
 * A doutrina foi honrada a 2026-08-03 para as ferramentas MCP: `ToolSearch`
 * (abaixo) é o sucessor do `request_tools` COM produtor real — o agentService
 * e o parallelTaskRunner injectam-no sempre que há defs MCP diferidos, o
 * bridge de ambos responde-lhe, e os testes em toolExecutor.test.ts
 * ("deferred MCP tool definitions") + deadGateRewiring.test.ts provam que
 * corre. A diferença de desenho face ao antecessor: só difere MCP (os schemas
 * locais são o dialecto de treino e ficam congelados — prefixo de cache
 * intacto), a activação é ADITIVA e dura até ao fim do run (uma quebra de
 * cache no momento da necessidade, nunca o churn
 * entra-num-step-sai-no-seguinte que matou o request_tools), e é o MODELO que
 * decide o que carregar — não um classificador.
 *
 * Três portões de segurança estiveram pendurados nesta classe morta e por
 * isso não guardavam nada (confinação de escrita do bootstrap, bloqueio de
 * destrutivas em runs read-only, auto-apply do TMS.md). Estão todos migrados
 * para sinais alcançáveis e o `deadGateRewiring.test.ts` guarda a doutrina.
 */

import type OpenAI from 'openai'
import {
  EDIT_FILE, WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
} from './toolNames'

/**
 * Tools that mutate the filesystem.
 * Exported so the agent loop can track whether any file mutation occurred
 * during a run (the "stopped without editing" guardrail in query.ts) and so
 * the read-only enforcement in the loop has a canonical list to deny.
 */
export const DESTRUCTIVE_TOOLS = new Set<string>([
  EDIT_FILE, WRITE_FILE, CREATE_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
])

// ── Meta-tool: request_context ───────────────────────────────────────────
//
// Quando o selector de contexto omite secções auxiliares do system prompt,
// este meta-tool deixa o agente ir buscá-las a pedido. O bridge do
// agentService intercepta o nome e devolve o texto da auxiliar como
// tool_result; o toolExecutor nunca o vê. Só é injectado quando há omissões.
//
// AO CONTRÁRIO do `request_tools`, este está VIVO: é injectado directamente
// no agentService (e no parallelTaskRunner), sem passar por classe nenhuma.
// Foi uma regressão apanhada a 2026-07-18 — o índice on-demand prometia uma
// tool inexistente e as secções omitidas ficavam inalcançáveis.
export const REQUEST_CONTEXT_NAME = 'request_context'

export function requestContextDefinition(omittedIds: string[]): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: REQUEST_CONTEXT_NAME,
      description:
        'Request a domain/capability context that was OMITTED from the system prompt to keep it lean. ' +
        'Use the smallest specific context first (for example design_system.semantic_tokens, agent_runtime.mcp_routing, delivery.dev_server, delivery.git_status, project.docs_full for README/PLAN/TODO). ' +
        'TMS.md is already in the system prompt when the project has one — do not re-request it. ' +
        'Use broad project/full contexts only when specific contexts are insufficient. ' +
        'The content is returned as a tool result for you to use this turn. ' +
        'Call ONCE per auxiliary; do not re-request one already returned.',
      parameters: {
        type: 'object',
        properties: {
          auxiliary: {
            type: 'string',
            description:
              'Auxiliary id to load. Available on-demand: ' +
              (omittedIds.length > 0
                ? omittedIds.join(', ')
                : '(none — all context is already loaded)'),
          },
        },
        required: ['auxiliary'],
      },
    },
  }
}

// ── Meta-tool: ToolSearch ────────────────────────────────────────────────
//
// Sucessor do `request_tools` com produtor real (ver o cabeçalho). Os defs
// das ferramentas MCP não viajam em todos os pedidos — na sessão momenu-fact
// de 02-08, 7 tools chakra-ui nunca chamadas seguiram nos 34 pedidos dentro
// de 14,2K tokens de schemas. Nome, schema, formas de query e formato do
// resultado são o CONTRATO DE TREINO do ToolSearch do cli-vaz (porte
// 2026-08-03) — a lição da renomeação de 07-28: adoptar o nome importa o
// contrato. Diferenças deliberadas face ao cli-vaz:
//   - Lá, o defer é server-side (`defer_loading` + tool_reference, Anthropic
//     API). O data-plane do TM fala openai-chat com modelos vários, portanto
//     o equivalente é local: o bridge devolve os schemas no bloco
//     `<functions>` (o formato que o modelo conhece do treino) E empurra os
//     defs para o array vivo do run — o query loop envia o MESMO array por
//     referência em cada pedido, e a activação vale do turno seguinte em
//     diante sem tocar no engine.
//   - Só MCP é diferido. Os schemas locais são o dialecto de treino e ficam
//     congelados o run inteiro (prefixo de cache intacto).
//   - Tools diferidas são anunciadas SÓ PELO NOME na secção MCP do prompt —
//     o A/B de search hints do cli-vaz (exp_xenhnnmn0smrx4) não mostrou
//     benefício.
export const TOOL_SEARCH_NAME = 'ToolSearch'

export interface DeferredToolIndexEntry {
  name: string
  /** Descrição completa — usada para scoring da keyword search, nunca enviada em índices. */
  description: string
}

export function toolSearchDefinition(): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: TOOL_SEARCH_NAME,
      // Texto do contrato de treino (cli-vaz getPrompt), com o location hint
      // adaptado: no TM os nomes diferidos vivem na secção MCP do prompt.
      // Sem interpolações — o def é byte-estável entre runs (cache).
      description:
        'Fetches full schema definitions for deferred tools so they can be called.\n\n' +
        'Deferred tools appear by name in the MCP tools section of the system prompt. ' +
        'Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. ' +
        'This tool takes a query, matches it against the deferred tool list, and returns the matched tools\' complete JSONSchema definitions inside a <functions> block. ' +
        'Once a tool\'s schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.\n\n' +
        'Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.\n\n' +
        'Query forms:\n' +
        '- "select:mcp__server__toolA,mcp__server__toolB" — fetch these exact tools by name\n' +
        '- "theme components" — keyword search, up to max_results best matches\n' +
        '- "+chakra theme" — require "chakra" in the name, rank by remaining terms',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
          },
        },
        required: ['query'],
      },
    },
  }
}

/**
 * Keyword/select search sobre a lista de tools diferidas — porte da
 * searchToolsWithKeywords do cli-vaz (fast path de nome exacto, prefixo
 * mcp__, termos +obrigatórios, scoring por partes do nome > descrição),
 * sem a camada de memoização (a lista aqui é pequena e por run).
 * Função PURA para ser testável sem executor.
 */
export function searchDeferredTools(
  query: string,
  index: DeferredToolIndexEntry[],
  maxResults = 5,
): string[] {
  const queryLower = query.toLowerCase().trim()

  // select:A,B,C — selecção directa por nome exacto.
  const selectMatch = queryLower.match(/^select:(.+)$/i)
  if (selectMatch) {
    const requested = selectMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    const found: string[] = []
    for (const name of requested) {
      const hit = index.find((t) => t.name.toLowerCase() === name)
      if (hit && !found.includes(hit.name)) found.push(hit.name)
    }
    return found
  }

  // Fast path: query é exactamente um nome de tool.
  const exact = index.find((t) => t.name.toLowerCase() === queryLower)
  if (exact) return [exact.name]

  // Prefixo mcp__server — todas as tools desse servidor.
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = index
      .filter((t) => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((t) => t.name)
    if (prefixMatches.length > 0) return prefixMatches
  }

  const terms = queryLower.split(/\s+/).filter(Boolean)
  const required = terms.filter((t) => t.startsWith('+') && t.length > 1).map((t) => t.slice(1))
  const optional = terms.filter((t) => !t.startsWith('+'))
  const scoringTerms = required.length > 0 ? [...required, ...optional] : terms
  if (scoringTerms.length === 0) return []

  const parseName = (name: string): string[] =>
    name.replace(/^mcp__/, '').toLowerCase().split('__').flatMap((p) => p.split('_')).filter(Boolean)

  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const candidates = index.filter((t) => {
    if (required.length === 0) return true
    const parts = parseName(t.name)
    const desc = t.description.toLowerCase()
    return required.every((term) =>
      parts.includes(term) ||
      parts.some((p) => p.includes(term)) ||
      new RegExp(`\\b${escapeRe(term)}\\b`).test(desc),
    )
  })

  return candidates
    .map((t) => {
      const parts = parseName(t.name)
      const full = parts.join(' ')
      const desc = t.description.toLowerCase()
      let score = 0
      for (const term of scoringTerms) {
        if (parts.includes(term)) score += 12
        else if (parts.some((p) => p.includes(term))) score += 6
        if (full.includes(term) && score === 0) score += 3
        if (new RegExp(`\\b${escapeRe(term)}\\b`).test(desc)) score += 2
      }
      return { name: t.name, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.name)
}
