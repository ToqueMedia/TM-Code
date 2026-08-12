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
 * `profileForSignals` (que devolve só `vision`/`default_task`) e os dois
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
//   - Diferem-se as MCP e as nativas SITUACIONAIS (critério do cli-vaz: o
//     ciclo de trabalho fica, o situacional difere-se). O núcleo — ler,
//     escrever, editar, procurar, shell — é o dialecto de treino e fica
//     congelado o run inteiro (prefixo de cache intacto).
//   - Tools diferidas são anunciadas SÓ PELO NOME: as MCP na secção MCP, as
//     nativas na secção "Deferred tools" (sharedDeferredToolsBlock). O A/B de
//     search hints do cli-vaz (exp_xenhnnmn0smrx4) não mostrou benefício, e
//     medir descrições no lugar dos schemas deu −1,4% — ruído.
export const TOOL_SEARCH_NAME = 'ToolSearch'

export interface DeferredToolIndexEntry {
  name: string
  /** Descrição completa — usada para scoring da keyword search, nunca enviada em índices. */
  description: string
}

/**
 * Tools NATIVAS diferidas. Porte da regra do cli-vaz (isDeferredTool): **o
 * ciclo de trabalho fica carregado, o situacional difere-se.** Lá são 25 de
 * 40; ficam sempre presentes ler/escrever/editar/procurar/glob/shell/skill/
 * delegar — as que qualquer tarefa usa nos primeiros turnos e cujo schema o
 * modelo já conhece do treino.
 *
 * O critério para acrescentar uma tool a esta lista tem DUAS partes, e a
 * segunda esquece-se: (1) a maioria dos runs nunca a chama; (2) o NOME basta
 * para o modelo desconfiar de que ela serve, porque o nome é tudo o que ele
 * vai ver até a carregar. Uma tool que só se percebe pela descrição fica
 * carregada.
 *
 * NÃO listar aqui tools do ciclo de trabalho por parecerem grandes. O ganho de
 * diferir é o schema; o custo é um turno extra de ToolSearch no momento da
 * necessidade. Para uma tool que quase todos os runs chamam, o custo ganha.
 *
 * Uma entrada que não corresponda a nenhuma tool registada é um ERRO de
 * manutenção (tool renomeada, módulo removido) e é reportada em
 * applyNativeDeferral — sem isso, o nome morto fica aqui a não fazer nada,
 * que é como esta funcionalidade já falhou uma vez.
 */
export const SITUATIONAL_DEFERRED_TOOLS: readonly string[] = [
  'web_search',
  'web_fetch',
  'capture_url_design',
  'enter_worktree',
  'exit_worktree',
  'lsp',
  'ask_user_question',
  'request_credentials',
  'update_tasks',
  'collect_results',
  'generate_image',
  'distill_memory',
  'forget_memory',
  'get_project_state_dir',
  'read_large_result',
]

/**
 * Nomes diferidos NÃO-MCP, para o bloco de anúncio do prompt.
 *
 * As `mcp__*` são diferidas na mesma, mas a secção MCP já as lista com o seu
 * hint de routing por servidor — deixá-las passar aqui punha cada uma DUAS
 * vezes no mesmo prompt.
 */
export function nativeDeferredToolNames(index: ReadonlyArray<{ name: string }>): string[] {
  return index.map(e => e.name).filter(n => !n.startsWith('mcp__'))
}

export function toolSearchDefinition(): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: TOOL_SEARCH_NAME,
      // Texto do contrato de treino (cli-vaz getPrompt), com o location hint
      // adaptado: no TM os nomes diferidos vivem em DUAS secções do prompt —
      // "Deferred tools" (nativas) e a secção MCP.
      // Sem interpolações — o def é byte-estável entre runs (cache).
      description:
        'Fetches full schema definitions for deferred tools so they can be called.\n\n' +
        'Deferred tools appear by name in the "Deferred tools" and "MCP tools" sections of the system prompt. ' +
        'Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. ' +
        'This tool takes a query, matches it against the deferred tool list, and returns the matched tools\' complete JSONSchema definitions inside a <functions> block. ' +
        'Once a tool\'s schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.\n\n' +
        'Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.\n\n' +
        // Os exemplos misturam nativas e MCP DE PROPÓSITO desde que as nativas
        // situacionais passaram a ser diferidas: exemplos só com `mcp__*`
        // ensinam que a tool serve para MCP, e o modelo não a usa para ir
        // buscar o WebFetch.
        'Query forms:\n' +
        '- "select:WebFetch,lsp" — fetch these exact tools by name\n' +
        '- "select:mcp__server__toolA,mcp__server__toolB" — same form for MCP tools\n' +
        '- "fetch a web page" — keyword search, up to max_results best matches\n' +
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
