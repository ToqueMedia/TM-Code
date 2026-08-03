/**
 * Implementação-JANELA da costura de host (P1 — ver hostBus.ts e
 * docs/DESIGN-HEADLESS-RUNNER.md). Este módulo é o ÚNICO sítio onde a costura
 * toca em stores/serviços do renderer; o núcleo do agente importa apenas o
 * hostBus e recebe callbacks via QueryParams. Um futuro hospedeiro headless
 * fornece as suas próprias implementações e este ficheiro nunca é carregado.
 */

import { setHostNotificationHandler } from './hostBus'

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
