/**
 * Unified BYOK detection — single source of truth for whether a request
 * would route through the developer's own API key.
 *
 * Two states matter:
 *   - `byokActive`     — server has CONFIRMED the last response used BYOK
 *                        (read from the X-BYOK-Active header). Authoritative
 *                        for what *has* happened.
 *   - `byokConfigured` — the IDE is set up to route the NEXT request via
 *                        BYOK. Either the active session was created with a
 *                        snapshot, or the global byokStore has an enabled
 *                        provider+model selected. Authoritative for what
 *                        *will* happen.
 *
 * UI surfaces that gate on "is BYOK in play right now?" (the ModelIndicator
 * pill, the Thinking toggle, the credits pill swap) need `byokInPlay`
 * which is the OR of both — true the moment BYOK is configured, even
 * before the first response has come back to confirm it.
 *
 * Why a shared hook: this exact OR-of-two-states existed inline in 5
 * places (AgentStatusBar, TerminalTitleBar, ChatView, ModelIndicator,
 * agentService.buildRequestBody). When the rule shifts — say, a future
 * "BYOK paused" state — without the shared selector we'd update 4 of 5
 * sites and silently regress the one we forgot.
 */
import { useAgentStore } from '../stores/agentStore'
import { useByokStore } from '../stores/byokStore'
import { useChatStore } from '../stores/chatStore'
import { computeByokConfigured } from './byokConfigured'

export interface ByokState {
  /** Server-confirmed: last response used BYOK. */
  byokActive: boolean
  /** Locally configured: next request would route via BYOK. */
  byokConfigured: boolean
  /** OR of both — "BYOK is in play right now". The common gate for UI. */
  byokInPlay: boolean
}

export function useByokState(): ByokState {
  const byokActive = useAgentStore((s) => s.byokActive)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessions = useChatStore((s) => s.sessions)
  const enabled = useByokStore((s) => s.enabled)
  const activeProvider = useByokStore((s) => s.activeProvider)
  const activeModel = useByokStore((s) => s.activeModel)

  const sessionSnapshot = activeSessionId
    ? sessions.get(activeSessionId)?.byokSnapshot ?? null
    : null
  const byokConfigured = computeByokConfigured({
    sessionSnapshot,
    enabled,
    activeProvider,
    activeModel,
  })

  return {
    byokActive,
    byokConfigured,
    byokInPlay: byokActive || byokConfigured,
  }
}

/**
 * Non-hook variant for services (agentService, etc.) that need the same
 * answer outside React. Reads via `.getState()` directly. Result is a
 * snapshot — if the user toggles BYOK mid-async-call, you may want to
 * re-read; the hook version auto-subscribes, this one does not.
 */
export function getByokStateSnapshot(): ByokState {
  const byokActive = useAgentStore.getState().byokActive
  const chatState = useChatStore.getState()
  const byokState = useByokStore.getState()

  const sessionSnapshot = chatState.activeSessionId
    ? chatState.sessions.get(chatState.activeSessionId)?.byokSnapshot ?? null
    : null
  const byokConfigured = computeByokConfigured({
    sessionSnapshot,
    enabled: byokState.enabled,
    activeProvider: byokState.activeProvider,
    activeModel: byokState.activeModel,
  })

  return {
    byokActive,
    byokConfigured,
    byokInPlay: byokActive || byokConfigured,
  }
}
