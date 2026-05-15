/**
 * Scaffolding re-apply guard — shared structural helper for the prompt-bar's
 * smart routers. Auth-hashtag flow and `/payments` slash command both need
 * the same skeleton: detect already-applied state, block the re-scaffold,
 * surface an explanatory chat message, and tell the caller to bail.
 *
 * The MESSAGE is per-flow (auth says one thing, payments says another);
 * the SKELETON is identical. This module owns the skeleton.
 */
import type { ScaffoldKey } from '../../services/scaffoldingDetector'

export interface GuardResult {
  /**
   * True when the flow MUST stop. The guard already cleared the input and
   * added the system message — the caller's only job is to `return`.
   */
  blocked: boolean
}

/**
 * If any of `requestedKeys` is already applied to the project, clear the
 * input via `clearInput`, push the system message produced by `buildMessage`
 * into the chat, and return `blocked: true`. Otherwise return
 * `blocked: false` and the caller proceeds with the normal scaffolding flow.
 *
 * Detector errors are swallowed (best-effort gate). On any exception, the
 * guard returns `blocked: false` so a transient detection failure never
 * stops a legitimate scaffolding call.
 *
 * Fires `scaffold_reapply_blocked` analytics event when a block triggers.
 * Use the event to measure block frequency in production — high frequency
 * suggests users routinely try to re-scaffold (look for prompt-bar UX
 * issue or i18n gap); low frequency suggests the badge alone is enough.
 */
export async function guardScaffoldReapply(
  projectPath: string,
  requestedKeys: ScaffoldKey[],
  buildMessage: (appliedKeys: ScaffoldKey[]) => string,
  clearInput: () => void,
): Promise<GuardResult> {
  try {
    const { detectScaffolding } = await import('../../services/scaffoldingDetector')
    const detected = await detectScaffolding(projectPath)
    const alreadyApplied = requestedKeys.filter(k => detected.applied.includes(k))
    if (alreadyApplied.length > 0) {
      clearInput()
      const { useChatStore } = await import('../../stores/chatStore')
      useChatStore.getState().addSystemMessage(buildMessage(alreadyApplied))
      // Fire-and-forget telemetry. `keys` joined for cardinality control —
      // ['auth.google'] and ['auth.email-password', 'auth.google'] each map
      // to one stable string instead of N event variants.
      import('../../services/analytics').then(({ trackEvent }) => {
        void trackEvent('scaffold_reapply_blocked', {
          keys: alreadyApplied.slice().sort().join(','),
          requested: requestedKeys.slice().sort().join(','),
        })
      }).catch(() => { /* non-critical */ })
      return { blocked: true }
    }
  } catch {
    /* non-critical — fall through to normal flow */
  }
  return { blocked: false }
}
