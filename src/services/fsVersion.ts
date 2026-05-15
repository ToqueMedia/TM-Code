/**
 * Filesystem fingerprint for cache invalidation.
 *
 * A monotonically-increasing counter, bumped exactly once for every observed
 * filesystem mutation by the agent or the IDE. Consumers fold this counter
 * into their cache keys; when it changes, their caches miss naturally without
 * needing a per-extension regex or per-callsite invalidation list.
 *
 * Why this replaces the prior regex-based `invalidatePromptCache` calls:
 *   - The old approach matched specific suffixes (README/PLAN/TODO/package.json
 *     and later every `.ts/.tsx/.js/...`). Adding a new path that wrote files
 *     without matching the regex silently broke cache freshness — exactly the
 *     `helper.ts created in turn 1, not visible in turn 2's file tree` bug.
 *   - This counter is path-agnostic: any caller that mutates files calls
 *     `bumpFsVersion()`. Cache keys that include the version are guaranteed
 *     to miss after a mutation, regardless of what was written.
 *
 * Per-project bumps would be safer (one project's writes shouldn't bust
 * another project's cache) but the IDE is single-project for the active
 * session, so a global counter is enough and stays cheap. Revisit if multi-
 * project workspaces land.
 *
 * Pure module — no Tauri / React / store imports — so consumers in service
 * layers can read it without circular dependencies.
 */

let version = 0
type Listener = (next: number) => void
const listeners = new Set<Listener>()

/** Current filesystem version. Stable until the next mutation. */
export function getFsVersion(): number {
  return version
}

/**
 * Signal that the filesystem changed. Call this from EVERY write path —
 * agent tool execution after diff approval, scaffolding, post-scaffold
 * pipelines, terminal commands the IDE knows about, etc.
 *
 * The optional `reason` is just for diagnostics; not consumed.
 */
export function bumpFsVersion(_reason?: string): number {
  version += 1
  for (const fn of listeners) {
    try { fn(version) } catch { /* listener errors are non-critical */ }
  }
  return version
}

/** Subscribe to version changes. Returns an unsubscribe function. */
export function subscribeFsVersion(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Reset the counter — TEST ONLY. */
export function __resetFsVersionForTests(): void {
  version = 0
  listeners.clear()
}
