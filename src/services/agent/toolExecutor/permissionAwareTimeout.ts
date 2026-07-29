/**
 * Timeout que NÃO conta o tempo em que o utilizador está a decidir.
 *
 * HISTÓRIA (auditoria 2026-07-28): isto vivia dentro do safeToolPool.ts — um
 * executor paralelo de ~700 linhas que nunca teve um caller de produção (o
 * despacho paralelo real vive no loop, query.ts). O pool foi apagado; esta
 * função era a única peça com valor e mudou-se para aqui, ligada como
 * BACKSTOP do caminho MCP — o único sítio onde uma tool podia pendurar o
 * turno para sempre (um servidor MCP encravado não devolve nada; as tools
 * locais têm todos os seus próprios tetos).
 *
 * Why: a tool's `execute()` promise covers BOTH the permission request and
 * the actual work. With a flat `Promise.race(execute, setTimeout(timeoutMs))`,
 * the deadline expires while the user is still reading the dialog — the user
 * approves, the HTTP call fires, but the race already rejected. Per project
 * policy: user waits are unbounded.
 *
 * How: track wall-clock elapsed minus accumulated user-wait time.
 * When the timer fires, recompute "active" elapsed; if still under
 * `timeoutMs`, reschedule for the remainder. Three stores are the
 * sources of truth for "am I currently waiting on the user?":
 *   - permissionStore.pendingPermission — tool permission dialog
 *   - chatStore.pendingDiffs.length > 0 — file diff awaiting approval
 *   - credentialRequestStore.pending.size > 0 — credentials form open
 * We subscribe to all three so transitions in/out of wait states are
 * recorded as they happen, not only when the timer ticks.
 */

import { usePermissionStore } from '../../../stores/permissionStore'
import { useChatStore } from '../../../stores/chatStore'
import { useCredentialRequestStore } from '../../../stores/credentialRequestStore'

export function createPermissionAwareTimeout(toolName: string, timeoutMs: number): {
  promise: Promise<never>
  cleanup: () => void
} {
  const startedAt = Date.now()
  let totalPausedMs = 0
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  // Helper: check if any user-wait state is currently active
  const isAnyWaitStateActive = (): boolean => {
    const hasPermission = !!usePermissionStore.getState().pendingPermission
    const hasDiffs = useChatStore.getState().pendingDiffs.length > 0
    const hasCredentials = useCredentialRequestStore.getState().pending.size > 0
    return hasPermission || hasDiffs || hasCredentials
  }

  let waitStartedAt: number | null = isAnyWaitStateActive() ? startedAt : null

  const onStoreChange = () => {
    const isWaiting = isAnyWaitStateActive()
    const wasWaiting = waitStartedAt !== null
    if (isWaiting && !wasWaiting) {
      waitStartedAt = Date.now()
    } else if (!isWaiting && wasWaiting) {
      totalPausedMs += Date.now() - waitStartedAt!
      waitStartedAt = null
    }
  }

  // Subscribe to all three stores to detect wait state transitions
  const unsubscribePermission = usePermissionStore.subscribe(onStoreChange)
  const unsubscribeChat = useChatStore.subscribe(onStoreChange)
  const unsubscribeCredentials = useCredentialRequestStore.subscribe(onStoreChange)

  const promise = new Promise<never>((_, reject) => {
    const tick = () => {
      const now = Date.now()
      const currentPause = waitStartedAt !== null ? now - waitStartedAt : 0
      const activeMs = now - startedAt - totalPausedMs - currentPause
      if (activeMs >= timeoutMs) {
        reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs / 1000} seconds`))
        return
      }
      timeoutHandle = setTimeout(tick, timeoutMs - activeMs)
    }
    timeoutHandle = setTimeout(tick, timeoutMs)
  })

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    unsubscribePermission()
    unsubscribeChat()
    unsubscribeCredentials()
  }

  return { promise, cleanup }
}
