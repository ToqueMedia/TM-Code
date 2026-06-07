/**
 * Opt-in instrumentation wrapper around Tauri's `invoke`.
 *
 * The IDE has roughly 65 files calling `invoke()` across 100+ unique
 * command names. We want a way to measure which commands dominate a real
 * session — count, average/max latency, error rate — without paying the
 * timing overhead for every user, and without rewriting every callsite.
 *
 * Design:
 *   - Each hot-path module imports `invoke` from this file instead of
 *     `@tauri-apps/api/core`. The signature is identical.
 *   - When the `tm:ipc-metrics` localStorage flag is set to '1', the
 *     wrapper times each call and records it. Otherwise it forwards to
 *     the raw `invoke` with no overhead beyond one function-call frame.
 *   - The collected data lives in module memory and is exposed via
 *     `window.__tmIpcMetrics` so a developer can inspect it from the
 *     DevTools console mid-session — no UI required for a debug tool.
 *
 * Toggle from DevTools:
 *   window.__tmIpcMetrics.enable()         // start recording
 *   window.__tmIpcMetrics.disable()        // stop recording (in-memory data kept)
 *   window.__tmIpcMetrics.get()            // sorted by totalLatencyMs desc
 *   window.__tmIpcMetrics.reset()          // clear in-memory entries
 *   window.__tmIpcMetrics.isEnabled()      // current flag state
 *
 * Storage is in-memory only — the metrics aren't persisted. That's
 * deliberate: this is a developer tool to size an optimisation, not a
 * permanent telemetry pipeline. Reload to start fresh.
 *
 * Why not patch the global `invoke` once at app start? The Tauri API
 * module is re-exported by countless paths and bundlers like Vite freeze
 * import bindings at build time — monkey-patching the re-export wouldn't
 * affect callers who already captured a direct reference. Per-file opt-in
 * is more verbose but actually works.
 */
import { invoke as rawInvoke, InvokeArgs, InvokeOptions } from '@tauri-apps/api/core'

interface MetricEntry {
  count: number
  totalLatencyMs: number
  maxLatencyMs: number
  errorCount: number
  lastCallAt: number
}

interface MetricRow {
  cmd: string
  count: number
  avgLatencyMs: number
  maxLatencyMs: number
  errorCount: number
  totalLatencyMs: number
  lastCallAt: number
}

interface PendingInvoke {
  id: number
  cmd: string
  startedAt: number
}

interface PendingInvokeRow {
  id: number
  cmd: string
  ageMs: number
}

const FLAG_KEY = 'tm:ipc-metrics'
const metrics = new Map<string, MetricEntry>()
const pending = new Map<number, PendingInvoke>()
let nextPendingId = 1

function isEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

function record(cmd: string, latencyMs: number, success: boolean): void {
  let entry = metrics.get(cmd)
  if (!entry) {
    entry = { count: 0, totalLatencyMs: 0, maxLatencyMs: 0, errorCount: 0, lastCallAt: 0 }
    metrics.set(cmd, entry)
  }
  entry.count += 1
  entry.totalLatencyMs += latencyMs
  if (latencyMs > entry.maxLatencyMs) entry.maxLatencyMs = latencyMs
  if (!success) entry.errorCount += 1
  entry.lastCallAt = Date.now()
}

/**
 * Drop-in replacement for `invoke` from `@tauri-apps/api/core`. Same shape,
 * same generics, same Promise rejection semantics — so callers can replace
 * the import without changing call sites.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  const start = performance.now()
  const pendingId = nextPendingId++
  pending.set(pendingId, { id: pendingId, cmd, startedAt: start })
  try {
    const result = await rawInvoke<T>(cmd, args, options)
    if (isEnabled()) record(cmd, performance.now() - start, true)
    return result
  } catch (err) {
    if (isEnabled()) record(cmd, performance.now() - start, false)
    throw err
  } finally {
    pending.delete(pendingId)
  }
}

/** Snapshot of current metrics, sorted by total latency contribution. */
export function getInvokeMetrics(): MetricRow[] {
  const out: MetricRow[] = []
  for (const [cmd, e] of metrics.entries()) {
    out.push({
      cmd,
      count: e.count,
      avgLatencyMs: e.totalLatencyMs / e.count,
      maxLatencyMs: e.maxLatencyMs,
      errorCount: e.errorCount,
      totalLatencyMs: e.totalLatencyMs,
      lastCallAt: e.lastCallAt,
    })
  }
  return out.sort((a, b) => b.totalLatencyMs - a.totalLatencyMs)
}

export function resetInvokeMetrics(): void {
  metrics.clear()
}

export function getPendingInvokes(): PendingInvokeRow[] {
  const now = performance.now()
  return Array.from(pending.values())
    .map(item => ({
      id: item.id,
      cmd: item.cmd,
      ageMs: Math.round(now - item.startedAt),
    }))
    .sort((a, b) => b.ageMs - a.ageMs)
}

export function enableInvokeMetrics(): void {
  try { localStorage.setItem(FLAG_KEY, '1') } catch { /* private mode etc. */ }
}

export function disableInvokeMetrics(): void {
  try { localStorage.removeItem(FLAG_KEY) } catch { /* ignore */ }
}

// Console handle. Adding this once on module evaluation is cheap and gives
// devs `__tmIpcMetrics` in any DevTools session without needing to import.
if (typeof window !== 'undefined') {
  const logPendingInvokes = () => {
    const rows = getPendingInvokes()
    if (rows.length === 0) return
    const preview = rows
      .slice(0, 12)
      .map(row => `${row.cmd}#${row.id} ${row.ageMs}ms`)
      .join(', ')
    console.warn(`[ipc] page is unloading with ${rows.length} pending Tauri invoke(s): ${preview}`)
  }
  window.addEventListener('pagehide', logPendingInvokes, { capture: true })
  window.addEventListener('beforeunload', logPendingInvokes, { capture: true })

  ;(window as unknown as { __tmIpcMetrics?: unknown }).__tmIpcMetrics = {
    get: getInvokeMetrics,
    pending: getPendingInvokes,
    reset: resetInvokeMetrics,
    enable: enableInvokeMetrics,
    disable: disableInvokeMetrics,
    isEnabled,
  }
}
