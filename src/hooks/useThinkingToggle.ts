/**
 * Thinking-mode UI state — collapsed to a single fact: "does this model
 * think unconditionally?". Previously this hook also exposed an interactive
 * toggle so the user could flip thinking on/off mid-session, but that was
 * pulled (claude-vaz parity) — thinking now follows the model's default
 * and is forced ON only by slash commands (/plan, /debug, /review, /te2e)
 * via the backend's X-Request-Type header.
 *
 * What remains: the "⚡ Thinking" status badge that renders when the
 * backend reports `X-Model-Thinking-Mode: mandatory` (model thinks every
 * turn, can't be disabled). The chat surfaces just need to know whether
 * to paint that badge — no setter, no boolean state.
 *
 * Sources of truth (in order):
 *   1. agentStore.thinkingMode — set from the backend's X-Model-Thinking-Mode
 *      header on the first response of a turn.
 *   2. profile.thinkingMandatory — per-plan fallback used pre-handshake
 *      so the badge doesn't pop in after the first response.
 */
import { useAgentStore } from '../stores/agentStore'
import { useBillingStore } from '../stores/billingStore'
import { getProfileForPlan } from '../services/agent/modelProfiles'

export interface ThinkingToggleState {
  /** True iff the active model is mandatory-thinking (always-on, can't be
   *  disabled). UI renders a static badge; no toggle. */
  mandatory: boolean
}

export function useThinkingToggle(): ThinkingToggleState {
  const backendThinkingMode = useAgentStore((s) => s.thinkingMode)
  const billingPlan = useBillingStore((s) => s.plan)

  const fallbackProfile = getProfileForPlan(billingPlan)
  const effectiveMode =
    backendThinkingMode
    ?? (fallbackProfile.thinkingMandatory ? 'mandatory' : 'none')

  return {
    mandatory: effectiveMode === 'mandatory',
  }
}
