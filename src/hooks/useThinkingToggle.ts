/**
 * Unified thinking-toggle state — collapses three rules into one hook:
 *
 *   1. What does the model support? (`toggleable` / `mandatory` / `none`)
 *      Read from the backend's authoritative X-Model-Thinking-Mode header
 *      via agentStore, with a per-plan fallback for the pre-first-response
 *      window.
 *
 *   2. Is BYOK in play? If yes, hide the manual toggle entirely — the
 *      developer's per-token wallet shouldn't have a one-click "burn
 *      tokens on a code-edit turn" UI. Thinking is auto-managed (ON only
 *      for /plan, /debug, /review, /te2e).
 *
 *   3. What's the current state + toggle action? Sourced from
 *      settingsStore.thinkingEnabled + setThinkingEnabled.
 *
 * Three callsites (AgentStatusBar, TerminalTitleBar, ChatView) had this
 * same logic inline with slight drift between them — a real "I missed
 * one" bug shipped because of that. Hook removes the drift; each
 * callsite renders its own visual using the returned flags.
 */
import { useAgentStore } from '../stores/agentStore'
import { useBillingStore } from '../stores/billingStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProfileForPlan } from '../services/agent/modelProfiles'
import { useByokState } from './useByokState'

export interface ThinkingToggleState {
  /** True iff the model supports an on/off toggle AND BYOK is not in play.
   *  The manual button should render only when this is true. */
  toggleable: boolean
  /** True iff the model thinks unconditionally (always-on). Render a
   *  static badge instead of a button. */
  mandatory: boolean
  /** Current user setting. Only meaningful when `toggleable` is true. */
  enabled: boolean
  /** Setter — call with the new boolean value. */
  setEnabled: (next: boolean) => void
}

export function useThinkingToggle(): ThinkingToggleState {
  const enabled = useSettingsStore((s) => s.thinkingEnabled)
  const setEnabled = useSettingsStore((s) => s.setThinkingEnabled)
  const backendThinkingMode = useAgentStore((s) => s.thinkingMode)
  const billingPlan = useBillingStore((s) => s.plan)
  const { byokInPlay } = useByokState()

  const fallbackProfile = getProfileForPlan(billingPlan)
  const effectiveMode =
    backendThinkingMode
    ?? (fallbackProfile.supportsThinking
        ? (fallbackProfile.thinkingMode === 'mandatory' ? 'mandatory' : 'toggleable')
        : 'none')

  return {
    toggleable: effectiveMode === 'toggleable' && !byokInPlay,
    mandatory: effectiveMode === 'mandatory',
    enabled,
    setEnabled,
  }
}
