/**
 * Event-driven wake for background shell commands.
 *
 * Background commands are tracked by Tauri process events. When a command
 * reaches a terminal state, this module wakes the main agent once so it can
 * inspect the result. There is no polling loop: if the agent is busy, a
 * Zustand subscription fires the wake when the status transitions to idle.
 *
 * Wake policy (2026-07-24 — momenu-fact deploy session):
 *  - ALWAYS wake on failure (`error`) so the agent can read logs and fix.
 *  - Wake on success/cancel only when the tracker still has open work
 *    (pending/in_progress) — evidence the agent stopped mid-plan waiting.
 *  - Success + empty tracker → announce only (avoids "ghost new task" spam).
 */

import { useAgentStore } from '../../../stores/agentStore'
import { t } from '../../../i18n'
import { logger } from '../../../utils/logger'

export interface BackgroundCommandWake {
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

/**
 * Pure decision helper — exported for unit tests.
 *
 * Um comando que TERMINOU sozinho (completed ou error) acorda sempre o agente.
 * A descrição da tool promete-lhe "the system auto-wakes you when the command
 * exits", e ele termina o turno a contar com isso — dizer "vou ver o resultado
 * do build" e nunca mais voltar deixa a tarefa por fazer. O gate por tracker
 * aberto (auditoria 2026-07-28) só cobria a falha e o caso de haver tarefas em
 * aberto: um build BEM-SUCEDIDO com tracker vazio ficava sem ninguém a agir
 * sobre ele. Nota: quando este código corre o agente está IDLE, ou seja o turno
 * já fechou com o comando a correr — é exatamente o caso que a promessa cobre.
 *
 * O CANCEL continua a não acordar por si só: foi o utilizador a matá-lo, e
 * ressuscitar o agente para relatar aquilo que a pessoa acabou de cancelar é
 * ruído (a menos que haja trabalho em aberto no tracker).
 */
export function shouldWakeForBackgroundCommands(
  commands: BackgroundCommandWake[],
  openTaskCount: number,
): { wake: boolean; reason: 'failure' | 'completed' | 'open_tasks' | 'cancelled_only' } {
  const failed = commands.some(c => c.status === 'error')
  if (failed) return { wake: true, reason: 'failure' }
  if (commands.some(c => c.status === 'completed')) return { wake: true, reason: 'completed' }
  if (openTaskCount > 0) return { wake: true, reason: 'open_tasks' }
  return { wake: false, reason: 'cancelled_only' }
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
  const ids = commands.map(c => {
    const exit =
      c.exitCode === null || c.exitCode === undefined ? '' : ` exit=${c.exitCode}`
    return `${c.id}: "${c.command.slice(0, 80)}" (${c.status}${exit})`
  }).join(', ')
  const summaryParts: string[] = []
  if (completed > 0) summaryParts.push(`${completed} completed`)
  if (failed > 0) summaryParts.push(`${failed} failed`)
  if (cancelled > 0) summaryParts.push(`${cancelled} cancelled`)

  const shortCmd = commands[0]?.command.slice(0, 60) ?? ''
  const firstFailed = commands.find(c => c.status === 'error')
  const exitHint =
    firstFailed && firstFailed.exitCode !== null && firstFailed.exitCode !== undefined
      ? ` (exit ${firstFailed.exitCode})`
      : ''

  const openTasks = useAgentStore.getState().tasks
    .filter(tk => tk.status === 'pending' || tk.status === 'in_progress').length

  const decision = shouldWakeForBackgroundCommands(commands, openTasks)

  if (!decision.wake) {
    // Só cancelamentos do utilizador, sem trabalho em aberto — nada a relatar.
    logger.info(
      'agent',
      `→ Background command finished (${summaryParts.join(', ')}) — user-cancelled with no open tracker tasks, NOT waking`,
    )
    void import('../../../stores/chatStore').then(({ useChatStore }) => {
      useChatStore.getState().addSystemMessage(
        t('backgroundWake.finishedNoResume').replace('{command}', shortCmd),
        'info',
      )
    }).catch(() => { /* announcement is best-effort */ })
    return
  }

  const wakeReason =
    decision.reason === 'failure'
      ? 'command failed — agent must inspect and fix'
      : `${openTasks} open tracker task(s)`

  const wakeMessage = decision.reason === 'failure'
    ? `[System: Background command FAILED${exitHint}: ${ids}. Call the check_background_commands TOOL (never via shell/execute_command) ONCE to read the error output. Do not poll. Fix the failure, then re-run the command if still needed. Continue only tracker tasks that are still open (or re-open the deploy/verify task if it was closed).]`
    : `[System: Background command ${summaryParts.join(', ')}: ${ids}. Call the check_background_commands TOOL (never via shell/execute_command) once to read the result; do not poll. Then continue ONLY the tracker tasks that are still open.]`

  logger.info('agent', `→ Background command auto-wake: ${summaryParts.join(', ')} (${wakeReason})`)

  // Anuncia a retoma NO CHAT antes do run arrancar — sem isto o wake corre
  // com addUserMessage:false e a continuação aparece "do nada", lendo como
  // uma tarefa nova a auto-iniciar.
  import('../../../stores/chatStore').then(({ useChatStore }) => {
    const msg = decision.reason === 'failure'
      ? t('backgroundWake.resumingFailure')
          .replace('{command}', shortCmd)
          .replace('{exit}', exitHint) // e.g. " (exit 1)" or ""
      : t('backgroundWake.resuming')
          .replace('{command}', shortCmd)
          .replace('{count}', String(openTasks))
    useChatStore.getState().addSystemMessage(
      msg,
      decision.reason === 'failure' ? 'warn' : 'info',
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

/** Test-only: reset module state between tests. */
export function __resetBackgroundAutoWakeForTests(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer)
    wakeTimer = null
  }
  pendingCommands.clear()
  pendingWake = false
}
