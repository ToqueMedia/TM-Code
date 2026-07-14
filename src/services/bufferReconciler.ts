import { useEditorRepository } from '../stores/editorStore'
import { logger } from '../utils/logger'

// Reconciles open editor buffers with the filesystem so tabs reflect
// changes made OUTSIDE the editor's own save path. Two triggers:
//
//  - 'git:refreshGutter': dispatched by the agent after every mutating tool
//    (including execute_command — shell edits like sed / git checkout /
//    codemods that never go through write_file) and by the Source Control
//    panel after stage/discard operations. The direct write tools already
//    refresh their own target via refreshEditorIfOpen; this sweep catches
//    everything that mutates files as a side effect.
//  - window focus: files edited by an external editor/process while the
//    app was in the background (mirrors VS Code reloading clean buffers
//    when you come back to the window).
//
// Cost control: refreshFileContent skips dirty buffers (unsaved user edits
// always win — the VS Code data-loss guard) and no-ops the store update
// when disk already matches the buffer, so a sweep is one read per open
// tab and zero re-renders when nothing changed. Sweeps are debounced to
// coalesce the per-tool event storm of an agent run.

const DEBOUNCE_MS = 500

let debounceId: ReturnType<typeof setTimeout> | null = null
let sweeping = false
let rerunAfterSweep = false
let started = false

async function sweep(): Promise<void> {
  if (sweeping) {
    // An event landed mid-sweep — run one more pass when this one ends so
    // a write that raced the reads is not missed until the next event.
    rerunAfterSweep = true
    return
  }
  sweeping = true
  try {
    const { openFiles, refreshFileContent } = useEditorRepository.getState()
    // Images are binary (read as base64 at open); text refresh would fail.
    const candidates = openFiles.filter(f => !f.isDirty && !f.isImage)
    await Promise.allSettled(candidates.map(f => refreshFileContent(f.path)))
  } catch (e) {
    logger.debug('editor', 'Buffer reconcile sweep failed:', e)
  } finally {
    sweeping = false
    if (rerunAfterSweep) {
      rerunAfterSweep = false
      schedule()
    }
  }
}

function schedule(): void {
  if (debounceId) clearTimeout(debounceId)
  debounceId = setTimeout(() => {
    debounceId = null
    void sweep()
  }, DEBOUNCE_MS)
}

/** Start listening. Idempotent; returns a stop function. */
export function startBufferReconciler(): () => void {
  if (started) return () => {}
  started = true
  const onEvent = () => schedule()
  window.addEventListener('git:refreshGutter', onEvent)
  window.addEventListener('focus', onEvent)
  return () => {
    started = false
    if (debounceId) {
      clearTimeout(debounceId)
      debounceId = null
    }
    window.removeEventListener('git:refreshGutter', onEvent)
    window.removeEventListener('focus', onEvent)
  }
}
