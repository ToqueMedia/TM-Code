/**
 * Event-driven wake for background shell commands.
 *
 * Background commands are tracked by Tauri process events. When a command
 * reaches a terminal state, this module wakes the main agent once so it can
 * inspect the result. There is no polling loop: if the agent is busy, a
 * Zustand subscription fires the wake when the status transitions to idle.
 */

import { useAgentStore } from '../../../stores/agentStore'
import { t } from '../../../i18n'
import { logger } from '../../../utils/logger'

interface BackgroundCommandWake {
  id: string
  command: string
  status: 'completed' | 'error' | 'cancelled'
  exitCode?: number | null
}

let wakeTimer: ReturnType<typeof setTimeout> | null = null
const WAKE_DEBOUNCE_MS = 500

const pendingCommands = new Map<string, BackgroundCommandWake>()
let pendingWake = false
let subscribed = false

function ensureIdleListener(): void {
  if (subscribed) return
  subscribed = true
  useAgentStore.subscribe((state, prev) => {
    if (state.status === 'idle' && prev.status !== 'idle' && pendingWake) {
      pendingWake = false
      if (wakeTimer) clearTimeout(wakeTimer)
      wakeTimer = setTimeout(doWake, WAKE_DEBOUNCE_MS)
    }
  })
}

export function maybeWakeMainAgentForBackgroundCommand(command: BackgroundCommandWake): void {
  pendingCommands.set(command.id, command)
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(doWake, WAKE_DEBOUNCE_MS)
}

export function acknowledgeBackgroundCommandWake(id: string): void {
  pendingCommands.delete(id)
  if (pendingCommands.size === 0) {
    pendingWake = false
    if (wakeTimer) {
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
  }
}

function doWake(): void {
  wakeTimer = null
  if (pendingCommands.size === 0) return

  // Defer em QUALQUER estado não-idle — incluindo 'error'. A lista antiga de
  // estados "busy" não incluía 'error', por isso um upstream em baixo gerava
  // wake → run falhada → mais uma mensagem de erro por cada evento, alimentando
  // a cascata de erros no chat. Mesma semântica do subAgents/autoWake.ts.
  const agentStatus = useAgentStore.getState().status
  if (agentStatus !== 'idle') {
    pendingWake = true
    ensureIdleListener()
    logger.info('agent', `→ Background command auto-wake deferred (agent is ${agentStatus})`)
    return
  }

  const commands = Array.from(pendingCommands.values())
  pendingCommands.clear()

  const completed = commands.filter(c => c.status === 'completed').length
  const failed = commands.filter(c => c.status === 'error').length
  const cancelled = commands.filter(c => c.status === 'cancelled').length
  const ids = commands.map(c => `${c.id}: "${c.command.slice(0, 80)}"`).join(', ')
  const summaryParts: string[] = []
  if (completed > 0) summaryParts.push(`${completed} completed`)
  if (failed > 0) summaryParts.push(`${failed} failed`)
  if (cancelled > 0) summaryParts.push(`${cancelled} cancelled`)

  const shortCmd = commands[0]?.command.slice(0, 60) ?? ''

  // GATE (user report 2026-07-16 "após o relatório vejo uma nova tarefa a
  // iniciar sozinha — está mal"): um run terminado SÓ é retomado sozinho se o
  // task tracker tiver trabalho aberto (pending/in_progress) — é a única
  // evidência objetiva de que o agente parou A MEIO à espera do comando.
  // Tracker vazio/completo = o relatório foi mesmo o fim; o resultado do
  // comando é anunciado no chat, mas NENHUM run arranca sozinho.
  const openTasks = useAgentStore.getState().tasks
    .filter(tk => tk.status === 'pending' || tk.status === 'in_progress').length

  if (openTasks === 0) {
    logger.info('agent', `→ Background command finished (${summaryParts.join(', ')}) — no open tracker tasks, NOT waking (report was final)`)
    void import('../../../stores/chatStore').then(({ useChatStore }) => {
      useChatStore.getState().addSystemMessage(
        t('backgroundWake.finishedNoResume').replace('{command}', shortCmd),
        failed > 0 ? 'warn' : 'info',
      )
    }).catch(() => { /* announcement is best-effort */ })
    return
  }

  const wakeMessage = `[System: Background command ${summaryParts.join(', ')}: ${ids}. Call the check_background_commands TOOL (never via shell/execute_command) once to read the result; do not poll. Then continue ONLY the tracker tasks that are still open.]`

  logger.info('agent', `→ Background command auto-wake: ${summaryParts.join(', ')} (${openTasks} open tasks)`)

  // Anuncia a retoma NO CHAT antes do run arrancar — sem isto o wake corre
  // com addUserMessage:false e a continuação aparece "do nada", lendo como
  // uma tarefa nova a auto-iniciar.
  import('../../../stores/chatStore').then(({ useChatStore }) => {
    useChatStore.getState().addSystemMessage(
      t('backgroundWake.resuming').replace('{command}', shortCmd).replace('{count}', String(openTasks)),
      'info',
    )
  }).catch(() => { /* announcement is best-effort */ })

  import('../agentRunner').then(({ runAgentWithCallbacks }) => {
    runAgentWithCallbacks(wakeMessage, {
      addUserMessage: false,
      useConversationHistory: true,
      isBackgroundRun: true,
    })
  }).catch((err) => {
    logger.warn('agent', `Background command auto-wake failed: ${err}`)
  })
}
