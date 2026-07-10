/**
 * Event-driven wake for background shell commands.
 *
 * Background commands are tracked by Tauri process events. When a command
 * reaches a terminal state, this module wakes the main agent once so it can
 * inspect the result. There is no polling loop: if the agent is busy, a
 * Zustand subscription fires the wake when the status transitions to idle.
 */

import { useAgentStore } from '../../../stores/agentStore'
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

  const wakeMessage = `[System: Background command ${summaryParts.join(', ')}: ${ids}. Use check_background_commands once to read the result; do not poll.]`

  logger.info('agent', `→ Background command auto-wake: ${summaryParts.join(', ')}`)

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
