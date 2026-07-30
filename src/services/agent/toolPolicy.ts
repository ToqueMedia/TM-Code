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
 * CONSEQUÊNCIA A NÃO ESQUECER: todas as ferramentas registadas seguem em
 * todos os pedidos. Se um dia isso voltar a doer, a resposta é reintroduzir a
 * selecção com um produtor real e um teste que prove que ela CORRE — não
 * ressuscitar uma classe cuja condição de nascimento nunca se verifica.
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
