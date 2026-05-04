import { useChatStore } from '../../../stores/chatStore'
import { useBillingStore } from '../../../stores/billingStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import AgentService from '../agentService'
import { runAgentWithCallbacks } from '../agentRunner'
import { browserSession } from '../../browserSessionManager'
import { trackEvent } from '../../analytics'
import { logger } from '../../../utils/logger'
import { t } from '../../../i18n'

/**
 * `/te2e <what to validate>` — agent drives a real browser to validate
 * the live preview. Uses the Playwright MCP server (lazy-spawned), one
 * action per agent turn, each gated by a Yes/No permission prompt.
 *
 * No spec files written, no CI artifacts — exploratory validation only.
 * For regression in CI, the user writes specs by hand.
 */
export async function executeE2E(args: string, projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  // Paywall: /te2e is a paid feature. The Explorer plan exists to convert
  // free users to paid; reasoning-heavy adversarial testing is one of the
  // wedges that makes upgrading worthwhile. Surface a clear upgrade
  // message and bring the user one click closer to the plans page.
  const plan = useBillingStore.getState().plan
  if (plan === 'explorer') {
    void trackEvent('e2e_paywall_hit', { plan })
    chatStore.addSystemMessage(
      `${t('e2e.paywall.title')}\n\n` +
      `${t('e2e.paywall.body')}\n\n` +
      `→ ${t('e2e.paywall.cta')}: open Settings to upgrade your plan.`
    )
    useLayoutStore.getState().setViewMode('settings')
    return
  }

  if (!args.trim()) {
    chatStore.addSystemMessage(
      'Usage: /te2e <what to validate>\n\n' +
      'Examples:\n' +
      '  /te2e login flow\n' +
      '  /te2e signup form validates required fields\n' +
      '  /te2e clicking the cart icon opens the drawer\n\n' +
      'The agent will start the browser and click through the flow. Each browser action ' +
      'asks for your permission (Yes/No). Nothing is written to your project.'
    )
    return
  }

  // Eagerly boot the MCP server so its tools are registered before the
  // agent's first turn. If browser detection fails, the dialog surfaces
  // and the agent never starts — clean abort.
  try {
    await browserSession.start()
    void trackEvent('e2e_session_started', { plan })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('te2e', 'Browser MCP failed to start', err)
    void trackEvent('e2e_session_start_failed', { plan, reason: msg.slice(0, 100) })
    chatStore.addSystemMessage(
      `Could not start the browser:\n${msg}\n\n` +
      `Install Google Chrome (or Edge / Brave) and try again.`
    )
    return
  }

  // Force reasoning ON for adversarial testing. Same wiring /debug and
  // /plan use: backend reads X-Request-Type and injects enable_thinking
  // for the turn. Without this, the model cannot derive a meaningful
  // scenario matrix from the code or judge whether a failure is a real
  // bug vs. intentional design — adversarial collapses to smoke testing.
  const agentService = AgentService.getInstance()
  agentService.setRequestType('e2e')
  try {
    await runAgentWithCallbacks(buildE2EPrompt(args, projectPath), {
      addUserMessage: true,
      userMessageText: `/te2e ${args}`,
    })
  } finally {
    agentService.setRequestType(null)
  }
}

function buildE2EPrompt(request: string, projectPath: string): string {
  return `<role>
Adversarial QA engineer. The user wants bugs in this feature, not happy-path confirmation. Derive the surface from the code, drive scenarios designed to break it, reason before acting. Reasoning is forced ON for every turn — use it.
</role>

<request>${request}</request>
<project_path>${projectPath}</project_path>

<protocol>
Three phases. Do not collapse them.

PHASE 1 — Discover (read code first):
  - Read every file that touches the feature: components, routes, guards, stores, validation schemas, API endpoints, error handlers.
  - Build a surface map: inputs, states, validations PRESENT and MISSING, side effects, anticipated error paths.
  - Derive a scenario matrix covering the classes that apply: happy, empty/blank, boundary (max+1, min-1, very long), invalid format (no @, weak password, unicode, emojis, whitespace), state transitions (anon→protected, expired token, refresh mid-action), network (offline, 4xx/5xx via direct backend calls), persistence (refresh, back/forward, multi-tab), concurrency (double-submit, race), authorization (access without perm, IDOR). Skip non-applicable classes but say so.
  - Confirm dev server URL via \`read_dev_server_logs\`; \`start_dev_server\` if needed.

PHASE 2 — Execute:
  - Navigate. Snapshot (\`mcp__browser__browser_snapshot\`) — accessibility tree is the selector source of truth, not the source code.
  - For each scenario: drive inputs → snapshot after → reason about the result. If something looks wrong, verify against source — surprising ≠ defective.
  - Probe the backend directly with curl/http_client when UI does client-side validation. Backend trusting client is a common defect class.
  - Reset between scenarios (refresh/navigate/clear) so failures are not carryover.

PHASE 3 — Report:
  - Bugs: one-line summary, severity (data-loss > security > correctness > UX), minimal repro, expected vs actual, file:line.
  - Coverage: which classes ran, which were skipped and why.
  - Gaps: state explicitly that visual/layout, performance, cross-browser, and tight-timing races are NOT covered.
  - Recommendations: one-line fix direction per bug.
</protocol>

<constraints>
- Do not skip Phase 1. Invented selectors and scenarios produce noise reports.
- Verify each suspected bug against source before reporting — surprising behaviour may be intentional.
- Do not write .spec.ts files. Do not edit source code in this session.
- Do not use real credentials unless the user provided them. Stop at auth walls; describe what would follow.
- Do not request screenshots — non-multimodal coder cannot read them. Use browser_snapshot for everything.
- BEFORE destructive scenarios (data at scale, privilege escalation on real backend, deleting records, payment bypass, SQL injection/XSS payloads), STOP and ask.
- BEFORE running adversarial scenarios on a URL that is not clearly localhost/staging, ask the user.
- Denied permission = stop signal. Do not retry the denied action.
- After ~20 browser actions, pause and ask the user whether to continue. Long sessions burn tokens and patience.
- Two failed retries on the same step → move on, note in report.
</constraints>

<output>
- Phase 1: surface map (1-3 lines per category) + scenario matrix list.
- Phase 2: per scenario — action, snapshot delta, judgement (pass/suspected/verified bug).
- Phase 3: structured report.
- Final line: \`Found: <N> bugs (<S1> severity1, <S2> severity2, …). Covered: <X>/<Y> scenario classes.\`
</output>`
}
