/**
 * Implementação-JANELA da costura de host (P1 — ver hostBus.ts e
 * docs/DESIGN-HEADLESS-RUNNER.md). Este módulo é o ÚNICO sítio onde a costura
 * toca em stores/serviços do renderer; o núcleo do agente importa apenas o
 * hostBus e recebe callbacks via QueryParams. Um futuro hospedeiro headless
 * fornece as suas próprias implementações e este ficheiro nunca é carregado.
 */

import { setHostNotificationHandler, setToolProgressHandler, beginHumanGate } from './hostBus'
// Type-only (apagado na compilação): o ciclo agentHost→windowHost é só de
// runtime num sentido; este import não o fecha.
import type { AgentHost, HostGateScope } from './agentHost'

let installed = false

/** Liga o hospedeiro-janela ao bus. Chamado uma vez no bootstrap (main.tsx). */
export function installWindowHost(): void {
  if (installed) return
  installed = true
  setHostNotificationHandler((n) => {
    // Import dinâmico: preserva o lazy-load do notificationService (que toca
    // em getCurrentWindow() da API Tauri — só existe no contexto janela).
    void import('@/services/notificationService')
      .then(({ notify }) => notify(n))
      .catch(() => {
        /* melhor-esforço, como sempre foi nos call sites originais */
      })
  })

  // Progresso de tools → transcript (P3): pré-carrega o chatStore UMA vez e
  // regista um handler SÍNCRONO — comandos verbosos emitem muitos chunks e
  // não podem pagar um import dinâmico (nem um tick de microtask) por chunk.
  // Entre o install e o load (bootstrap, microssegundos) não há runs, logo
  // não há eventos a perder.
  void import('@/stores/chatStore')
    .then(({ useChatStore }) => {
      setToolProgressHandler((e) => {
        const store = useChatStore.getState()
        if (e.kind === 'progress') store.updateToolCallProgress(e.toolCallId, e.text)
        else store.appendToolCallCommandLogs(e.toolCallId, e.chunks)
      })
    })
    .catch(() => {
      /* sem chatStore não há transcript para alimentar */
    })
}

/**
 * Hooks de orçamento do loop (QueryParams.isTeamMemberBudgetBlocked /
 * onBudgetExhausted) na versão janela: lêem/escrevem o billingStore
 * exactamente como o query.ts fazia inline até 2026-08-03. Os TRÊS runners
 * (main, tarefas paralelas, sub-agentes) espalham isto nas suas
 * QueryEngineOptions — o comportamento é o de sempre; a diferença é o loop
 * deixar de conhecer a store (portão duro nº10 do inventário headless).
 */
export function windowBudgetHooks(): {
  isTeamMemberBudgetBlocked: () => Promise<boolean>
  onBudgetExhausted: () => Promise<void>
} {
  return {
    isTeamMemberBudgetBlocked: async () => {
      try {
        const { useBillingStore } = await import('@/stores/billingStore')
        const store = useBillingStore.getState()
        return !!store.team && store.team.role !== 'owner'
      } catch {
        return false
      }
    },
    onBudgetExhausted: async () => {
      try {
        const { useBillingStore } = await import('@/stores/billingStore')
        useBillingStore.getState().setNoCredits()
      } catch {
        /* non-critical — como no inline original */
      }
    },
  }
}

/**
 * O hospedeiro-JANELA do contrato AgentHost (P2): cada método delega na store
 * respectiva EXACTAMENTE como o call site fazia inline até 2026-08-03 — os
 * blocos foram movidos, não reescritos. Imports dinâmicos em todos os métodos:
 * este módulo pode ser carregado em Node (é o default lazy do registry) sem
 * arrastar o runtime do renderer até um método ser chamado.
 */
export function createWindowAgentHost(): AgentHost {
  return {
    // Rest-spread nos dois métodos de permissão: preserva a ARIDADE exacta do
    // call site (o site sensitive passa 3 args; os sites genérico/perigoso
    // passam 4 com origin possivelmente undefined) — os testes de contrato
    // distinguem "não passado" de "undefined" e a fidelidade é o requisito
    // da P2 ("movido, não reescrito").
    // P4 (portão nº7): cada via humana abre um span beginHumanGate/end — é
    // daqui que o permissionAwareTimeout deriva o tempo-de-humano a
    // subtrair, em vez de subscrever 3 stores. Duas divergências
    // deliberadas e CONSERVADORAS face ao original: o span cobre também o
    // tempo na FILA de permissões e as perguntas estruturadas (que a
    // subscrição antiga ignorava) — deadline maior, menos timeouts falsos
    // de MCP com o utilizador a decidir.
    async canUseTool(...callArgs) {
      const { usePermissionStore } = await import('@/stores/permissionStore')
      const endGate = beginHumanGate()
      try {
        return await usePermissionStore.getState().requestPermission(...callArgs)
      } finally {
        endGate()
      }
    },

    async requestPathAccess(...callArgs) {
      const { usePermissionStore } = await import('@/stores/permissionStore')
      const endGate = beginHumanGate()
      try {
        return await usePermissionStore.getState().requestPathAccess(...callArgs)
      } finally {
        endGate()
      }
    },

    async approveDiff(toolCallId) {
      const { createDiffApprovalPromise } = await import('@/stores/chatStore')
      const endGate = beginHumanGate()
      try {
        return await createDiffApprovalPromise(toolCallId)
      } finally {
        endGate()
      }
    },

    async requestCredentials({ serviceName, fields, projectRoot, taskOrigin, signal }) {
      const [{ useCredentialRequestStore }, { useChatStore }] = await Promise.all([
        import('@/stores/credentialRequestStore'),
        import('@/stores/chatStore'),
      ])
      const chatStore = useChatStore.getState()

      // Tarefa paralela: o pedido é etiquetado (badge "Credenciais" na row)
      // e o card escrito NA SESSÃO da tarefa — o user decide no chat dela.
      const { id: requestId, promise: requestPromise } = useCredentialRequestStore
        .getState()
        .request({
          serviceName,
          fields,
          ...(taskOrigin ? { origin: { taskId: taskOrigin.taskId, label: taskOrigin.label } } : {}),
        })

      const cardMessageId = chatStore.addCredentialRequestCard(
        projectRoot,
        requestId,
        serviceName,
        fields,
        taskOrigin?.sessionId,
      )

      const endGate = beginHumanGate()
      let result: { submitted: boolean; keys?: string[] }
      try {
        result = await new Promise<{ submitted: boolean; keys?: string[] }>((resolve) => {
          let settled = false
          const onAbort = () => {
            if (settled) return
            settled = true
            useCredentialRequestStore.getState().cancel(requestId)
            resolve({ submitted: false })
          }
          if (signal) {
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })
          }
          requestPromise.then((r) => {
            if (settled) return
            settled = true
            resolve(r)
          })
        })
      } finally {
        endGate()
      }

      if (result.submitted) {
        chatStore.markCredentialRequestSubmitted(cardMessageId, result.keys ?? [])
      } else {
        chatStore.updateCardStatus(cardMessageId, 'cancelled')
      }
      return result
    },

    async askUserQuestion({ questions, projectRoot, taskOrigin, signal }) {
      const [{ useAskUserQuestionStore }, { useChatStore }] = await Promise.all([
        import('@/stores/askUserQuestionStore'),
        import('@/stores/chatStore'),
      ])
      const chatStore = useChatStore.getState()

      // Tarefa paralela: pedido etiquetado (badge "Pergunta" na row) e card
      // escrito na sessão da tarefa.
      const { id: requestId, promise: answerPromise } = useAskUserQuestionStore
        .getState()
        .request(
          questions,
          taskOrigin ? { taskId: taskOrigin.taskId, label: taskOrigin.label } : undefined,
        )

      const cardMessageId = chatStore.addAskUserQuestionCard(
        projectRoot,
        requestId,
        questions,
        taskOrigin?.sessionId,
      )

      const endGate = beginHumanGate()
      let result: Record<string, string | string[]>
      try {
        result = await new Promise<Record<string, string | string[]>>((resolve) => {
          let settled = false
          const onAbort = () => {
            if (settled) return
            settled = true
            useAskUserQuestionStore.getState().cancel(requestId)
            resolve({})
          }
          if (signal) {
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })
          }
          answerPromise.then((r) => {
            if (settled) return
            settled = true
            resolve(r)
          })
        })
      } finally {
        endGate()
      }

      if (!result || Object.keys(result).length === 0) {
        chatStore.updateCardStatus(cardMessageId, 'cancelled')
      } else {
        chatStore.updateCardStatus(cardMessageId, 'submitted')
      }
      return result
    },

    async waitForUserGates(scope: HostGateScope, opts) {
      const [
        { usePermissionStore },
        { useAskUserQuestionStore },
        { useCredentialRequestStore },
        { hasPendingDiffApprovals, getPendingDiffApprovalToolIds },
        { isInActiveWriteBatch },
      ] = await Promise.all([
        import('@/stores/permissionStore'),
        import('@/stores/askUserQuestionStore'),
        import('@/stores/credentialRequestStore'),
        import('@/stores/chatStore'),
        import('../writeBatch'),
      ])
      const signal = opts?.signal
      const toolUseId = opts?.toolUseId

      // Corpo movido tal-e-qual do toolExecutor.waitForUserGates (P2,
      // 2026-08-03) — poll de 120ms em vez de subscriptions: só corre
      // enquanto um gate está aberto (caso raro e human-paced). F2
      // multi-project: só espera por gates que pertencem a ESTE run.
      const myProjectId = scope.projectId
      const myTaskId = scope.taskId

      const gateIsMine = (originTaskId?: string, projectId?: string | null): boolean => {
        if (projectId && myProjectId) return projectId === myProjectId
        if (originTaskId && myTaskId) return originTaskId === myTaskId
        // Unscoped prompt (main, no origin): only the unbound main waits.
        if (!originTaskId && !projectId) return !myTaskId
        // Prompt has identity we don't match — not ours.
        if (originTaskId || projectId) return false
        return true
      }

      const gateOpen = (): boolean => {
        try {
          const perm = usePermissionStore.getState().pendingPermission
          if (perm && gateIsMine(perm.origin?.taskId, perm.projectId)) return true
          // Also block if a queued permission for US is waiting behind another
          // dialog (we will eventually need to answer it). Don't block for
          // other projects.
          for (const q of usePermissionStore.getState().permissionQueue) {
            if (gateIsMine(q.origin?.taskId, q.projectId)) return true
          }
          for (const entry of useAskUserQuestionStore.getState().pending.values()) {
            if (gateIsMine(entry.origin?.taskId, undefined)) return true
          }
          for (const entry of useCredentialRequestStore.getState().pending.values()) {
            if (gateIsMine(entry.origin?.taskId, undefined)) return true
          }
          // Diff approvals are keyed by toolCallId, not project — only the
          // unbound main (or any run without project isolation) waits
          // globally. Background project-runs and parallel tasks skip: their
          // writes use the cmdMode alreadyApplied path, not the main diff UI.
          //
          // Excepção de LOTE (writeBatch.ts): writes do MESMO turno
          // despachadas em conjunto pelo query.ts atravessam o gate — os seus
          // diffs devem acumular na barra de aprovação e ser decididos juntos.
          if (!myProjectId && !myTaskId && hasPendingDiffApprovals()) {
            const selfInBatch = toolUseId !== undefined && isInActiveWriteBatch(toolUseId)
            const strayPending = getPendingDiffApprovalToolIds()
              .some(id => !isInActiveWriteBatch(id))
            if (strayPending || !selfInBatch) return true
          }
        } catch {
          return false
        }
        return false
      }

      while (gateOpen()) {
        if (signal?.aborted) return
        await new Promise(resolve => setTimeout(resolve, 120))
      }
    },
  }
}
