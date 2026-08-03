/**
 * AgentHost — o contrato entre o núcleo do agente e quem o hospeda (P2 do
 * docs/DESIGN-HEADLESS-RUNNER.md, 2026-08-03).
 *
 * As QUATRO esperas por decisão humana do inventário headless (permissões de
 * tool, acesso a caminhos, aprovação de diffs, credenciais/perguntas) e o gate
 * global de interacção (`waitForUserGates`) passam por aqui. A implementação-
 * janela (windowHost.createWindowAgentHost) delega nas stores exactamente como
 * os call sites faziam inline até 2026-08-03; um hospedeiro headless ou de
 * teste instala-se com `setAgentHost` e responde às mesmas vias sem React nem
 * DOM.
 *
 * Este módulo importa APENAS tipos das stores (apagados na compilação) — o
 * runtime do renderer nunca entra por aqui; entra pelo windowHost, e só quando
 * um método é de facto chamado (imports dinâmicos).
 */

import type {
  PermissionDecision,
  PermissionOrigin,
  PromptReason,
} from '@/stores/permissionStore'
import { createWindowAgentHost } from './windowHost'

export interface HostCredentialField {
  id: string
  label: string
  type: 'text' | 'password'
  required: boolean
  helperText?: string
}

export interface HostTaskOrigin {
  taskId: string
  label: string
  sessionId?: string
}

export interface HostUserQuestion {
  question: string
  header: string
  // description opcional — espelha o que o interactionOps constrói (a store
  // sempre aceitou opções sem descrição).
  options: { label: string; description?: string }[]
  multiSelect: boolean
}

/** Âmbito do gate de interacção — espelha o gateIsMine do executor (F2 MDI:
 *  um diálogo do projecto A não pode congelar um run do projecto B). */
export interface HostGateScope {
  projectId: string | null
  taskId: string | null
}

export interface AgentHost {
  /** Política + prompt de permissão de tool. Assinatura espelha
   *  permissionStore.requestPermission (a separação política/prompt em módulo
   *  puro é o residual da P2 — ver design doc). */
  canUseTool(
    toolName: string,
    args: Record<string, unknown>,
    forcePrompt?: boolean | PromptReason,
    origin?: PermissionOrigin,
  ): Promise<PermissionDecision>

  /** Acesso a um caminho fora dos roots permitidos; aprovado = grant durável
   *  no âmbito certo (projectId opcional para runs de projecto em fundo). */
  requestPathAccess(
    filePath: string,
    directoryToAdd: string,
    projectId?: string | null,
  ): Promise<PermissionDecision>

  /** true = diff aprovado pelo humano (ou auto-aprovação da janela: YOLO /
   *  autoApproveDiffs). Janela: createDiffApprovalPromise do chatStore. */
  approveDiff(toolCallId: string): Promise<boolean>

  /** Ronda humana completa de credenciais: pedido + card + corrida com o
   *  abort + lifecycle do card. `{submitted:false}` = cancelado/abortado. */
  requestCredentials(req: {
    serviceName: string
    fields: HostCredentialField[]
    projectRoot: string
    taskOrigin: HostTaskOrigin | null
    signal?: AbortSignal
  }): Promise<{ submitted: boolean; keys?: string[] }>

  /** Ronda humana completa de perguntas estruturadas. Objecto vazio = user
   *  cancelou (semântica pré-existente do fluxo). */
  askUserQuestion(req: {
    questions: HostUserQuestion[]
    projectRoot: string
    taskOrigin: HostTaskOrigin | null
    signal?: AbortSignal
  }): Promise<Record<string, string | string[]>>

  /** Bloqueia enquanto houver interacção humana pendente PARA ESTE âmbito.
   *  Janela: poll de 120ms sobre as 4 stores (comportamento herdado);
   *  headless: resolve imediatamente (não há UI que possa estar aberta). */
  waitForUserGates(
    scope: HostGateScope,
    opts?: { signal?: AbortSignal; toolUseId?: string },
  ): Promise<void>
}

let current: AgentHost | null = null

/** Instala um hospedeiro (headless/testes). `null` repõe o default-janela. */
export function setAgentHost(host: AgentHost | null): void {
  current = host
}

/** O hospedeiro activo. Sem instalação explícita o default é a janela —
 *  criado lazy, e as dependências de renderer só carregam quando um método
 *  é chamado (imports dinâmicos no windowHost). */
export function getAgentHost(): AgentHost {
  if (!current) current = createWindowAgentHost()
  return current
}
