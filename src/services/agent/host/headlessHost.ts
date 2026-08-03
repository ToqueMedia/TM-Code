/**
 * Hospedeiro HEADLESS do contrato AgentHost (P5 — docs/DESIGN-HEADLESS-RUNNER.md).
 *
 * O runner (`tm-code --run`) instala isto via setAgentHost ANTES de qualquer
 * run arrancar: não há UI, logo não há diálogos — cada via de decisão humana
 * responde por POLÍTICA, imediatamente:
 *
 *  - permissões: `--yolo` aprova tudo (source 'yolo', como o YOLO da
 *    janela); sem `--yolo`, só o conjunto read-only passa — escrita/execução
 *    é negada com uma razão que o modelo consegue reportar;
 *  - diffs: aprovados em yolo (aplicar é o objectivo de um run delegado),
 *    negados caso contrário;
 *  - credenciais/perguntas: sempre "cancelado" — não há humano; o modelo
 *    recebe a mensagem padrão e decide com bom senso (o prompt já o manda);
 *  - waitForUserGates: resolve já — não existe UI que possa estar aberta.
 *
 * Nunca abre gates humanos no hostBus (não há espera humana), portanto o
 * permissionAwareTimeout conta wall-clock puro — o correcto aqui.
 */

import type { PermissionDecision } from '@/stores/permissionStore'
import type { AgentHost } from './agentHost'

/** Tools sem efeitos de escrita/execução — o que um run sem --yolo pode
 *  fazer. Espelha o espírito do READ_ONLY_TOOL_NAMES do /review; mantido
 *  local para o host não depender do módulo de comandos. */
const HEADLESS_READ_ONLY = new Set([
  'read_file',
  'read_around',
  'list_directory',
  'search_files',
  'glob',
  'read_skill',
  'read_large_result',
  'read_dev_server_logs',
  'lsp',
  'get_project_state_dir',
  'web_fetch',
  'web_search',
  'delegate',
  'collect_results',
  'update_tasks',
  'read_memory',
  'read_session_memory',
  'update_session_memory',
  // Aliases de treino (o executor traduz, mas a decisão vê o nome anunciado)
  'Read',
  'LS',
  'Grep',
  'Glob',
  'Task',
  'WebFetch',
  'WebSearch',
])

function decision(approved: boolean, denyReason?: string): PermissionDecision {
  return {
    approved,
    prompted: false,
    source: 'yolo',
    ...(denyReason ? { denyReason } : {}),
  }
}

export function createHeadlessAgentHost(opts: { yolo: boolean }): AgentHost {
  const { yolo } = opts
  return {
    async canUseTool(toolName, _args, forcePrompt) {
      // Válvula do .env sem --yolo: não há humano para aprovar → nega. COM
      // --yolo aprova, como tudo (decisão do produto 03-08: o YOLO fura
      // tudo; o humano ligou-o explicitamente ao lançar o runner).
      if (forcePrompt === 'env_file' && !yolo) {
        return decision(
          false,
          'headless without --yolo: reading .env needs a human approval — re-run with --yolo or handle it in the window.',
        )
      }
      if (yolo || HEADLESS_READ_ONLY.has(toolName)) return decision(true)
      return decision(
        false,
        `headless run without --yolo: "${toolName}" is not read-only. Re-run with --yolo to allow writes/execution, or limit the task to analysis.`,
      )
    },

    async requestPathAccess(filePath) {
      if (yolo) return decision(true)
      return decision(
        false,
        `headless run without --yolo: access outside the project (${filePath}) requires --yolo.`,
      )
    },

    async approveDiff(toolCallId) {
      // Sem --yolo os writes nem chegam cá (negados no canUseTool).
      if (!yolo) return false
      // Delega no caminho PROVADO da janela: com o YOLO do permissionStore
      // ligado (o condutor liga-o no arranque), createDiffApprovalPromise
      // APLICA o diff ao disco via DiffService.acceptDiff e devolve a
      // verdade da escrita — devolver `true` seco daqui deixava o diff
      // pendente para sempre e o modelo a anunciar ficheiros que o disco
      // nunca viu (eval write-file, 2026-08-03).
      const { createDiffApprovalPromise } = await import('@/stores/chatStore')
      return createDiffApprovalPromise(toolCallId)
    },

    async requestCredentials() {
      return { submitted: false }
    },

    async askUserQuestion() {
      return {}
    },

    async waitForUserGates() {
      /* não há UI — nada pode estar aberto */
    },
  }
}
