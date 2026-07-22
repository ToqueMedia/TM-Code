/**
 * Global write serializer for concurrent agent runs (v1.0.1 parallel tasks).
 *
 * When up to 4 parallel task agents (plus the main agent) run at once, two of
 * them must never apply a file change at the SAME instant — that's how you get a
 * clobbered file. This is a single process-wide async mutex: every write/diff a
 * run wants to apply is wrapped in `withWriteLock`, so applies happen ONE AT A
 * TIME across all runs, in the order they acquire the lock. Reads, model calls,
 * and non-write tools stay fully parallel — only the apply step is serialized
 * (the user's "serialize diff approvals" choice for v1.0.1).
 *
 * Plain FIFO promise chain — no reentrancy, no priorities. Keep the critical
 * section as small as the actual apply (never hold it across a model round-trip),
 * or you serialize the whole fleet.
 */

let tail: Promise<void> = Promise.resolve()
let depth = 0

/**
 * Run `fn` while holding the global write lock. Waiters queue FIFO. The lock is
 * released (and the next waiter runs) even if `fn` throws/rejects — the error
 * still propagates to THIS caller, but never to the other waiters.
 */
export function withWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
  depth++
  const run = tail.then(() => fn())
  // Advance the tail but swallow rejections on the CHAIN so one failed apply
  // doesn't reject every future waiter (the error still reaches `run`'s awaiter).
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  void run.then(
    () => { depth-- },
    () => { depth-- },
  )
  return run
}

/** How many applies are currently queued/holding the lock (diagnostics/tests). */
export function pendingWriteLockDepth(): number {
  return depth
}
