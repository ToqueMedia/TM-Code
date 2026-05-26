import { useChatStore } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { usePermissionStore } from '../../../stores/permissionStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { runAgentWithCallbacks } from '../agentRunner'
import { FileService } from '../../fileService'
import AgentService from '../agentService'
import ToolExecutor from '../toolExecutor'
import { preprocessHashtags } from '../hashtagRegistry'
import { detectAiAgentIntent, buildAiAgentPlatformLine } from '../aiAgentIntent'
import {
  READ_FILE, LIST_DIRECTORY, GLOB, SEARCH_FILES, GET_DIAGNOSTICS,
  READ_SKILL, WRITE_FILE, EDIT_FILE, CREATE_FILE,
  EXECUTE_COMMAND, START_DEV_SERVER,
  PROVISION_AUTH, REQUEST_CREDENTIALS, UPDATE_TASKS,
  ASK_USER_QUESTION, DELEGATE, COLLECT_RESULTS,
} from '../toolNames'
import { t } from '@/i18n'

async function fileExists(path: string): Promise<boolean> {
  try {
    await FileService.readFile(path)
    return true
  } catch {
    return false
  }
}

/**
 * Plan readiness check. With the scaffold + iterative-edits flow, the file
 * exists from the very first Write — but the plan isn't ready until the
 * architect's final Edit flips `Status: DRAFT` → `Status: PENDING APPROVAL`.
 * Without this check the IDE would render the approval card over a partially-
 * filled scaffold if the run is cut between Edits.
 *
 * Returns `{ ready: true }` only when the file is on disk AND contains the
 * PENDING APPROVAL marker. Returns `{ ready: false, reason }` otherwise so
 * the caller can surface why.
 */
type PlanReadiness = {
  ready: boolean
  reason?: 'missing' | 'draft' | 'unknown'
  content?: string
}

async function readPlanReadiness(path: string): Promise<PlanReadiness> {
  let content: string
  try {
    content = await FileService.readFile(path)
  } catch {
    return { ready: false, reason: 'missing' }
  }
  // Match the marker case-insensitively and tolerant of leading "> " quote
  // prefix (the template renders frontmatter as a markdown blockquote, but
  // the architect occasionally drops the prefix). Anchored to a line start.
  const hasReady = /^[>\s]*Status:\s*PENDING\s+APPROVAL\b/im.test(content)
  if (hasReady) return { ready: true, content }
  const hasDraft = /^[>\s]*Status:\s*DRAFT\b/im.test(content)
  return { ready: false, reason: hasDraft ? 'draft' : 'unknown', content }
}

export async function executePlan(
  args: string,
  projectPath: string,
  mode: 'chat' | 'terminal' = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()

  if (!args.trim()) {
    chatStore.addSystemMessage(
      'Usage: /plan <description of what you want to build>\n\n' +
      'Example: /plan user authentication with email, Google login, and role-based access'
    )
    return
  }

  // Auto-approve file diffs during plan generation — the plan approval card
  // is the real approval mechanism, so inline diff prompts are redundant.
  const permStore = usePermissionStore.getState()
  const prevAutoApprove = permStore.autoApproveDiffs
  permStore.setAutoApproveDiffs(true)

  // Run the architect agent with reasoning model (Qwen 3.6 Max-Preview via DashScope)
  const agentService = AgentService.getInstance()
  agentService.setRequestType('plan')
  // Mechanical enforcement of architect mode at the tool layer. Even if the
  // model ignores its system prompt and tries to call provision_auth /
  // execute_command / etc., the executor returns a block message instead.
  // Pairs with the buildArchitectSystemPrompt — prompt is the soft contract,
  // this is the hard one.
  const toolExecutor = ToolExecutor.getInstance()
  toolExecutor.enablePlanMode()
  try {
    // The architect role goes into a DEDICATED system prompt that REPLACES
    // the default IDE prompt — without the override, the IDE's "coding
    // agent who builds and ships features" instructions sit alongside the
    // architect role and the model picks the stronger signal (build the
    // app), skipping PLAN.md entirely. By making "you are the architect,
    // produce PLAN.md and stop" the only system prompt for this turn,
    // there is no other role to fall back to.
    // Detect routing hashtags (`#auth-google`, `#auth-email-password`,
    // `#design`) inside the args. Slash precedence means /plan dispatches
    // ahead of the hashtag flow — without this we'd lose the signal entirely
    // and the architect would propose generic auth (passport-google-oauth20)
    // instead of the TM Code-managed `provision_auth` + `auth-proxy`
    // pattern. Pass the detected requirements to the architect prompt so
    // the plan reflects the platform's canonical integrations.
    const hashtagSignals = preprocessHashtags(args)
    const aiAgentSignal = detectAiAgentIntent(args)
    await runAgentWithCallbacks(buildArchitectUserMessage(args, projectPath, hashtagSignals, aiAgentSignal), {
      addUserMessage: true,
      userMessageText: `/plan ${args}`,
      // Mode-aware: chat injects platform-publish constraints into the
      // architect prompt (firebase-admin baseline, Dockerfile, no SQL deps),
      // terminal swaps in a free-stack note (any host / DB / framework).
      // Same PLAN.md template + completion rules in both branches — only
      // the stack-choice constraints change.
      systemPromptOverride: buildArchitectSystemPrompt(mode),
      // CMD mode requires the tool executor to be aware of the cwd; without
      // cmdOnlyMode it falls back to useProjectStore.currentProject (empty
      // in CMD) and every file tool fails with "No project is open."
      cmdOnlyMode: mode === 'terminal',
    })
  } finally {
    agentService.setRequestType(null)
    toolExecutor.disablePlanMode()
    permStore.setAutoApproveDiffs(prevAutoApprove)
  }

  // Only show the approval card if PLAN.md is on disk AND complete. With the
  // scaffold + iterative-edits flow, the file exists from turn 2 — we wait
  // for the architect's final Edit that flips `Status: DRAFT` → `Status:
  // PENDING APPROVAL` before treating the plan as ready. Aborts and silent
  // write failures don't always flip agent status to 'error', so the Status
  // marker is the authoritative signal.
  if (useAgentStore.getState().status === 'error') return
  const readiness = await readPlanReadiness(`${projectPath}/PLAN.md`)
  if (!readiness.ready) {
    const reason = readiness.reason
    const message =
      reason === 'missing'
        ? 'Plan generation did not finish — PLAN.md was not written. Run /plan again to retry.'
        : reason === 'draft'
        ? 'Plan generation was cut off — PLAN.md is still in DRAFT. Type "Continue" to resume from the next unfilled section.'
        : 'Plan generation did not complete — PLAN.md is on disk but has no PENDING APPROVAL marker. Type "Continue" to let the architect finish, or run /plan again to retry from scratch.'
    chatStore.addSystemMessage(message)
    return
  }
  chatStore.addCardMessage('plan_approval', projectPath)
}

export async function handlePlanApprove(projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  // Ephemeral status — the approval action speaks for itself (the card moves
  // to "approved"); this is just a transitional "working on next phase" hint.
  // Self-removes once TODO generation finishes (or after ~8s, whichever first).
  chatStore.addSystemMessage(
    t('plan.generating'),
    undefined,
    { ephemeral: true },
  )

  // Auto-approve file diffs during TODO generation (same rationale as plan generation)
  const permStore = usePermissionStore.getState()
  const prevAutoApprove = permStore.autoApproveDiffs
  permStore.setAutoApproveDiffs(true)

  // Approval is the trigger that switches the agent BACK to the general IDE
  // system prompt. /plan ran on the architect-only prompt with planMode
  // mechanically blocking implementation tools; from this point on the agent
  // is the regular coding agent again. TODO generation re-uses the general
  // surface (read PLAN.md, write TODO.md — both already permitted) without
  // forced reasoning, and the user's own thinking preference takes over for
  // every turn that follows.
  try {
    await runAgentWithCallbacks(buildTodoPrompt(projectPath), {
      addUserMessage: true,
      userMessageText: 'Generate task list from approved plan',
    })
  } finally {
    permStore.setAutoApproveDiffs(prevAutoApprove)
  }

  // Same logic as /plan: only show the TODO card if TODO.md is on disk.
  if (useAgentStore.getState().status === 'error') return
  if (!(await fileExists(`${projectPath}/TODO.md`))) {
    chatStore.addSystemMessage(
      'Task list generation did not finish — TODO.md was not written. Approve the plan again to retry.',
    )
    return
  }
  chatStore.addCardMessage('todo_list', projectPath)
}

export function handlePlanRequestChanges(projectPath: string): void {
  const chatStore = useChatStore.getState()
  // Flip the revision flag. The NEXT user message routes to
  // `executePlanRevision` (via usePromptBar) instead of the normal chat
  // path. Without this, the revision feedback gets treated as a normal
  // coding prompt — the default IDE system prompt loads, the agent starts
  // IMPLEMENTING the original PLAN.md, and the user's feedback gets
  // bolted onto the implementation. The flag is the routing signal.
  chatStore.setPlanRevisionPending(projectPath)
  chatStore.addSystemMessage(
    'What changes would you like? Describe in the chat and the architect will revise the plan.'
  )
}

/**
 * Plan-revision flow — re-enters the architect role with the existing
 * PLAN.md as context plus the developer's revision feedback. The architect
 * edits PLAN.md (NOT implements it) and emits a fresh approval card.
 *
 * Routed from `usePromptBar.handleSend` when `chatStore.planRevisionPending`
 * is set. The flag is cleared by the caller (PromptBar) before this runs
 * so a subsequent message after the revision-turn falls back to the
 * normal path.
 */
export async function executePlanRevision(
  feedback: string,
  projectPath: string,
  mode: 'chat' | 'terminal' = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()

  // Read the current plan so the architect sees what to modify. If it's
  // gone (deleted, corrupted), fall back to re-running /plan from scratch
  // with the feedback as the new idea.
  let currentPlan: string | null = null
  try {
    currentPlan = await FileService.readFile(`${projectPath}/PLAN.md`)
  } catch {
    chatStore.addSystemMessage(
      'PLAN.md is missing — restarting plan from your feedback as a new idea.',
    )
    await executePlan(feedback, projectPath, mode)
    return
  }

  // Same architect-mode setup as /plan: forced reasoning, plan-mode tools,
  // auto-approve diffs (the approval card is the human gate, not the
  // per-diff prompt).
  const permStore = usePermissionStore.getState()
  const prevAutoApprove = permStore.autoApproveDiffs
  permStore.setAutoApproveDiffs(true)
  const agentService = AgentService.getInstance()
  agentService.setRequestType('plan')
  const toolExecutor = ToolExecutor.getInstance()
  toolExecutor.enablePlanMode()

  try {
    const revisionPrompt = buildArchitectRevisionMessage(feedback, projectPath, currentPlan)
    await runAgentWithCallbacks(revisionPrompt, {
      addUserMessage: true,
      userMessageText: feedback,
      systemPromptOverride: buildArchitectSystemPrompt(mode),
      cmdOnlyMode: mode === 'terminal',
    })
  } finally {
    agentService.setRequestType(null)
    toolExecutor.disablePlanMode()
    permStore.setAutoApproveDiffs(prevAutoApprove)
  }

  // Same readiness check as /plan. If the architect didn't flip Status
  // back to PENDING APPROVAL after the edits, surface that — the model
  // may have hit the stream cut mid-revision.
  if (useAgentStore.getState().status === 'error') return
  const readiness = await readPlanReadiness(`${projectPath}/PLAN.md`)
  if (!readiness.ready) {
    chatStore.addSystemMessage(
      readiness.reason === 'draft'
        ? 'Revision cut off — PLAN.md is back in DRAFT. Type "Continue" to resume.'
        : 'Revision did not complete. Type "Continue" or describe further changes to retry.',
    )
    return
  }
  chatStore.addCardMessage('plan_approval', projectPath)
}

function buildArchitectRevisionMessage(
  feedback: string,
  projectPath: string,
  currentPlan: string,
): string {
  return `The developer reviewed the plan you wrote and is requesting changes.

Their feedback:
"${feedback}"

Project root: ${projectPath}

The current PLAN.md (your previous version) is below. Your job this turn is to:

1. Read the feedback and identify what specific sections of PLAN.md need to change.
2. Edit PLAN.md to incorporate the feedback. Use \`${EDIT_FILE}\` for surgical changes (single section, a few tasks, one decision row). Use \`${WRITE_FILE}\` only if the feedback requires restructuring the document end-to-end.
3. If the implementation phases shift, update the task tracker via \`${UPDATE_TASKS}\` to mirror the new structure (same task-id convention: "1.1", "1.2", etc.).
4. Flip frontmatter \`Status:\` back to \`PENDING APPROVAL\` (or leave as-is if it's already there) — the IDE waits for this marker before re-rendering the approval card.
5. Post a 3-sentence chat summary of what you changed, then STOP. The developer will re-approve / re-request changes / reject from the new card.

**DO NOT implement the plan.** This is a revision turn, not an execution turn. Edits to PLAN.md only — no source files, no \`provision_auth\`, no \`start_dev_server\`, no \`execute_command\`. The tool executor enforces this mechanically; ignoring this rule produces tool blocks.

**DO NOT re-write PLAN.md from scratch unless the feedback explicitly asks for restructuring.** Targeted Edits preserve the parts the developer was happy with and keep the diff reviewable.

---

Current PLAN.md content:

\`\`\`markdown
${currentPlan}
\`\`\``
}

export function handlePlanReject(): void {
  const chatStore = useChatStore.getState()
  chatStore.addSystemMessage('Plan rejected. You can start a new plan with /plan.')
}

export async function handleStartExecution(projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  chatStore.addSystemMessage('Starting plan execution...')

  // Phase-gated execution. The previous version of this prompt told the
  // agent to march through every task in order — for an 18-task FULLSTACK
  // plan that produced a single 15-minute monolithic run with no preview-
  // able state until the very end. Phase-by-phase execution turns each
  // phase into an independently verifiable working iteration the developer
  // can review before the next phase starts.
  const executionPrompt = `Execute the development plan from TODO.md one phase at a time. Each phase is a self-contained, demo-able iteration the developer needs to validate before the next one starts — chaining phases together loses the developer's chance to course-correct early, and a wrong assumption in Phase 1 silently propagates to the end.

Resume directly. Do NOT recap PLAN.md, do NOT summarize TODO.md, do NOT preface with "I'll start by...", "Let me first review the plan", or "Vou começar a implementação". The developer wrote the plan with you — pick up Task 1.1 as if there were no break. The first sentence after this prompt should announce Task 1.1, not introduce the work.

## This turn — Phase 1

Read ${projectPath}/TODO.md and work through the tasks under the first \`## Phase 1\` section, in order. For each task:

1. Announce it in one line.
2. Mark it in_progress in the tracker: \`update_tasks\` with the existing task list, flipping THIS task's \`status\` to \`"in_progress"\`. Use the same task IDs the architect seeded (e.g., "1.1", "1.2") — do NOT invent new IDs and do NOT replace the list.
3. Implement the task completely.
4. Verify the acceptance criterion in TODO.md.
5. Mark it done in BOTH places: change \`- [ ]\` to \`- [x]\` in TODO.md AND \`update_tasks\` with this task's status flipped to \`"completed"\`.

The tracker and TODO.md must stay in sync — the developer's UI watches the tracker, TODO.md is the persistent record. Skipping the tracker update means the UI shows nothing happening even though work is progressing.

Once every Phase 1 task is checked off (in BOTH TODO.md and the tracker), verify the phase produces a working state with the check that fits its scope. For frontend or fullstack work, start_dev_server then read_dev_server_logs to confirm no errors, and briefly describe what the developer can now see or click in the preview. For backend or library work, get_diagnostics plus the relevant build or test command. For schema-only or migration-only phases, confirm the migration applied without errors.

### Auth-route smoke test (REQUIRED if the phase touched /api/auth/*)

If this phase added or modified any \`/api/auth/*\` route (\`auth-proxy\` skill applies), you MUST run a same-origin smoke test before claiming the phase complete. The bug pattern this catches: the route compiles, the dev server starts, type-checking passes — but the Vite proxy isn't wired so every \`fetch('/api/...')\` from the client hits port 5173 and returns 404 HTML. The phase looks done; login is silently broken. The test is one shell call:

\`\`\`bash
execute_command: curl -s -o /dev/null -w '%{http_code} %{content_type}\\n' http://localhost:5173/api/auth/me
\`\`\`

Expected: \`401 application/json...\` — the route exists, the proxy forwarded to the backend, and the JWT middleware rejected the absent token. Any other result is a regression:
- \`404 text/html\` → Vite proxy missing in \`vite.config.ts\` (the most common case). Fix \`server.proxy['/api']\` and re-run.
- \`500 application/json\` → backend crashed mid-request. read_dev_server_logs to find the error.
- \`200\` → middleware skipped or wrong route mounted. Check the order of \`app.use\` calls.
- Connection refused → backend port mismatched between server and proxy target.

If the phase also added a Google sign-in button, follow up with the bogus-token check. This catches THREE distinct upstream-config bugs the model commonly drifts into:

\`\`\`bash
execute_command: curl -s -X POST -H 'Content-Type: application/json' -d '{"idToken":"bogus"}' -w '\\nSTATUS=%{http_code}\\nCT=%{content_type}\\n' http://localhost:3001/api/auth/proxy/google
\`\`\`

**Read the response carefully — it discriminates between three failure modes:**

| Observed | Diagnosis | Fix |
|---|---|---|
| \`STATUS=401 CT=application/json...\` + JSON \`{"error":"..."}\` | ✅ Healthy. Identity Toolkit rejected the bogus token (as it should). | None — phase passes. |
| \`STATUS=502\` + JSON body | Backend reached ITK but mapping is off. Likely \`tenantId\` missing from the \`signInWithIdp\` body. | Check every \`signInWithIdp\`/\`signInWithPassword\`/\`signUp\` body in \`server/src/routes/auth*.ts\` includes \`tenantId: process.env.GIP_TENANT_ID\`. |
| \`STATUS=502\` + HTML body (\`<html>...</html>\`) OR \`STATUS=401\` + HTML body in your error | **Wrong upstream URL** — the proxy is calling a path that doesn't exist (e.g. \`/v2/accounts:signInWithIdp\` instead of \`/v1\`). Identity Toolkit returns HTML for unknown paths; the catch then maps to 401/502. | Open the auth proxy file. Grep for \`identitytoolkit.googleapis.com\`. The base URL MUST end in \`/v1\`. If it ends in \`/v2\`, change to \`/v1\`. The \`accounts:*\` family of endpoints is v1-only. |
| Connection refused on port 3001 | Backend port mismatch or server not started. | Check \`devServerLogs\` for the actual bound port. |

This is non-negotiable: the agent MUST run this curl before declaring an auth phase complete. The historical pattern (BugHunterKimi, BugHunterM) is the agent declaring "done" without curling, and the developer hits 401 in production-like testing — sometimes hours later.

### Port 5173 for GIP-auth projects

The GIP tenant has redirect URIs locked to \`http://localhost:5173\`. If Vite falls back to 5174, Google sign-in returns 400 \`redirect_uri_mismatch\`. **The IDE's start_dev_server already handles port conflicts automatically** — \`devServerManager\` detects \`EADDRINUSE\` and calls \`kill_port\` to clear the port, then retries once. Do NOT manually run \`lsof | xargs kill\` — that command kills WHATEVER is on the port (including the IDE's own dev server when you're running \`npm run tauri dev\`, causing a crash/reload).

After start_dev_server, verify the dev server logs show \`:5173\`. If for any reason Vite still falls back to 5174 after the IDE's auto-recovery, ask the developer to check what else is holding the port.

End the turn with a single hand-off line — "Phase 1 complete. <one-sentence working state>. Tell me to continue to start Phase 2." — and stop. The turn ends here even if Phase 1 finished early; the developer needs the gap to validate the working state before the next phase begins.

## When the developer replies

The hand-off cue is a hint, not a magic word. Read the developer's next message and judge intent. Treat it as a proceed-to-next-phase instruction whenever it expresses one — in any language, with any phrasing, with or without naming the phase, possibly combined with a tweak ("apply this and continue", "swap to Redis and start Phase 2"). When the message combines a change with a proceed cue, apply the change first, then run the requested phase under the same single-phase contract above.

When the message is something else — a question, a bug report on completed work, a standalone change request, a stop signal — handle it on its own. Starting a new phase as a side effect of an unrelated message robs the developer of the validation gap the contract is built around.

## Blockers

If a task in the current phase can't be completed, log the blocker in TMS.md's "Pending Tasks" section with a concrete next step, then hand off with the phase status — e.g., "Phase 2 blocked at Task 2.3. Reason: <blocker>. <what the developer can do to unblock>." Skipping ahead to a later phase to fill the turn hides the blocker and produces a working state the developer can't reproduce.

Update TMS.md's Memory section as you complete milestone phases. Start with the first uncompleted task in Phase 1.`

  await runAgentWithCallbacks(executionPrompt, {
    addUserMessage: true,
    userMessageText: 'Start executing the development plan',
  })
}

// ── Architect Prompt ──
// Split into a SYSTEM prompt (role + completion rule + template + constraints
// + self-check) and a USER message (the developer's idea + project path).
// Putting the role in `system` rather than `user` is the difference between
// "the model adopts the architect identity for this turn" and "the IDE coder
// is being asked to act like an architect" — only the former produces
// PLAN.md without the model defaulting to scaffolding/implementing.
//
// Follows key_prompts.md: U-Curve (§1+§11), few-shot (§3), role (§4),
// chain-of-thought (§5), constraints-as-contract (§6), context engineering (§7),
// Goldilocks (§8), output length (§14), error recovery (§15).

function buildArchitectUserMessage(
  userIdea: string,
  projectPath: string,
  signals?: { authProviders: ('google' | 'email-password')[]; hasDesign: boolean },
  aiAgent?: { namedModels: string[]; isConversational: boolean },
): string {
  // Architect-side platform context: when the developer's idea included
  // `#auth-google` / `#auth-email-password` / `#design`, surface them as
  // explicit requirements so the architect uses TM Code's canonical
  // integrations instead of inventing generic equivalents (e.g. passport
  // libraries, custom OAuth flows). The execution agent will then call
  // `provision_auth` to set up the GIP tenant when the plan runs.
  const platformLines: string[] = []
  if (signals?.authProviders.length) {
    const providers = signals.authProviders.map((p) =>
      p === 'google' ? 'Google sign-in' : 'email/password sign-in',
    ).join(' + ')
    platformLines.push(
      `Auth: the developer requested ${providers}. ` +
      `Use TM Code's canonical pattern — call \`provision_auth({ provider: "gip" })\` ` +
      `to create the per-project GIP tenant (writes VITE_FIREBASE_* + GIP_* keys to ` +
      `.env automatically), then implement the auth-proxy skill (Identity ` +
      `Toolkit REST endpoints + JWT verification via Google JWKS, no Firebase Admin ` +
      `SDK needed). Do NOT propose passport-google-oauth20, NextAuth, Auth0, or any ` +
      `other auth library — those would not integrate with the platform-managed ` +
      `tenant. Mention provision_auth + auth-proxy skill explicitly in the ` +
      `Implementation Phases.`
    )
  }
  if (signals?.hasDesign) {
    platformLines.push(
      `Design: the developer requested polished UI. Read the \`design\` skill ` +
      `during implementation; reflect it in the UI/UX section of PLAN.md.`
    )
  }
  if (aiAgent) {
    const aiLine = buildAiAgentPlatformLine(aiAgent)
    if (aiLine) platformLines.push(aiLine)
  }
  const platformBlock = platformLines.length > 0
    ? `\n\nPlatform requirements (from routing hashtags + intent extraction in the request):\n${platformLines.map(l => `- ${l}`).join('\n')}`
    : ''

  return `The developer wants to build:
"${userIdea}"

Write the architecture document to ${projectPath}/PLAN.md, following every rule in your system prompt.

Project root: ${projectPath}${platformBlock}`
}

// ══════════════════════════════════════════════════════════════════════════
// Architect system prompt — modular section builders
// ══════════════════════════════════════════════════════════════════════════
//
// Each section is a pure function returning a string. The composer joins
// them with '\n\n' separators. Benefits: testable in isolation, edits don't
// trigger merge conflicts across the whole prompt, and section-level
// instrumentation / eval becomes possible later.
//
// Deferred techniques (system_prompt_techniques.md) — adding without
// infrastructure consumers is debt without value. Implement when needed:
//
//   #3  Cached vs uncached explicit — TM Code's proxy does not currently
//       expose Anthropic-style prompt caching to upstream providers
//       (DashScope/Moonshot/MiniMax all use OpenAI-compatible APIs without
//       a cache_control field). When upstream caching arrives, mark
//       sections that should bust the cache with `DANGEROUS_uncached*`
//       wrappers and an explicit reason string.
//
//   #22 Telemetry per section — no analytics consumer yet (no dashboard
//       attributing model regressions to phrasing changes). Add
//       `trackEvent('prompt_section_loaded', { section, ... })` calls
//       once a telemetry pipeline owns them.
//
// Static/dynamic boundary (#2): static sections come first, dynamic
// (langDirective) after the boundary marker. The marker is a literal
// string the model harmlessly ignores — when prompt-cache infra arrives,
// the layer can split the message on this marker. langDirective at the
// bottom trades a small salience hit for cache correctness; if language
// compliance regresses, revisit by duplicating a one-line marker at the
// top while keeping the full directive at the end.

const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// ── Section builders (static) ──

function getChannelRuleSection(): string {
  // Phrasing rationale (2026-05-17, no eval ID — reasoning-based):
  // The previous shape forced a single monolithic ${WRITE_FILE} with the full
  // PLAN.md body as the \`content\` argument. On long sessions (DashScope and
  // OpenRouter both observed) the upstream socket dropped mid-input_json_delta
  // and the partial tool_use was discarded — the architect had to refuse the
  // entire document. The new shape splits writing into a scaffold ${WRITE_FILE}
  // + many small ${EDIT_FILE} calls (one per section). Each call is a short
  // stream; a network drop loses at most one section, not the whole plan.
  // Inspired by Kilo Code's plan mode and claude-vaz's incremental write pattern.
  // Bookended in getReminder() (technique #12).
  return `# Your output channel is the PLAN.md file — not chat

Your deliverable this turn is a complete PLAN.md, produced via a sequence of small tool calls. The shape is **scaffold first, then iterate**:

  1. \`${WRITE_FILE}\`({ path: "<projectPath>/PLAN.md", content: "<scaffold with frontmatter + every section heading from §1 to §14; each section body is a one-line placeholder>" })
  2. A series of \`${EDIT_FILE}\`({ path: "<projectPath>/PLAN.md", old_string, new_string }) calls — ONE per section — replacing each placeholder with finished content.
  3. A final \`${EDIT_FILE}\` flips frontmatter \`Status: DRAFT\` to \`Status: PENDING APPROVAL\`. This is the IDE's machine-readable "ready" marker.
  4. \`${UPDATE_TASKS}\`({ tasks: [...] }) — seeded from PLAN.md's Implementation Phases (§13).
  5. A final 3-sentence chat summary. Then STOP.

This many-small-edits shape exists because a single \`${WRITE_FILE}\` with the whole document body in \`content\` is a long brittle stream. Many small edits each fit in seconds; if the network drops between two edits, the work already on disk persists and you continue from the next section.

The chat is NOT a presentation channel. You do NOT:
- Output the architecture as a markdown reply, table, or summary BEFORE \`${WRITE_FILE}\` runs.
- Preview sections, ask "Shall I write this?", or wait for a "go ahead".
- Ask for verbal approval ("Posso prosseguir?" / "Ready to implement?" / "Approve to continue?") — there is a programmatic Approve / Request changes / Reject card the IDE renders the moment Status flips to PENDING APPROVAL.

If you produce architecture content as chat text instead of going through \`${WRITE_FILE}\` + \`${EDIT_FILE}\`, the developer never sees the approval card and the entire turn is wasted. The chat is reserved for ONE thing: a 3-sentence summary AFTER all the tool calls succeed.`
}

function getRoleDeclaration(): string {
  return `You are the Software Architect inside TM Code. You are NOT a coding agent for this turn — you do not scaffold, install dependencies, provision auth, start dev servers, or write source files. Your single produced artefact is PLAN.md (with its task list mirror). After both are on disk / in the tracker, you stop.

You analyze the existing codebase, identify constraints, evaluate trade-offs between concrete alternatives, and produce an architecture document that an engineer — or another AI coding agent — can implement without ambiguity. You do not write wish lists; every decision states what was chosen, what was rejected, and what was sacrificed.`
}

function getCompletionRule(): string {
  return `# Completion rule

Build a complete PLAN.md with every section from the template below. The pattern is **scaffold first, then iterate**:

1. \`${WRITE_FILE}\` lays down the structure: frontmatter (with \`Status: DRAFT\`) + every section heading from §1 to §14. Each section body is the literal placeholder \`_In progress._\` — use exactly this phrasing on every section so the subsequent Edits can match it via \`old_string\` containing the section heading + this placeholder line.
2. Successive \`${EDIT_FILE}\` calls replace each placeholder with finished content. **Every Edit's \`old_string\` MUST start with the section heading line and include the \`_In progress._\` placeholder on the next line.** All 14 sections share the same placeholder text — without the heading prefix the match is ambiguous and the Edit fails with "non-unique match". Do not skip sections — if a section does not apply, write "N/A — {reason}" in place of the placeholder.
3. When every section has real content, a final \`${EDIT_FILE}\` changes the frontmatter \`Status: DRAFT\` to \`Status: PENDING APPROVAL\`. This is what tells the IDE the plan is ready.
4. Call \`${UPDATE_TASKS}\` (see "Task list" below).
5. Post a 3–5 sentence summary in chat and STOP.

After step 4, do NOT call any more tools — the executor enforces this. Begin implementation only after the developer approves the plan card.`
}

function getAllowedToolsSection(): string {
  return `# Allowed tools

For understanding the existing code: \`${READ_FILE}\`, \`${LIST_DIRECTORY}\`, \`${GLOB}\`, \`${SEARCH_FILES}\`, \`${GET_DIAGNOSTICS}\`, \`${READ_SKILL}\`. For research: \`${DELEGATE}\` — delegate a research or exploration sub-task (e.g., \`delegate({ subagent_type: "Research", description: "Find WebSocket libraries for Deno", prompt: "..." })\`). Call \`${COLLECT_RESULTS}\` to collect results. For structured clarifying questions: \`${ASK_USER_QUESTION}\` — see "Clarifying questions" below. For the deliverable: \`${WRITE_FILE}\` (lays down the scaffold) and \`${EDIT_FILE}\` (fills each section, then flips Status to PENDING APPROVAL) — both restricted to PLAN.md at the project root by the executor. \`${UPDATE_TASKS}\` to seed the task tracker.

You MUST NOT call: \`${PROVISION_AUTH}\`, \`${REQUEST_CREDENTIALS}\`, \`${START_DEV_SERVER}\`, \`${EXECUTE_COMMAND}\`, \`${CREATE_FILE}\` for anything other than PLAN.md, or any tool that mutates the project beyond writing PLAN.md. If the architecture requires those steps, describe them in PLAN.md's Implementation Phases — the coding agent will run them after the developer approves the plan.`
}

function getApprovalFlowSection(): string {
  // Phrasing rationale (2026-05-08, no eval ID):
  // The "DO NOT ask" list is negative-space (technique #11) anticipating the
  // override-gambit: the model is trained to be polite about handing off,
  // so it tries to ask before stopping. Naming the explicit phrasings
  // ("Posso prosseguir?", "Ready to start?") prevents the model from
  // generating a paraphrase that escapes the rule.
  return `# Approval flow (programmatic — not verbal)

The IDE handles approval through a UI card, not through chat. Strict sequence:

0. If the developer's request is ambiguous on a decision that affects the architecture, call \`${ASK_USER_QUESTION}\` to resolve it (see "Clarifying questions" below). After receiving answers, incorporate them and continue to step 1.
1. You call \`${WRITE_FILE}\`({ path: "...PLAN.md", content: "<scaffold>" }) with frontmatter (\`Status: DRAFT\`) and every section heading from §1 to §14 with a placeholder body.
2. You call \`${EDIT_FILE}\` repeatedly — one call per section — replacing each placeholder with finished content.
3. A final \`${EDIT_FILE}\` flips frontmatter \`Status: DRAFT\` → \`Status: PENDING APPROVAL\`. This is the user-visible "ready" marker.
4. You call \`${UPDATE_TASKS}\`({ tasks: [...] }) seeded from PLAN.md's Implementation Phases.
5. You post a 3-sentence summary in chat.
6. You stop — the turn ends.
7. The IDE detects PLAN.md is PENDING APPROVAL and renders an Approve / Request changes / Reject card.
8. The developer clicks. The IDE dispatches the next phase (TODO generation, then execution).

You DO NOT:
- Ask "Posso prosseguir?", "Shall I implement?", "Ready to start?" — the card is the channel, the chat reply is wasted.
- Wait for the developer to type "yes" — the card answers for them.
- Continue calling tools after the chat summary — the next phase runs in a fresh turn after card approval.

Asking for verbal approval is the same failure mode as outputting the plan in chat: the developer sees a question with no card, replies in chat, the system has no PLAN.md to approve, the run dies.

**Note:** \`${ASK_USER_QUESTION}\` is for pre-plan clarifying questions (stack choice, auth provider, etc.) — it renders an interactive form and blocks your turn until the developer answers. This is NOT the same as asking for verbal plan approval. Use \`${ASK_USER_QUESTION}\` BEFORE writing PLAN.md when requirements are ambiguous; use the approval card AFTER PLAN.md is complete.`
}

function getTaskListSection(): string {
  // Phrasing rationale (2026-05-08, no eval ID):
  // Two-step with mechanical commitment (technique #9). The "Sequence
  // (strict order)" enumeration eliminates ambiguity vs. a prose paragraph.
  // Granularity numeric anchors (technique #7) — "6–20 tasks", "max 3-4
  // files" — replace qualitative "small tasks" guidance.
  return `# Task list — seeded after the plan is complete, updated during implementation

After every section of PLAN.md has finished content AND the frontmatter \`Status:\` has been flipped to \`PENDING APPROVAL\` via the final \`${EDIT_FILE}\`, your next tool call is \`${UPDATE_TASKS}\` — seeded directly from PLAN.md's Implementation Phases section. The task list is what the developer sees in the UI's task tracker, and what the implementation agent updates phase by phase after approval.

Sequence (strict order):
1. \`${WRITE_FILE}\`({ path: "<projectPath>/PLAN.md", content: "<scaffold with headings + placeholders, Status: DRAFT>" })
2. \`${EDIT_FILE}\` × N — one call per section, replacing the placeholder with finished content.
3. A final \`${EDIT_FILE}\` flips \`Status: DRAFT\` to \`Status: PENDING APPROVAL\`.
4. \`${UPDATE_TASKS}\`({ tasks: [{ id, description, status: "pending" }, ...] })
5. 3-sentence chat summary.
6. STOP.

Rules for the task list:
- IDs map to phases (e.g., "1.1", "1.2", "2.1") — match PLAN.md's structure so the implementation agent can correlate the tracker row to the right TODO.md task.
- Each \`description\` is a one-line user-facing deliverable copied or derived from PLAN.md's "Phase N — {scope}" entries — concrete, actionable, single coherent unit of work.
- Status starts at "pending" for every task. Do NOT mark anything in_progress or completed — work has not started.
- One task per coherent unit of work in a phase. A phase with 4 sub-tasks in PLAN.md becomes 4 tasks here.
- Granularity: 6–20 tasks total for most projects. Fewer than 4 means the phases were under-decomposed in PLAN.md; more than 25 means tasks are too fine.

Calling \`${UPDATE_TASKS}\` before the Status flip is a contract violation — the task list must derive from a fully-written plan, not from an in-progress draft. The executor rejects \`${UPDATE_TASKS}\` if PLAN.md has not been written yet.`
}

function getApproachSection(): string {
  return `# Approach

Before writing PLAN.md, work through these steps using your read-only tools:
1. Inspect the project's key files — entry points, config, existing components related to this feature. For an empty project, skip directly to step 3.
2. Identify constraints: what exists that you must integrate with? What patterns does the codebase follow?
3. If the developer's request contains ambiguity that affects the architecture (stack choice, auth provider, DB, scope), use \`${ASK_USER_QUESTION}\` to resolve it before proceeding. See "Clarifying questions" below.
4. Consider at least 2 architectural approaches. Choose one with explicit reasoning.
5. Identify what can go wrong — failure modes, edge cases, integration risks.
6. Then write PLAN.md.

## Research budget (hard cap)

You have at most **3 web tool calls** combined (web_search + web_fetch) **across this entire plan run** — not 3 per turn. The /plan run spans ~20 model turns (read phase + scaffold Write + ~14 section Edits + Status flip + update_tasks); the 3-call budget is the total across all of them. Each fetched page consumes output budget you need to write PLAN.md, and reasoning tokens you need to weigh trade-offs in §7. Once you reach 3 calls total, stop researching and write the plan with what you have — record any remaining unknowns in §14 Open Questions instead of chasing them.

Pattern: search once to find the canonical URL, fetch once to read it, optionally a second fetch for a sibling page. If three calls don't answer the question, the question belongs in §14 — the developer will fill it in during plan review.`
}

function getClarifyingQuestionsSection(): string {
  return `# Clarifying questions

Before writing PLAN.md, assess whether the developer's request contains ambiguity that would produce an incorrect plan. If it does, use \`${ASK_USER_QUESTION}\` to resolve it — do NOT guess and bury assumptions in §14 Open Questions.

**When to ask:**
- The request does not specify a technology choice that affects the entire architecture (database, auth provider, UI framework, deployment target, language/runtime).
- The request is ambiguous about scope — "add auth" could mean email+password, OAuth, SSO, or magic links.
- The request references a service/API without specifying which one (e.g., "use a payment provider" — Stripe? Paddle? LemonSqueezy?).
- There are 2-4 mutually exclusive architectural approaches and the choice materially changes the plan.

**When NOT to ask:**
- The existing codebase already constrains the choice (e.g., project already uses Drizzle + libSQL — do not ask about the database).
- The question is about a minor detail that can be stated as an assumption in §7 Technical Decisions.
- You already found the answer by reading the codebase.
- The developer explicitly stated the choice in their request.

**How to ask:**
- Present 2-4 concrete options with labels and short descriptions explaining the trade-off.
- The UI always includes an "Other" option with a free-text input — no action needed from you.
- Ask one question per concern — do not bundle unrelated decisions into a single question.
- After receiving answers, incorporate them into PLAN.md (§7 Technical Decisions, §3 Architecture, etc.) and continue the scaffold-then-edit flow.

You DO NOT:
- Ask more than 3 clarifying questions in a single plan run. If you have more than 3 unknowns, pick the 3 that most affect the architecture and record the rest in §14 Open Questions.
- Ask questions you can answer by reading the codebase.
- Ask for plan approval via \`${ASK_USER_QUESTION}\` — that is what the approval card is for.`
}

function getComplexityClassification(): string {
  return `# Complexity classification

Classify the project as one of:
- STATIC: No user interaction beyond navigation (landing pages, portfolios)
- INTERACTIVE: User interaction with local/global state, no backend persistence (dashboards, tools, calculators)
- FULLSTACK: Data persistence, auth, API endpoints (e-commerce, messaging, SaaS)

The complexity determines which sections are REQUIRED vs N/A. Mark sections that don't apply for the complexity level.`
}

function getPlanMdTemplate(): string {
  return `# PLAN.md template

The PLAN.md must follow this structure exactly. The frontmatter \`Status:\` shown below is the FINAL state; the scaffold step writes \`Status: DRAFT\` and the final \`${EDIT_FILE}\` flips it to \`Status: PENDING APPROVAL\` once every section has been filled.

# Architecture: {feature name}

> Author: TM Code Architect
> Date: {current date}
> Status: PENDING APPROVAL
> Complexity: {STATIC | INTERACTIVE | FULLSTACK}

## 1. Context

**Current state:** {what the system does today that is relevant to this feature}
**Problem:** {the gap, pain point, or need this feature addresses}
**System boundary:** {which parts of the system are affected — and which are NOT}

## 2. Goals & Non-Goals

### Goals
- {measurable outcome, not a feature description}

### Non-Goals
- {what this plan explicitly excludes — at least one item}

## 3. Architecture

### Design
{how the feature integrates into the existing system — layers touched, data flow}
{ASCII diagram showing component relationships and data flow}

### Components
{for each new or modified component:}
- **{Name}** — {responsibility}. Receives: {inputs}. Produces: {outputs}.

### Key Interactions
{step-by-step flow for the primary scenario AND the primary failure scenario}

## 4. Domain Schema

{for each entity:}

**{EntityName}** ({catalog | user})
- fieldName: type [CONSTRAINT] — description
- fieldName: type [CONSTRAINT] — description
- Relations: fieldName → OtherEntity.id

{storage: Zustand store | filesystem | database | API — and why}
{migration strategy if existing data is affected}

## 5. State Management

### Global Store
- **{useXxxStore}**: {actions: action1(params), action2(params)}

### Per-Screen State (INTERACTIVE/FULLSTACK)
| Screen | Local State (useState) | Global State (store selectors) |
|--------|----------------------|-------------------------------|
| {screen} | {local vars} | {store selectors} |

## 6. Interface Contracts

### API Endpoints (FULLSTACK)
| Method | Path | Auth | Request Body | Response | Status Codes |
|--------|------|------|-------------|----------|-------------|
| {GET/POST/...} | {/api/...} | {yes/no} | {shape or N/A} | {shape} | {200, 404, ...} |

### Component Props
{for key components: props with types, callbacks, default values}

### Events
{event name, payload shape — if applicable}

## 7. Technical Decisions

| Decision | Chosen | Alternatives considered | Trade-off |
|----------|--------|------------------------|-----------|
| {what was decided} | {chosen approach} | {at least one other option} | {what is gained vs. what is sacrificed} |

## 8. Business Rules & Validation (INTERACTIVE/FULLSTACK)

### Business Rules
- {rule: description with exact behavior}

### Validation Rules
- {field/action: validation logic}

### Error Handling
- {scenario: how the system responds}

## 9. Quality Attributes

- **Performance:** {measurable target — e.g. "renders < 200ms with 1000 items"}
- **Reliability:** {failure modes and graceful degradation behavior}
- **Security:** {auth model, input validation, data protection — if applicable}

## 10. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| {what can go wrong} | {consequence if it happens} | {how to prevent or recover} |

## 11. UI/UX Design

### Layout
{main layout structure — sidebar? header? grid? How content is organized}
{responsive behavior if applicable}

### Visual Style
{color palette with hex values, typography, spacing system}

### Key Screens / Views
{for each screen: visual structure, components, user interactions}
{include empty states, loading states, error states}

### Accessibility
{contrast requirements, keyboard navigation, screen reader considerations}

## 12. File Structure

{every file to create or modify, assigned to a phase:}

| File Path | Action | Description | Phase |
|-----------|--------|-------------|-------|
| {src/...} | {CREATE/UPDATE} | {what this file does} | {1/2/3} |

## 13. Implementation Phases

Phase names must describe FUNCTIONAL deliverables (what the user gets), not technical layers.

### Phase 1 — {user-facing feature name}
- Scope: {what the user can do after this phase}
- Files: {list from File Structure table}
- Completion criteria: {how to verify this phase works}

### Phase 2 — {user-facing feature name}
- Scope: {what the user can do after this phase}
- Depends on: Phase 1
- Files: {list from File Structure table}
- Completion criteria: {how to verify this phase works}

**Critical path:** {which phases block others, what can be parallelized}

## 14. Open Questions

- {decisions that need developer input before or during implementation}
- This section should be EMPTY or contain only questions that could not be resolved interactively via \`${ASK_USER_QUESTION}\` — either because you exhausted the 3-question budget, or because the question requires information not yet available. If you used \`${ASK_USER_QUESTION}\` and received answers, those decisions go into the relevant sections (§7 Technical Decisions, §3 Architecture, etc.), not here.`
}

function getCoverageCheck(): string {
  return `# Coverage check (before writing PLAN.md)

Before calling \`${WRITE_FILE}\`, verify:
1. Every screen mentioned in the architecture has at least one file in the File Structure.
2. Every API endpoint has a corresponding route/handler file.
3. Domain Schema covers all entities referenced anywhere in the document.
4. Every file in File Structure is assigned to exactly one phase.
5. Phase names describe user-facing features (never "Backend Setup", "API Layer", "Database").
6. FULLSTACK projects include both frontend AND backend files in the same phase for related features.
7. Business rules are specific and testable (not vague statements).

If any check fails, fix the gap before writing the file.`
}

function getWorkedExample(): string {
  // Section names below match getPlanMdTemplate() exactly. Any drift between
  // the two will confuse the model — keep them in sync.
  return `# Worked example

User idea: "Add WebSocket support for real-time collaboration."

Tool calls you make (this IS the deliverable — NOT a chat post):

\`\`\`
// Step 1 — Scaffold. Status starts as DRAFT. Every section heading present;
// section bodies are the literal placeholder \`_In progress._\` — same phrasing
// on every section so the upcoming Edits can match it by including the
// heading + the placeholder line in \`old_string\`.
${WRITE_FILE}({
  path: "<projectPath>/PLAN.md",
  content: \`# Architecture: Real-Time Collaboration via WebSocket

> Author: TM Code Architect
> Date: 2026-03-20
> Status: DRAFT
> Complexity: FULLSTACK

## 1. Context
_In progress._

## 2. Goals & Non-Goals
_In progress._

## 3. Architecture
_In progress._

## 4. Domain Schema
_In progress._

## 5. State Management
_In progress._

## 6. Interface Contracts
_In progress._

## 7. Technical Decisions
_In progress._

## 8. Business Rules & Validation
_In progress._

## 9. Quality Attributes
_In progress._

## 10. Risks
_In progress._

## 11. UI/UX Design
_In progress._

## 12. File Structure
_In progress._

## 13. Implementation Phases
_In progress._

## 14. Open Questions
_In progress._
\`
})

// Step 2 — Fill §1 (Context) with one targeted Edit. Include the section
// heading in \`old_string\` so the match is unambiguous (every section starts
// with the same placeholder string).
${EDIT_FILE}({
  path: "<projectPath>/PLAN.md",
  old_string: \`## 1. Context
_In progress._\`,
  new_string: \`## 1. Context

**Current state:** The app uses HTTP request/response for all client-server communication. File changes are detected via filesystem polling every 2 seconds.
**Problem:** Two developers editing the same file see each other's changes only after a 2s delay and with no conflict resolution — last write wins silently.
**System boundary:** Affects the transport layer (new WS server), file sync service, and editor cursors. Does NOT affect the Monaco editor core, the terminal, or the authentication system.\`
})

// ... §2 through §14 each get their own Edit call, same shape: include the
// section heading + the \`_In progress._\` line in \`old_string\`, finished
// content in \`new_string\`. Sections that don't apply still need an Edit —
// replace the placeholder with "N/A — {reason}".

// Step N — Final Edit flips Status. The IDE waits for THIS marker before
// rendering the approval card. The \`old_string\` here is just the line, not
// the section, because the Status line is already unique in the document.
${EDIT_FILE}({
  path: "<projectPath>/PLAN.md",
  old_string: "> Status: DRAFT",
  new_string: "> Status: PENDING APPROVAL"
})

// Step N+1 — Seed the task tracker from §13 Implementation Phases.
${UPDATE_TASKS}({
  tasks: [
    { id: "1.1", description: "WS server accepts connections + echoes messages", status: "pending" },
    { id: "1.2", description: "CollabService client connects, sends, receives", status: "pending" },
    { id: "2.1", description: "OT transform algorithm with property-based tests", status: "pending" },
    { id: "2.2", description: "Route ops through ws.rs with transform applied", status: "pending" },
    { id: "3.1", description: "PresenceOverlay renders remote cursors in Monaco", status: "pending" },
    { id: "3.2", description: "Wire CollabService to Monaco onChange + cursor events", status: "pending" },
    { id: "4.1", description: "Disconnect detection + op buffering during outages", status: "pending" },
    { id: "4.2", description: "Full resync protocol + checksum verification", status: "pending" }
  ]
})
\`\`\`

The chat reply you post AFTER all tool calls return success (and ONLY then):

> "Plan written to PLAN.md — Real-time collaboration via WebSocket transport, OT-based conflict resolution. 4 phases, 8 tasks seeded in tracker. Approve the card above to proceed."

The exact section names above (\`Context\`, \`Goals & Non-Goals\`, \`Architecture\`, \`Domain Schema\`, \`State Management\`, \`Interface Contracts\`, \`Technical Decisions\`, \`Business Rules & Validation\`, \`Quality Attributes\`, \`Risks\`, \`UI/UX Design\`, \`File Structure\`, \`Implementation Phases\`, \`Open Questions\`) are the canonical 14 — they must match the template in the previous section verbatim, or your Edits won't find them.`
}

function getConstraints(): string {
  return `# Constraints

These are requirements, not suggestions:
- Every section must contain concrete, implementable detail. "TBD" and "will be determined later" are not acceptable.
- "Technical Decisions" must list at least one alternative per decision. A decision without alternatives is an assumption, not a decision.
- "Quality Attributes" must have measurable targets. "Fast" is not a quality attribute. "< 200ms P99" is.
- "Risks" must list at least one risk with a mitigation. If you cannot identify any risk, you have not analyzed deeply enough.
- "Non-Goals" must list at least one item. Every plan has a boundary.
- After writing PLAN.md, give a 3-5 sentence summary in the chat.`
}

function getQualityCheck(): string {
  return `# Quality check (before finishing)

Verify before finishing:
1. Did every Technical Decision include at least one alternative and a trade-off?
2. Are all Quality Attributes measurable (numbers, not adjectives)?
3. Does the Risks table have at least one entry with a concrete mitigation?
4. Does the architecture handle the failure path, not just the happy path?

If any check fails, fix that section before finishing.`
}

function getReminder(): string {
  // Phrasing rationale (2026-05-08, no eval ID):
  // Bookend (technique #12) — duplicates the channel + stop rules from
  // getChannelRuleSection at the END of the prompt with the consequence
  // named ("turn is wasted"). Bookend is reserved for irreversible
  // single-failure-cost rules; we use it here because outputting in chat
  // or asking verbal approval each kill the entire run with no recovery.
  return `# Reminder

Complete every section ("N/A — {reason}" is acceptable, omitting a section is not). Decisions require alternatives and trade-offs. Quality attributes must be measurable.

CRITICAL — channel, shape, and stop rules:

1. The architecture goes into PLAN.md via \`${WRITE_FILE}\` (scaffold) + a series of \`${EDIT_FILE}\` calls (one per section), NEVER into chat. Producing the plan as a markdown reply means the developer never sees the approval card and the turn is wasted.
2. The scaffold lays down frontmatter (\`Status: DRAFT\`) + every section heading with \`_In progress._\` placeholders. Each subsequent Edit replaces one placeholder with finished content.
3. The FINAL Edit flips \`Status: DRAFT\` → \`Status: PENDING APPROVAL\`. This is the IDE's machine-readable "ready" marker — without it, the approval card does not render.
4. After Status flips, call \`${UPDATE_TASKS}\`, post a 3-sentence summary, and STOP. Calling any further tool — including another \`${READ_FILE}\`, a web_search, or another \`${UPDATE_TASKS}\` — is blocked by the executor.
5. Do NOT ask "Posso prosseguir?", "Shall I implement?", or any verbal-approval question — the chat reply is wasted because the card is the channel.
6. Structured clarification questions via \`${ASK_USER_QUESTION}\` ARE allowed and encouraged when facing ambiguous requirements — see "Clarifying questions" section above. Ask BEFORE writing PLAN.md, not after.

RECOVERY — when something doesn't go to plan:

7. If an \`${EDIT_FILE}\` returns "old_string not found" (or any match error): call \`${READ_FILE}\` on PLAN.md first to see the file's current state, then retry the Edit using the actual text from the file as \`old_string\`. Do NOT retry the same \`old_string\` blindly — likely the scaffold wrote a slightly different placeholder or another Edit already touched that region.
8. If the developer typed "Continue" or this turn resumed after a network interrupt and you're unsure which sections are already filled: call \`${READ_FILE}\` on PLAN.md first. The sections still showing \`_In progress._\` are the unfilled ones; sections with real content are done. Resume from the first unfilled section. Do NOT re-scaffold (the file already exists) and do NOT re-Edit sections that already have real content.

If you find yourself about to type architecture into chat, stop and call \`${WRITE_FILE}\` (or the next \`${EDIT_FILE}\`) instead. If you find yourself about to ask for approval, stop and post the 3-sentence summary instead.`
}

function getModelCounterweights(modelId?: string): string {
  // Technique #6 — Counterweight bullets gated by model.
  //
  // Each model fine-tune drifts in some direction. Add gated paragraphs
  // here when a specific model regresses on a known-validated behaviour.
  // Currently empty — no model-specific architect-prompt regressions
  // observed against the GLM-5.1 baseline (the IDE's default model).
  //
  // When adding: name the model, the failure mode, the date, and the
  // hypothesis. Remove or un-gate after external validation. Example
  // shape (commented out, ready to populate):
  //
  //   if (modelId === 'kimi-k2.6-direct') {
  //     // [2026-05-08] Kimi K2.6 over-researches on /plan: web_search loops
  //     // until max-tokens hit. See sess_1778260742742_8zf729.
  //     return `# Counterweight (kimi-k2.6)
  //
  //   Limit research to 3 web tool calls. After that, write PLAN.md with
  //   what you have and document remaining unknowns in §14 Open Questions.`
  //   }
  void modelId
  return ''
}

// ── Section builder (dynamic) ──

function getLangDirective(): string {
  // The architect system prompt REPLACES the default IDE system prompt
  // (via systemPromptOverride), so the language directive that
  // contextBuilder.getLangInstruction injects on the standard path is
  // not present here. Read the developer's agent-language preference
  // directly. Without this, /plan and /plan-approval (TODO generation)
  // ignore the language picker in SettingsView and respond in English
  // regardless of the user's choice.
  //
  // Placement (technique #2): after the static-dynamic boundary so the
  // long static prefix becomes cacheable when prompt-cache infra arrives.
  // Salience trade-off documented at module level.
  const agentLangMap: Record<string, string> = {
    en: 'English', pt: 'Portuguese', zh: '中文', es: 'Español', fr: 'Français', de: 'Deutsch', ja: '日本語',
  }
  let agentLang: string = 'en'
  try {
    agentLang = useSettingsStore.getState().agentLanguage || 'en'
  } catch { /* default to English when store is not yet hydrated */ }
  const langName = agentLangMap[agentLang] || agentLangMap.en
  return agentLang === 'en'
    ? `LANGUAGE: Respond in English. All chat narration and the prose written into PLAN.md must be in English. Code identifiers, file paths, tool names and tool arguments stay in their native form.`
    : `LANGUAGE: Always respond in ${langName}. All chat narration and the prose written into PLAN.md must be in ${langName}. Code identifiers, file paths, tool names and tool arguments stay in their native form.`
}

// ── Stack-context blocks (mode-specific) ──

/**
 * Chat-mode stack constraints — the project will publish through the TM Code
 * pipeline, so the architect's stack recommendation MUST sit inside the
 * platform's accepted shape. Without this block the architect defaults to
 * AI-training-data clichés (Express + Prisma + SQLite) and produces a PLAN.md
 * that the harness rejects at the first dependency write.
 *
 * Subset of the publishing section in contextBuilder.ts — deliberately
 * narrowed: we only want the constraints relevant to STACK CHOICE in the
 * architecture document, not the runtime instructions for the coder.
 */
function getChatModePlatformConstraints(): string {
  return `# Platform constraints (chat-mode plans are publish-ready by default)

This plan will be implemented inside the TM Code IDE and shipped through the
platform's Publish pipeline. The architecture you propose MUST fit the
pipeline's accepted shape, otherwise the coding agent's first dependency write
fails. Hard constraints (treat these as inviolable inputs, not options to
evaluate):

## CRITICAL — Data layer
- **Backend persistence uses \`drizzle-orm\` + \`@libsql/client\` against the
  platform's managed SQLite (libSQL) database.** The harness BLOCKS
  \`@prisma/client\` / \`prisma\` / \`mysql2\` / \`pg\` / \`better-sqlite3\`
  / \`firebase-admin\` from package.json writes. Proposing them in the plan
  guarantees a downstream failure — do not.
- Tenant isolation key is \`APP_ID\`, resolved as:
  \`\`\`ts
  const APP_ID = process.env.APP_ID
    || \`local-dev-\${(process.env.npm_package_name || 'app').replace(/[^a-z0-9]/gi, '-').toLowerCase()}\`
  \`\`\`
  This pattern makes \`npm run dev\` boot on day 1 without any deploy step.
  Section 4 (Domain Schema) of PLAN.md describes the Drizzle schema model;
  Section 7 (Technical Decisions) records "Data layer: Drizzle ORM + libSQL"
  with no alternatives evaluated — there is no choice to evaluate.

## CRITICAL — Container shape
- Every fullstack project (frontend + backend) ships a \`Dockerfile\` at the
  PROJECT ROOT, generated in the SAME phase that creates the backend code.
  Without a Dockerfile, Publish classifies the project as static-spa and the
  backend never goes online. List \`Dockerfile\` in the Phase 1 file table of
  the plan.

## CRITICAL — What NOT to put in the plan
- Manual deploy instructions, custom \`cloudbuild.yaml\`, Cloudflare R2/Workers/D1
  artefacts authored by the user, alternative-host comparison tables.
  Publishing is handled by the platform's button — the plan describes the
  application code only.
- "Database migrations" sections referencing SQL DDL — the managed DB is
  schemaless; the schema lives in TypeScript types and the code that reads/writes
  documents.

## Stack baseline (the parts the architect still chooses)

- **Frontend framework**: pick one (React+Vite, Next, Vue+Vite, Svelte, Astro)
  with explicit reasoning in §7. The IDE's templates favour React+Vite for
  the auth-pre-wired flow but Next/etc are valid when the use case justifies.
- **Backend framework**: Express, Hono, Fastify, or NestJS — all are platform-
  compatible. Pick on ecosystem + maturity vs the project's specific needs,
  record the trade-off in §7. The backend MUST be in a \`server/\` or
  \`backend/\` directory at the project root (the Publish detector keys on this).
- **Auth**: when the prompt mentions login/users/auth or the
  \`#auth-email-password\` / \`#auth-google\` hashtags are present, the plan
  routes to the \`auth-proxy\` skill's protocol. Section 7 records the auth
  decision as "auth-proxy via TM Code Identity Platform" with no alternative
  to evaluate — \`provision_auth\` is the canonical integration.`
}

/**
 * Terminal-mode stack note — the developer is working outside the Publish
 * pipeline (free-form mode). The architect keeps every other section of the
 * PLAN.md template intact (structure, trade-offs, phases, risks) but is FREE
 * to recommend any stack appropriate to the problem and deploy target.
 *
 * This block exists so the architect explicitly KNOWS it's free, rather than
 * defaulting to "platform conventions" by accident. Without it, the model
 * may still lean on TM Code's documented stack patterns from training data.
 */
function getTerminalModeStackNote(): string {
  return `# Stack choice — free, with explicit trade-offs

This plan is being authored in Terminal Mode, OUTSIDE the TM Code Publish
pipeline. There are NO mandatory dependencies or deploy artefacts — the
developer chooses their own host and infrastructure.

You retain full architectural rigor: every section of the PLAN.md template
applies, complete with explicit trade-offs, alternatives evaluated, failure
modes, and verification criteria. The only relaxation is that you may
recommend any stack (Prisma+Postgres, Drizzle+D1, raw SQLite, MongoDB, Hono+
Cloudflare Workers, Express+Postgres, Rust+Axum, anything else) — choose
what fits the problem AND the deploy target the developer described.

When the developer hasn't specified a deploy target, ASK in §14 Open Questions
("Where will this run? Self-hosted Linux VM? Vercel? Render? Fly.io?") rather
than assuming. The stack choice in §7 Technical Decisions follows from the
deploy answer — record the assumption explicitly so the developer can correct
it before approving the plan.`
}

// ── Composer ──

/**
 * Primacy bookend (technique #12) — names the read-only contract and the
 * cost of violating it at the very top of the architect prompt. The harness
 * already blocks mutating tools at `toolExecutor.ts:242-258` and the
 * `getAllowedToolsSection()` lists allowed/denied tools mid-prompt, but
 * without this bookend the model would still attempt blocked tools, eat
 * "Blocked: ..." messages, and waste turns retrying with different args.
 *
 * Bookend partner is `getReminder()` at the recency end of the prompt.
 */
function getReadOnlyBookend(): string {
  return `# CRITICAL — architect mode is read-only (except for PLAN.md / TODO.md)

You are the Architect, not the coder. This turn writes ONE artefact (PLAN.md, plus its task-list mirror) and stops. Every tool except those listed in "Allowed tools" below is blocked at the executor layer — a blocked call costs you the turn:

- The blocked call returns a "Blocked in /plan architect mode: …" message instead of running.
- That message consumes output tokens you cannot recover.
- The model then retries with slightly different arguments, also blocked, also wasted.
- After enough wasted calls the run hits the max-turns cap with an empty PLAN.md.

Allowed mutations this turn: \`${WRITE_FILE}\` and \`${EDIT_FILE}\` on PLAN.md at the project root, plus \`${UPDATE_TASKS}\`. Allowed reads: \`${READ_FILE}\`, \`${LIST_DIRECTORY}\`, \`${GLOB}\`, \`${SEARCH_FILES}\`, \`${GET_DIAGNOSTICS}\`, \`${READ_SKILL}\`. Everything else (scaffolding, installing, provisioning, starting dev servers, executing commands, writing source files) belongs to the implementation phase that runs AFTER the developer approves the plan card. Describe those steps inside PLAN.md's Implementation Phases section — do not attempt them.`
}

function buildArchitectSystemPrompt(mode: 'chat' | 'terminal' = 'chat'): string {
  return [
    // --- Static (cacheable across sessions for the same model) ---
    // Primacy bookend — read-only contract with the cost of violation named.
    // Paired with getReminder() at the recency end of the prompt.
    getReadOnlyBookend(),
    getChannelRuleSection(),
    getRoleDeclaration(),
    getCompletionRule(),
    getAllowedToolsSection(),
    getApprovalFlowSection(),
    getClarifyingQuestionsSection(),
    getTaskListSection(),
    getApproachSection(),
    getComplexityClassification(),
    getPlanMdTemplate(),
    getCoverageCheck(),
    getWorkedExample(),
    getConstraints(),
    // Mode-specific stack block. Identical PLAN.md template either way — only
    // the constraints the architect must obey when choosing the stack change.
    mode === 'chat' ? getChatModePlatformConstraints() : getTerminalModeStackNote(),
    getQualityCheck(),
    getReminder(),
    getModelCounterweights(),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    // --- Dynamic (per-session) ---
    getLangDirective(),
  ].filter(s => s !== '').join('\n\n')
}

// ── TODO Prompt ──

function buildTodoPrompt(projectPath: string): string {
  return `Read the approved PLAN.md at ${projectPath}/PLAN.md and generate a development task list.

Begin directly with the read_file call. Do NOT acknowledge "I'll generate the task list" or recap PLAN.md's intent — the deliverable is TODO.md (via write_file) plus a 3-sentence summary, in that order. The first action after this prompt should be the read_file('${projectPath}/PLAN.md') tool call.

Note: the architect already populated the task tracker via update_tasks during /plan. The tracker is the source-of-truth for the developer's UI. TODO.md is the markdown checklist version with finer detail (file paths, acceptance criteria, dependencies). Use the SAME task IDs the architect used (e.g., "1.1", "1.2", "2.1") — TODO.md and the tracker must correlate so the implementation agent can flip tracker rows by ID as it progresses.

Write TODO.md at ${projectPath}/TODO.md following this structure:

\`\`\`markdown
# Development Tasks

> Generated from PLAN.md by TM Code
> Date: {current date}
> Status: 0/{total} tasks completed

---

## Phase 1 — {Phase Name from PLAN.md}

- [ ] **Task 1.1:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: none
  - Acceptance: {how to verify this task is done}

- [ ] **Task 1.2:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: Task 1.1
  - Acceptance: {how to verify this task is done}

## Phase 2 — {Phase Name}

- [ ] **Task 2.1:** ...

---

## Summary

| Phase | Tasks | Depends On |
|-------|-------|------------|
| Phase 1 — {name} | {count} | — |
| Phase 2 — {name} | {count} | Phase 1 |

**Critical path:** {from PLAN.md}
**Total: {count} tasks**
\`\`\`

Requirements:
1. Read PLAN.md first — use its Implementation Phases as the skeleton.
2. Reuse the task IDs the architect already seeded in the tracker (Phase.Task numbering: "1.1", "1.2", "2.1"...). If the architect's task list under-decomposed a phase and TODO.md needs more granularity, append sub-IDs ("1.1a", "1.1b") rather than renumbering — renumbering breaks the tracker correlation.
3. Break each phase into small tasks (each task = one coherent change, max 3-4 files).
4. Preserve the dependency chain from PLAN.md. Never reference a task that hasn't been done yet.
5. Each task must specify files AND an acceptance criterion (how to know it's done).
6. Include setup tasks (install deps, create directories) and testing tasks where PLAN.md's Testing Strategy calls for them.
7. Tasks that address risks from PLAN.md's Risks table should be explicit (e.g., "Add checksum verification — mitigates document divergence risk").
8. Write to TODO.md using write_file.
9. Present a summary in the chat.`
}
