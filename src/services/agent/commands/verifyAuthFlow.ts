/**
 * Verification gate for the `#auth-*` scaffold flow — claude-vaz parity
 * adapted to auth scaffolding specifically.
 *
 * After the main agent finishes scaffolding the auth proxy + frontend
 * (provision_auth + routes + helpers), this sub-agent runs an adversarial
 * verification pass against the actual running endpoint. Its only job is
 * to detect the documented failure modes from the `auth-proxy` skill —
 * `MISSING_REQUEST_URI`, `INVALID_CREDENTIAL_OR_PROVIDER_ID`, the `/v2`
 * path slip, `404` from a missing Vite proxy — and surface them as a
 * structured verdict.
 *
 * Why a separate function instead of the generic `verify` tool:
 *
 *   1. The generic tool is OPT-IN — the main agent decides whether to
 *      call it. For auth this is a known failure surface (Identity
 *      Toolkit's shape is non-obvious, the model drifts to the simpler
 *      `{ idToken }` body under generation pressure — see BugHunter
 *      May 2026). We force-run the verifier regardless of what the
 *      main agent claims.
 *
 *   2. The system prompt is auth-specific: the bogus-token curl, the
 *      error-code table, the verification commands all map 1:1 to the
 *      checks the auth-proxy skill documents. Generic verifier doesn't
 *      know what to look for.
 *
 *   3. The flow LOOPS on FAIL — the diagnostic is fed back to the main
 *      agent as a fix prompt, up to N retries, before surfacing to the
 *      user. The generic verifier returns to its caller without auto-
 *      correction.
 *
 * Pattern is otherwise identical to `/review`: createLightweight +
 * read-only tool palette + createSubAgentVisibility wiring + parse
 * `VERDICT:` line at the end of the assistant text.
 */
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import AgentService from '../agentService'
import ToolExecutor from '../toolExecutor'
import { extractCriticalSections } from '../contextBuilder'
import { logger } from '../../../utils/logger'
import type { Provider } from './authCommand'
import { parseVerdict, type AuthVerdict } from './authVerdict'

export type { AuthVerdict }

export interface VerifyAuthResult {
  verdict: AuthVerdict
  /** The sub-agent's full report text, including the VERDICT line. Used
   *  for both the chat-visible summary and the fix-pass prompt fed back
   *  to the main agent. */
  report: string
}

/**
 * Run the auth-flow verifier sub-agent. Streams its output into the
 * existing assistant bubble (same as /review). Returns parsed verdict
 * + raw report so the caller can decide whether to loop.
 *
 * Throws only on infra failures (sub-agent crash, missing tools). A
 * `FAIL` verdict from the model is returned normally — not thrown.
 */
export async function runAuthFlowVerification(args: {
  projectPath: string
  providers: Provider[]
  authProxySkill: string
  googleSigninSkill: string | null
  /** True when the calling flow ran in CMD mode. The scaffold turn enables
   *  toolExecutor.enableCmdMode(...) for its duration but disables it on
   *  exit — by the time we get here the executor has fallen back to
   *  useProjectStore.currentProject (empty in CMD). Without re-enabling
   *  cmdMode for the verifier, every read_file / search_files / glob
   *  fails with "No project is open." Same pattern as reviewCommand:177. */
  cmdMode: boolean
}): Promise<VerifyAuthResult> {
  const { projectPath, providers, authProxySkill, googleSigninSkill, cmdMode } = args
  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()
  const toolExecutor = ToolExecutor.getInstance()

  // Re-enable cmdMode for the verifier's tool calls in CMD-launched flows.
  // The flag is captured at entry and threaded through to the finally block
  // so we never disable a mode someone else owned.
  if (cmdMode) {
    toolExecutor.enableCmdMode(projectPath)
  }

  // The verifier's tool palette: read-only + execute (for curl). Mirrors
  // the generic `verify` tool's allowlist; the difference is in the
  // system prompt below, which is auth-specific.
  const VERIFIER_TOOL_NAMES = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'glob',
    'get_diagnostics',
    'read_dev_server_logs',
    'read_large_result',
    'read_skill',
    'start_dev_server',
    'execute_command',
  ])
  const verifierTools = toolExecutor.getToolDefinitions()
    .filter(t => VERIFIER_TOOL_NAMES.has(t.function.name))
    .map(t => {
      if (t.function.name === 'execute_command') {
        return {
          ...t,
          function: {
            ...t.function,
            description: t.function.description
              + ' RESTRICTION: You are a READ-ONLY verifier. Only run diagnostic commands'
              + ' (curl, npx tsc --noEmit, npm test, ls, cat). Do NOT run commands that'
              + ' modify the project (no redirects >, >>, no sed -i, no mv/cp/rm of'
              + ' project files, no npm install of new deps).',
          },
        }
      }
      return t
    })

  const abortController = new AbortController()
  const stopHandler = () => abortController.abort()
  if (typeof window !== 'undefined') {
    window.addEventListener('agent-stop-requested', stopHandler, { once: true })
  }

  const readOnlyId = toolExecutor.enterReadOnlyMode()

  // Frame the next assistant bubble so the user understands the verifier is
  // an automatic post-scaffold step, not a new turn that started by itself.
  // A user reported the previous behaviour as "the agent auto-started a new
  // turn with 'Running auth-flow verification…'" — adding an explicit system
  // line here moves the cue from inside the assistant bubble (italicised
  // text that reads like a tool log) to a system frame that clearly belongs
  // to the IDE.
  chatStore.addSystemMessage(
    'Running an automated check on the auth flow before handing it back to you.',
  )

  // The main agent's scaffold bubble is already finalized at this point —
  // appendTextDelta would no-op. Open a fresh assistant bubble dedicated
  // to the verifier so its tool calls and verdict text stream into a
  // visible place. /review and the generic `verify` tool use the same
  // pattern. Always paired with finalizeAssistantMessage in the finally
  // block below so subsequent turns don't accidentally stream into this
  // bubble.
  chatStore.startAssistantMessage()
  agentStore.setStatus('awaiting_response')
  chatStore.appendTextDelta('_Running auth-flow verification…_\n\n')

  const subAgent = AgentService.createLightweight({
    tools: verifierTools,
    readOnly: true,
    // Auth verification is bounded: read 2-3 files, start the dev server,
    // 2-4 curl probes, compose a verdict. 20 turns is plenty; cap prevents
    // a stuck model burning the whole token budget.
    maxTurns: 20,
    abortController,
  })

  // No setRequestType call needed: reasoning is always ON when the active
  // model supports it (handled in agentService.buildRequestBody), so the
  // verifier inherits thinking by default. The X-Request-Type header
  // would only be useful here for backend analytics/billing tagging —
  // not worth coupling a sub-agent identity to a request type the proxy
  // also accepts from real /review runs.
  subAgent.setSystemPrompt(buildVerifierSystemPrompt(projectPath, providers))

  const { createSubAgentVisibility } = await import('../subAgentVisibility')
  const visibility = createSubAgentVisibility({
    parentToolCallId: undefined,
    reasoningLabel: 'auth verify',
    hooks: {
      // Buffered — sub-agent SSE goes through the same 50ms coalescer the
      // parent agent uses, so a verifier streaming at 100 tok/s lands as
      // ~20 batched renders/s instead of 100 individual streamingVersion bumps.
      appendTextDelta: appendTextDeltaBuffered,
      appendReasoningDelta: appendReasoningDeltaBuffered,
      addPendingToolCall: chatStore.addPendingToolCall,
      updateToolCallWithArgs: chatStore.updateToolCallWithArgs,
      updateToolCallWithResult: chatStore.updateToolCallWithResult,
      setStatus: (s) => agentStore.setStatus(s),
    },
  })

  let reportBuffer = ''
  let crashedWith: string | null = null

  try {
    await subAgent.runAgentLoop(buildVerifierPrompt(providers, authProxySkill, googleSigninSkill), [], {
      onTextDelta: (delta) => {
        reportBuffer += delta
        visibility.callbacks.onTextDelta(delta)
      },
      onReasoningDelta: visibility.callbacks.onReasoningDelta,
      onToolCallPending: visibility.callbacks.onToolCallPending,
      onToolCallStart: visibility.callbacks.onToolCallStart,
      onToolResult: visibility.callbacks.onToolResult,
      onTurnComplete: () => {},
      onDone: (finalText) => {
        if (finalText && !reportBuffer) reportBuffer = finalText
      },
      onError: (error) => {
        crashedWith = error.message
        visibility.cleanupOrphans(`aborted: auth verify failed — ${error.message}`)
      },
      onUsageUpdate: (input, output) => {
        chatStore.addTokenUsage(input, output)
      },
    })
  } catch (err) {
    crashedWith = err instanceof Error ? err.message : String(err)
    logger.error('verifyAuth', 'Sub-agent crashed', err)
  } finally {
    toolExecutor.exitReadOnlyMode(readOnlyId)
    // Only disable cmdMode if we were the ones who enabled it — never
    // touch a mode another caller may own.
    if (cmdMode) {
      toolExecutor.disableCmdMode()
    }
    // Close the verifier's bubble so the next turn (fix pass OR the
    // user's next prompt) starts on a clean slate. Idempotent — if the
    // sub-agent already finalised internally, this is a no-op.
    chatStore.finalizeAssistantMessage()
    agentStore.setStatus('idle')
    if (typeof window !== 'undefined') {
      window.removeEventListener('agent-stop-requested', stopHandler)
    }
  }

  if (crashedWith) {
    return {
      verdict: 'PARTIAL',
      report: `Verifier sub-agent failed to complete: ${crashedWith}. Could not confirm whether the auth flow works.`,
    }
  }

  return {
    verdict: parseVerdict(reportBuffer),
    report: reportBuffer,
  }
}

function buildVerifierSystemPrompt(projectPath: string, providers: Provider[]): string {
  const wantsGoogle = providers.includes('google')
  const wantsEmail = providers.includes('email-password')

  return `You are an auth-flow verification specialist. Your only job is to confirm the auth proxy backend actually works end-to-end against Identity Toolkit. You do not fix bugs — you find them and report.

You have two failure modes to recognise in yourself. First, **verification avoidance**: reading the code, narrating what you would test, writing "PASS", moving on. Second, **happy-path optimism**: \`curl /api/health\` returns 200 so you assume the rest works. Both leave the documented failure modes (MISSING_REQUEST_URI, INVALID_CREDENTIAL_OR_PROVIDER_ID, \`/v2\` path slip, missing Vite proxy) undetected. Your value is in catching those before the developer does.

=== CRITICAL: DO NOT MODIFY THE PROJECT ===
You CANNOT create, modify, or delete project files. You can read, search, and execute diagnostic commands (curl, npx tsc --noEmit, npm test, ls, cat). The execute_command tool is annotated with the same restriction.

You MAY start the dev server (start_dev_server) and read its logs (read_dev_server_logs). You MAY write ephemeral test scripts to \`/tmp\` if a multi-step probe needs one. Do not redirect or sed-i anything inside the project.

=== WHAT YOU'RE VERIFYING ===
${wantsEmail ? `- POST /api/auth/proxy/signup
- POST /api/auth/proxy/signin
- POST /api/auth/proxy/refresh
- GET  /api/auth/me  (JWT-protected; expect 401 without Authorization header)\n` : ''}${wantsGoogle ? `- POST /api/auth/proxy/google  (THIS is the failure-prone one — see "Critical probes" below)\n` : ''}
The proxy forwards to \`https://identitytoolkit.googleapis.com/v1/accounts:*\`. Routes live under \`server/\` (or wherever the backend was scaffolded — search if not obvious).

Project root: ${projectPath}

=== VERIFICATION SEQUENCE ===
1. **Read the proxy implementation.** Use \`search_files\` or \`glob\` to find the route file (look for "auth/proxy/${wantsGoogle ? 'google' : 'signin'}"). Read it in full. Note the request-body shape sent to Identity Toolkit.
2. **Type-check the project.** \`execute_command\` running \`npx tsc --noEmit 2>&1\` (or the project's equivalent). TS errors = automatic FAIL — the scaffold didn't compile.
3. **Ensure the dev server is running.** Call \`read_dev_server_logs\` first. If no server is up, call \`start_dev_server\` and wait for the "ready" / "listening" log line. If the server fails to start, that is FAIL with the error from logs.
4. **Run the critical probes below.** Each one must have a Command run block + Output observed block.
5. **Compose the verdict.** End with the literal line \`VERDICT: PASS\` / \`FAIL\` / \`PARTIAL\`.

=== CRITICAL PROBES — these are the documented failure modes ===

${wantsGoogle ? `**Probe G1 — Google sign-in bogus-token (catches MISSING_REQUEST_URI + INVALID_CREDENTIAL_OR_PROVIDER_ID):**
\`\`\`
curl -s -o /tmp/g.json -w "%{http_code}\\n" -X POST http://localhost:5173/api/auth/proxy/google \\
  -H "Content-Type: application/json" -d '{"idToken":"bogus"}' && cat /tmp/g.json
\`\`\`

Pass criteria (one of):
- **401** with JSON containing \`INVALID_IDP_RESPONSE\` / \`INVALID_ID_TOKEN\` / similar "fake token rejected" code. This means the proxy reached Identity Toolkit with a valid shape and ITK rejected the fake credential — the proxy is correct.

Fail criteria (each maps to a fixable bug):
- **401** with JSON containing \`MISSING_REQUEST_URI\`: the proxy did NOT send \`postBody\` + \`requestUri\` to ITK. Body shape is wrong. Refer to \`auth-proxy/SKILL.md\` ### CRITICAL block "signInWithIdp requires postBody + requestUri". This is FAIL.
- **401** with JSON containing \`INVALID_CREDENTIAL_OR_PROVIDER_ID\` AND the error message echoes \`provider_id=\` (snake_case): \`postBody\` used snake_case. Refer to \`auth-proxy/SKILL.md\` ### CRITICAL "providerId camelCase". This is FAIL.
- **502** with HTML body: upstream URL wrong (typically \`/v2/accounts:signInWithIdp\` instead of \`/v1\`). FAIL.
- **404** with HTML body: Vite proxy not wired — \`vite.config.ts\` needs \`server.proxy['/api']\`. FAIL.
- **500**: backend crashed. Read \`read_dev_server_logs\` for the stack trace. FAIL with the trace.

` : ''}${wantsEmail ? `**Probe E1 — Signin with bogus credentials (catches missing tenantId, wrong path):**
\`\`\`
curl -s -o /tmp/e.json -w "%{http_code}\\n" -X POST http://localhost:5173/api/auth/proxy/signin \\
  -H "Content-Type: application/json" -d '{"email":"x@x.co","password":"wrong"}' && cat /tmp/e.json
\`\`\`

Pass criteria: **401** with JSON containing \`INVALID_LOGIN_CREDENTIALS\` / \`EMAIL_NOT_FOUND\` / \`INVALID_PASSWORD\`.
Fail criteria:
- **502** with HTML: \`/v2\` slip or wrong host. FAIL.
- **404**: Vite proxy missing. FAIL.
- **400** with body containing \`MISSING_REQUIRED_FIELD : tenantId\` or similar: proxy didn't forward \`tenantId\`. FAIL.

**Probe E2 — /api/auth/me without token (catches JWT middleware misconfig):**
\`\`\`
curl -s -o /dev/null -w "%{http_code} %{content_type}\\n" http://localhost:5173/api/auth/me
\`\`\`

Pass: \`401 application/json\`. Fail: anything else (404 HTML = route missing or Vite proxy gone; 500 = JWKS misconfigured).

**Probe E3 — Session persistence wiring (catches the recurring "refresh logs out" bug):**

Login working is half the scaffold. The other half is rehydration: after a hard refresh, the auth store must re-read the saved token and call \`/api/auth/me\` BEFORE the first paint, or AuthGuard sees \`user: null\` and redirects to /login. This probe is **static analysis** — search the project for the three things that must coexist. Any one missing = FAIL.

Steps (all three required):

1. Find the auth store (search for \`signin\` / \`signup\` action with proxy fetch — typically \`src/stores/authStore.ts\`, \`src/lib/authStore.ts\`, or similar). Confirm:
   - On successful proxy response, it calls \`setAuthToken(...)\` (any name — the helper that writes \`sessionStorage\` / \`localStorage\` / cookie). \`grep -rn "setAuthToken\\|sessionStorage.setItem\\|localStorage.setItem.*token" src/\` should show writes inside login/signup actions.
   - It exposes an \`init\` (or \`bootstrap\` / \`rehydrate\`) action that calls \`/api/auth/me\` and sets the user from the response. \`grep -rn "/api/auth/me" src/\` plus reading the store should confirm.

2. Open \`src/main.tsx\` (or \`src/main.ts\`, \`src/index.tsx\` — whichever holds \`createRoot(...).render(...)\`). Confirm \`useAuthStore.getState().init()\` (or the store's bootstrap action — name varies) is called **before** \`render(<App/>)\`. The canonical shape is:
   \`\`\`
   useAuthStore.getState().init().finally(() => {
     createRoot(document.getElementById('root')!).render(<App />)
   })
   \`\`\`
   A bare \`createRoot(...).render(<App/>)\` with init in a component \`useEffect\` is FAIL — the first paint happens with empty user and AuthGuard already redirected to /login.

3. Spot-check: the persistence helper actually reads from storage at module load. \`grep -n "getItem.*token\\|getItem.*idToken" src/\` should find at least one read, in the same file as \`setAuthToken\`.

Pass criteria: all three present. Fail criteria: any one missing — name the missing piece in the verdict (e.g. "FAIL: main.tsx renders without calling init(); refresh will land on /login").

` : ''}=== OUTPUT FORMAT ===
Every check MUST follow this structure. A check without a Command run block is not a PASS — it's a skip.

### Check: [what you're verifying]
**Command run:**
\`\`\`
[exact command — paste it verbatim, do not summarise]
\`\`\`
**Output observed:**
\`\`\`
[actual terminal output — copy-paste]
\`\`\`
**Result:** PASS (or FAIL — with "Expected vs Actual: ...")

=== END FORMAT ===

End with exactly ONE of these lines (parsed by the IDE):

VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL

Rules:
- **PASS** only if every critical probe ran AND every result matched a "pass criteria" above.
- **FAIL** if any critical probe matched a "fail criteria". Include the specific failure code in your report so the next iteration can target the fix.
- **PARTIAL** only for environmental limitations (dev server can't start because port in use; ITK is unreachable from this network). NOT for "I'm unsure" — you have to decide PASS or FAIL.

Use the literal string \`VERDICT: \` followed by exactly one of \`PASS\`, \`FAIL\`, \`PARTIAL\`. No markdown, no extra punctuation.`
}

function buildVerifierPrompt(
  providers: Provider[],
  authProxySkill: string,
  googleSigninSkill: string | null,
): string {
  // Skill slicing: the main agent already received the FULL skill content
  // during the scaffold turn. The verifier doesn't need the whole 800-line
  // body to do its job — only the CRITICAL blocks tell it what to check
  // and what failure codes to map to which rule. Inlining the full skill
  // for every verification iteration (worst case 3) would duplicate ~2.5K
  // lines per `#auth-google` flow with no informational gain.
  //
  // `extractCriticalSections` pulls H2 `## CRITICAL` blocks, the
  // `## Hard rules` block, AND orphan `### CRITICAL —` H3 blocks under
  // non-critical H2s (which is where the MISSING_REQUEST_URI rule lives
  // in the auth-proxy skill). Falls back to the full skill on the rare
  // case the slice comes back empty — better verbose than blind.
  const authCritical = extractCriticalSections(authProxySkill) || authProxySkill
  const googleCritical = googleSigninSkill
    ? (extractCriticalSections(googleSigninSkill) || googleSigninSkill)
    : null

  return [
    `<auth_skill_critical name="auth-proxy">`,
    authCritical,
    `</auth_skill_critical>`,
    ...(googleCritical
      ? [``, `<auth_skill_critical name="google-signin">`, googleCritical, `</auth_skill_critical>`]
      : []),
    ``,
    `Above are the CRITICAL blocks of the auth skills — the rules whose violation`,
    `produces the documented failure modes (MISSING_REQUEST_URI, INVALID_CREDENTIAL_OR_PROVIDER_ID,`,
    `etc.). The full skill body is not included here on purpose; use \`read_skill\` if you`,
    `need an endpoint shape or error-code mapping the criticals don't cover.`,
    ``,
    `The main agent just scaffolded auth for providers: ${providers.join(', ')}.`,
    ``,
    `Your task: verify the auth-proxy backend actually works against Identity Toolkit.`,
    `Follow the verification sequence in your system prompt — start with type-check, then`,
    `ensure dev server is up, then run the critical probes for the providers above.`,
    ``,
    `End with the VERDICT line. If FAIL, include the exact error code (e.g.`,
    `\`MISSING_REQUEST_URI\`) and which probe surfaced it so the next iteration knows`,
    `precisely what to fix.`,
  ].join('\n')
}

/**
 * Build a fix-pass prompt for the main agent when the verifier returns FAIL.
 * The diagnostic from the verifier is the only thing the main agent needs —
 * the skill content is still in conversation history from the scaffold turn.
 *
 * Kept terse on purpose. The main agent's surface is "code-edit",
 * not "investigate" — pointing it directly at the broken probe + the
 * skill's CRITICAL block is enough.
 */
export function buildAuthFixPrompt(verifierReport: string, attempt: number): string {
  return [
    `The auth-flow verifier returned FAIL on the implementation you just shipped.`,
    `Attempt ${attempt} of fixing this before we surface to the developer.`,
    ``,
    `Verifier report:`,
    `\`\`\``,
    verifierReport,
    `\`\`\``,
    ``,
    `Read the report carefully — the failing probe + the error code map 1:1 to a`,
    `CRITICAL block in the auth-proxy skill that's already in your context. Find the`,
    `relevant block, fix the proxy route (do NOT rewrite the whole scaffold), and`,
    `confirm by reading the file again before ending the turn. The verifier will`,
    `re-run automatically after this turn completes.`,
  ].join('\n')
}
