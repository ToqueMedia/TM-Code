import { useChatStore } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { useBillingStore } from '../../../stores/billingStore'
import { useLayoutStore } from '../../../stores/layoutStore'
import AgentService from '../agentService'
import { runAgentWithCallbacks } from '../agentRunner'
import { getQueryGuard } from '../queryGuard'
import { browserSession } from '../../browserSessionManager'
import { trackEvent } from '../../analytics'
import { logger } from '../../../utils/logger'
import { t } from '../../../i18n'
import { languageDirective } from './_languageInstruction'
import type { SlashCommandMode } from '../slashCommandRegistry'

/**
 * Classify a `browserSession.start()` failure so we surface the right fix.
 * The previous handler always told the user to install Chrome, even when
 * the actual cause was `npx` missing from PATH — which is the more common
 * failure on a fresh Tauri-from-Finder launch in macOS, because Tauri
 * inherits a stripped PATH (`/usr/bin:/bin:...`) and `nvm`/Homebrew Node
 * binaries are nowhere on it. See `src-tauri/src/commands/mcp.rs:100-140`
 * for the PATH augmentation we apply server-side — when even that fails,
 * the user genuinely doesn't have Node installed.
 *
 * Detection rules (in priority order):
 *   - `ensureTestBrowser` throws its own english string → no Chromium
 *     browser detected — user really does need to install Chrome.
 *   - `os error 2` / `ENOENT` / `No such file or directory` in the MCP
 *     spawn failure → the command itself wasn't found. For the browser
 *     server that command is `npx`, so Node/npm is the gap.
 *   - `os error 13` / `EACCES` / `permission denied` → executable found
 *     but not runnable. Rare; usually a manually-installed Node with
 *     bad perms.
 *   - Anything else falls through to a generic message that quotes the
 *     raw error so support can diagnose without screenshots.
 */
function diagnoseBrowserStartFailure(message: string): { kind: string; remedy: string } {
  if (/No Chromium-based browser available/i.test(message)) {
    return {
      kind: 'no_browser',
      remedy:
        'No Chromium-based browser was detected. Install **Google Chrome**, **Microsoft Edge**, or **Brave**, then try `/te2e` again.',
    }
  }
  if (/os error 2|ENOENT|No such file or directory/i.test(message)) {
    return {
      kind: 'node_missing',
      remedy:
        '`/te2e` needs **Node.js** to launch the Playwright MCP server — the `npx` command was not found on the IDE\'s PATH.\n\n' +
        '**Fix:**\n' +
        '- macOS: `brew install node` (or install from https://nodejs.org — pick Node 20 LTS or newer).\n' +
        '- Windows: install Node 20 LTS from https://nodejs.org.\n' +
        '- Linux: `sudo apt install -y nodejs npm` (Debian/Ubuntu) or your distro equivalent.\n\n' +
        'After installing, **fully quit and reopen TM Code** so it picks up the new PATH, then re-run `/te2e`.',
    }
  }
  if (/os error 13|EACCES|permission denied/i.test(message)) {
    return {
      kind: 'permission_denied',
      remedy:
        'The MCP server binary was found but couldn\'t be executed (permission denied). Run `chmod +x` on your Node install, or reinstall Node.js from the official installer at https://nodejs.org.',
    }
  }
  if (/profile in use|SingletonLock/i.test(message)) {
    return {
      kind: 'profile_locked',
      remedy:
        'The browser profile is locked from a previous session. Close any leftover Chrome window owned by TM Code and try `/te2e` again. If it persists, restart the IDE — the lock files clear automatically on next start.',
    }
  }
  return {
    kind: 'unknown',
    remedy:
      'Tip: confirm Node.js is installed (`node --version` in your terminal — needs 20+) and that Chrome/Edge/Brave is available. Restart TM Code after installing either, then retry. Share the error above if the problem persists.',
  }
}

/**
 * `/te2e <what to validate>` — agent drives a real browser to validate
 * the live preview. Uses the Playwright MCP server (lazy-spawned). The
 * user opted into the slash command; browser actions run without
 * per-action prompts so the test flows uninterrupted.
 *
 * No spec files written, no CI artifacts — exploratory validation only.
 * For regression in CI, the user writes specs by hand.
 */
export async function executeE2E(
  args: string,
  projectPath: string,
  mode: SlashCommandMode = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()

  // Pre-condition: don't fire while another agent turn is in progress.
  // /te2e dispatches its own multi-turn loop and shares the chat surface;
  // running two in parallel produces the disjoint-output we saw in the
  // earlier session log (two "_Starting browser session…_" placeholders
  // racing the same assistant bubble). Same guard /review uses.
  const queryGuard = getQueryGuard()
  if (queryGuard.getSnapshot()) {
    chatStore.addSystemMessage(
      t('e2e.busy')
    )
    return
  }

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
      t('e2e.usage')
    )
    return
  }

  // Render the user bubble + an assistant placeholder IMMEDIATELY so the
  // user sees their command land before the (slow) browser boot starts.
  // Without this, browserSession.start() can take 5–30s on first run
  // (npx download + Chrome cold-start) with zero feedback in the chat —
  // the user thinks it froze. We then stream the rest of the work into
  // this same assistant bubble (skipStartAssistantMessage below stops
  // runAgentWithCallbacks from creating a second one).
  const agentStore = useAgentStore.getState()
  chatStore.addUserMessage(`/te2e ${args}`)
  chatStore.startAssistantMessage()
  agentStore.setStatus('awaiting_response')
  chatStore.appendTextDelta('_' + t('e2e.starting') + '_\n\n')

  // Eagerly boot the MCP server so its tools are registered before the
  // agent's first turn. If browser detection fails, the dialog surfaces
  // and the agent never starts — clean abort.
  try {
    await browserSession.start()
    void trackEvent('e2e_session_started', { plan })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('te2e', 'Browser MCP failed to start', err)
    const { kind, remedy } = diagnoseBrowserStartFailure(msg)
    void trackEvent('e2e_session_start_failed', { plan, reason: msg.slice(0, 100), kind })
    // Replace the optimistic placeholder with the failure detail and
    // close the bubble cleanly so the next turn can start fresh.
    chatStore.appendTextDelta(
      `\n\nCould not start the browser session:\n\`${msg}\`\n\n${remedy}`
    )
    chatStore.finalizeAssistantMessage()
    agentStore.setStatus('error')
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
      // Bubbles already created above — don't duplicate.
      addUserMessage: false,
      skipStartAssistantMessage: true,
      // CMD mode → cwd-scoped tool executor so read_dev_server_logs /
      // browser controls / project reads resolve against the CMD project.
      cmdOnlyMode: mode === 'terminal',
    })
  } finally {
    agentService.setRequestType(null)
  }
}

function buildE2EPrompt(request: string, projectPath: string): string {
  return `<role>
Adversarial QA engineer. The user wants bugs in this feature, not happy-path confirmation. Derive the surface from the code, drive scenarios designed to break it, reason before acting. Reasoning is forced ON for every turn — use it.
</role>

<language>${languageDirective()}</language>

<request>${request}</request>
<project_path>${projectPath}</project_path>

<protocol>
Three phases. Do not collapse them.

PHASE 1 — Discover (read code first):
  - Read every file that touches the feature: components, routes, guards, stores, validation schemas, API endpoints, error handlers.
  - Build a surface map: inputs, states, validations PRESENT and MISSING, side effects, anticipated error paths.
  - Derive a scenario matrix covering the classes that apply: happy, empty/blank, boundary (max+1, min-1, very long), invalid format (no @, weak password, unicode, emojis, whitespace), state transitions (anon→protected, expired token, refresh mid-action), network (offline, 4xx/5xx via direct backend calls), persistence (refresh, back/forward, multi-tab), concurrency (double-submit, race), authorization (access without perm, IDOR), AND visual/UI (layout breaks, contrast, label/role mismatches, focus order, error-state styling). Skip non-applicable classes but say so.
  - Confirm dev server URL via \`read_dev_server_logs\`; \`start_dev_server\` if needed.

PHASE 2 — Execute:
  - Navigate. Snapshot (\`mcp__browser__browser_snapshot\`) — accessibility tree is the structural source of truth (roles, labels, refs).
  - For visual concerns (layout, contrast, alignment, missing visual feedback), call \`mcp__browser__browser_take_screenshot\`. On paid plans the backend has a multimodal pipeline that pre-processes images, so screenshots are not blind data — request them when the bug class is visual.
  - For each scenario: drive inputs → snapshot (and screenshot if visual) after → reason about the result. If something looks wrong, verify against source — surprising ≠ defective.
  - Probe the backend directly with curl/http_client when UI does client-side validation. Backend trusting client is a common defect class.
  - Reset between scenarios (refresh/navigate/clear) so failures are not carryover.

PHASE 3 — Report:
  - Bugs: one-line summary, severity (data-loss > security > correctness > UX/visual), minimal repro, expected vs actual, file:line.
  - Coverage: which classes ran, which were skipped and why.
  - Gaps: state explicitly any class you couldn't cover (e.g. cross-browser when only Chromium ran, tight-timing races, performance).
  - Recommendations: one-line fix direction per bug.
</protocol>

<constraints>
- Do not skip Phase 1. Invented selectors and scenarios produce noise reports.
- Verify each suspected bug against source before reporting — surprising behaviour may be intentional.
- Do not write .spec.ts files. Do not edit source code in this session.
- Do not use real credentials unless the user provided them. Stop at auth walls; describe what would follow.
- Use \`browser_snapshot\` for selectors and structure; use \`browser_take_screenshot\` for visual checks (paid-plan multimodal handles the image side-channel). Don't use screenshots when a snapshot is sufficient — they cost more tokens.
- BEFORE destructive scenarios (data at scale, privilege escalation on real backend, deleting records, payment bypass, SQL injection/XSS payloads), STOP and ask.
- BEFORE running adversarial scenarios on a URL that is not clearly localhost/staging, ask the user.
- After ~20 browser actions, pause and ask the user whether to continue. Long sessions burn tokens and patience.
- Two failed retries on the same step → move on, note in report.
</constraints>

<output>
- Phase 1: surface map (1-3 lines per category) + scenario matrix list.
- Phase 2: per scenario — action, snapshot/screenshot delta, judgement (pass/suspected/verified bug).
- Phase 3: structured report.
- Final line: \`Found: <N> bugs (<S1> severity1, <S2> severity2, …). Covered: <X>/<Y> scenario classes.\`
</output>`
}
