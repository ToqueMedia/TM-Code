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
import { buildE2EPrompt } from './e2ePrompt'

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
 * `/te2e <what to validate>` — agent drives a real browser to smoke-check
 * the live preview. Uses the Playwright MCP server (lazy-spawned). The
 * user opted into the slash command; browser actions run without
 * per-action prompts so the test flows uninterrupted.
 *
 * Exploratory validation only — happy path plus one cheap edge, not a
 * 12-class adversarial matrix. No spec files, no source edits.
 */
export async function executeE2E(
  args: string,
  projectPath: string,
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
  // free users to paid; a live browser session is one of the wedges.
  // Surface a clear upgrade message and open Settings.
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

  // Sticky label for this run — not a thinking switch. Effort follows
  // the user's selector; the worker has no e2e sidecar.
  const agentService = AgentService.getInstance()
  agentService.setRequestType('e2e')
  try {
    await runAgentWithCallbacks(buildE2EPrompt(args, projectPath), {
      // Bubbles already created above — don't duplicate.
      addUserMessage: false,
      skipStartAssistantMessage: true,
    })
  } finally {
    agentService.setRequestType(null)
  }
}
