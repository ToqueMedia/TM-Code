/**
 * User-initiated cancel of a background command (BackgroundCommandsBar).
 *
 * Order matters: the store is marked 'cancelled' BEFORE kill_process — the
 * toolExecutor's cmd-exit listener reads the store to distinguish a user
 * cancel from a real failure (a kill produces a non-zero exit code that would
 * otherwise be reported as 'error' to the auto-wake and OS notifications).
 * The store's completeCommand/failCommand only transition from 'running', so
 * the late exit event can never overwrite the cancel.
 *
 * The kill itself mirrors agentService.cancelLoop's per-PID pattern.
 */

import { invoke } from '@tauri-apps/api/core'
import { useBackgroundCommandStore } from '../../../stores/backgroundCommandStore'
import { logger } from '../../../utils/logger'

export async function cancelBackgroundCommand(id: string): Promise<void> {
  const store = useBackgroundCommandStore.getState()
  const cmd = store.getById(id)
  if (!cmd || cmd.status !== 'running') return

  store.cancelCommand(id)
  try {
    await invoke('kill_process', { pid: cmd.pid })
  } catch (err) {
    // Best effort — o timeout do toolExecutor é o backstop e respeita o
    // estado 'cancelled' já gravado.
    logger.warn('agent', `cancelBackgroundCommand: kill_process(${cmd.pid}) failed: ${err}`)
  }
}
