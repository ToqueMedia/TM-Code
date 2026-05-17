import { invoke } from '@tauri-apps/api/core'
import { useProjectStore } from '../../../stores/projectStore'
import { useChatStore } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { runAgentWithCallbacks } from '../agentRunner'
import SkillService from '../skillService'
import { logger } from '../../../utils/logger'
import { runAuthFlowVerification, buildAuthFixPrompt } from './verifyAuthFlow'

/**
 * GIP auth scaffolding flow. Triggered by hashtag tokens dropped into the
 * prompt:
 *
 *   #auth-email-password
 *   #auth-google
 *
 * The hashtag detector (see `hashtagRegistry.ts`) inspects the user's prompt
 * at submit time, parses the providers, strips the tags, and calls
 * `runAuthFlow` below. This pre-loads the authoritative skill content
 * (auth-proxy SKILL.md, plus google-signin SKILL.md when Google is
 * requested) and injects it into the agent's prompt as `<auth_skill>`
 * context blocks. The agent gets a single, self-contained instruction with
 * everything needed to implement — no round-trip to read_skill mid-turn.
 *
 * Works in BOTH chat and CMD modes — wired in `usePromptBar.ts` and
 * `useCmdPromptLogic.ts` (handleSend / executePrompt branch).
 */

export type Provider = 'email-password' | 'google'

interface SkillEntry {
  name: string
  path: string
}

interface SkillContent {
  content: string
  references: string[]
}

async function fetchBundledSkill(name: string): Promise<string | null> {
  try {
    const entries = await invoke<SkillEntry[]>('list_skills_bundled')
    const entry = entries.find((e) => e.name === name)
    if (!entry) {
      logger.warn('auth', `Bundled skill not found: ${name}`)
      return null
    }
    const result = await invoke<SkillContent>('read_skill_content', { skillPath: entry.path })
    return result.content
  } catch (err) {
    logger.error('auth', `Failed to load skill ${name}:`, err)
    return null
  }
}

function buildPrompt(
  providers: Provider[],
  instructions: string,
  authProxySkill: string,
  googleSigninSkill: string | null,
  designSkill: string | null,
): string {
  const wantsGoogle = providers.includes('google')
  const wantsEmail = providers.includes('email-password')

  const skillsBlock = [
    `<auth_skill name="auth-proxy">`,
    authProxySkill,
    `</auth_skill>`,
    ...(googleSigninSkill
      ? [``, `<auth_skill name="google-signin">`, googleSigninSkill, `</auth_skill>`]
      : []),
    ...(designSkill
      ? [``, `<design_skill name="frontend-design">`, designSkill, `</design_skill>`]
      : []),
  ].join('\n')

  const providerLine = [
    wantsEmail && 'email/password sign-up + sign-in',
    wantsGoogle && 'Google sign-in (Google Identity Services)',
  ]
    .filter(Boolean)
    .join(' AND ')

  return [
    skillsBlock,
    ``,
    `The developer dropped a \`#auth-*\` hashtag in the prompt and wants to add ${providerLine} to this project. The skill content above is the authoritative protocol — follow it. Stack choice (Express, Hono, Fastify, NestJS, FastAPI, Go, etc.) is YOURS to make: match what the project already uses, or pick something sensible if it's a fresh project.`,
    ...(instructions
      ? [``, `Additional instructions from the developer:`, `> ${instructions}`]
      : []),
    ``,
    `Execution sequence — run in this order:`,
    ``,
    `1. Call \`provision_auth(provider: "gip")\`. This reserves the project's auth tenant on the platform and writes the auth credentials to \`.env\` automatically — both the neutral TM_* names (for new code) and the legacy FIREBASE_*/GIP_*/GCP_* names (backward compat). Without it the credentials don't exist; do not skip.`,
    ``,
    `2. Inspect the project to choose the backend stack: read package.json (existing deps like express, hono, fastify, @nestjs/core), or look for pyproject.toml / go.mod for non-Node projects. If the project is a fresh frontend-only repo and the developer didn't specify, ask which backend stack they prefer (one short question, then proceed).`,
    ``,
    `3. Implement the auth-proxy backend in your chosen stack — endpoints from the skill: POST /api/auth/proxy/{signup,signin,google,refresh} + POST /api/auth/sync. The proxy forwards to the platform's auth API using the public client key in .env (the auth-proxy skill has the exact request shape for each endpoint). For JWT verification on /api/auth/sync, use the JWKS pattern from the skill (jose / jsonwebtoken / python-jose / golang-jwt depending on stack).`,
    ``,
    `4. Persist users via the platform data layer — see the Publishing section of your system prompt. The auth-proxy is concerned with sign-in flow only; the user record (uid PK, email unique, name, avatarUrl, role, createdAt, updatedAt) is stored using \`firebase-admin\` under \`apps/{APP_ID}/users\`, NOT in a local SQL DB. The publish-backend skill has the exact shape. Custom columns are nullable or have defaults — sync runs from JWT data on first sign-in.`,
    ``,
    `5. Implement the frontend per the skill recipe:`,
    `   - src/lib/firebase.ts (init only — only onAuthStateChanged is allowed from firebase/auth)`,
    `   - Auth store (Zustand if React, Pinia if Vue, etc.) with signup/login/logout${wantsGoogle ? '/setUser' : ''}`,
    `   - AuthGuard component for protected routes`,
    `   - Login/Signup screens that call the proxy endpoints`,
    `   - src/lib/authClient.ts (or equivalent) with setAuthToken + authFetch helpers — pattern in the skill`,
    ...(wantsGoogle
      ? [
          ``,
          `6. Add Google sign-in following the google-signin skill:`,
          `   - <script src="https://accounts.google.com/gsi/client"> in index.html`,
          `   - A useGoogleSignIn hook (or framework equivalent)`,
          `   - Mount the GIS button on Login and Signup screens`,
        ]
      : []),
    ``,
    `${wantsGoogle ? '7' : '6'}. Verify with the project's type-checker (e.g. npx tsc --noEmit, mypy, etc.) and run any tests. Fix errors. Report what was implemented in plain prose.`,
    ...(designSkill
      ? [
          ``,
          `Design direction (the developer also dropped \`#design\`):`,
          `Apply the frontend-design recipe above to ALL UI you build in this turn — Login, Signup, Success, AuthGuard. Commit to ONE bold aesthetic direction (brutalist, editorial, retro-futuristic, organic, luxury, maximalist, industrial — or your own). Pick distinctive typography (avoid Inter/system defaults). Build a cohesive color palette with intentional accents. No timid middle ground. The result should be visually striking AND production-grade — not generic AI chrome.`,
        ]
      : []),
    ``,
    `Hard rules:`,
    `- The .env file is managed by the platform — \`request_credentials\` is the only legitimate write path, and TM Code uses it only for third-party developer keys (OpenAI, Stripe, etc.), never for platform-managed credentials.`,
    `- Use the public client key in .env (the one provision_auth just wrote) for the auth-proxy's outbound calls. Admin SDK keys / service-account files / infrastructure tokens live only on the platform side and the project does not have them; \`request_credentials\` for them is incorrect.`,
    `- The auth-proxy itself is a thin REST forwarder — it does NOT install \`firebase-admin\`. The data layer (the user record persistence) is a separate concern and uses \`firebase-admin\` per the Publishing section.`,
    `- Client-side: only \`onAuthStateChanged\` is imported from \`firebase/auth\`. signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut go through the proxy instead — the popup family is silently blocked in the IDE's preview webview.`,
    `- After a successful proxy signup or signin, call /api/auth/sync to upsert the user record via the platform data layer.`,
    `- Use authFetch (or the project's equivalent) for protected API calls.`,
  ].join('\n')
}

/**
 * Run the auth scaffolding flow with the given providers and free-form
 * instructions. Loads the relevant skills inline, augments the prompt with
 * `<auth_skill>` blocks + a strict execution sequence, and dispatches to the
 * agent.
 *
 * Used by the prompt-bar hashtag handler (`#auth-email-password`,
 * `#auth-google`) — replaces the legacy `/auth` slash command.
 */
export async function runAuthFlow(
  providers: Provider[],
  instructions: string,
  userMessageText: string,
  withDesign: boolean = false,
  cmdOnlyMode: boolean = false,
): Promise<void> {
  const chatStore = useChatStore.getState()
  const wantsGoogle = providers.includes('google')

  // Load the bundled skill content in parallel so the agent gets the full
  // recipe(s) inline — no round-trip to read_skill mid-turn.
  const [authProxySkill, googleSigninSkill, designSkill] = await Promise.all([
    fetchBundledSkill('auth-proxy'),
    wantsGoogle ? fetchBundledSkill('google-signin') : Promise.resolve(null),
    withDesign ? fetchBundledSkill('frontend-design') : Promise.resolve(null),
  ])

  if (!authProxySkill) {
    chatStore.addSystemMessage(
      'Could not load the auth-proxy skill. The bundled resources may be missing — reinstall TM Code if this persists.'
    )
    return
  }
  if (wantsGoogle && !googleSigninSkill) {
    chatStore.addSystemMessage(
      'Could not load the google-signin skill. Proceeding with email/password only — re-add `#auth-google` once the skill is available.'
    )
  }
  if (withDesign && !designSkill) {
    chatStore.addSystemMessage(
      'Could not load the frontend-design skill. Proceeding without it — the UI will use the model\'s default aesthetics.'
    )
  }

  // Force-load the auth skills into the SkillService cache BEFORE the agent
  // runs. Without this, the agent's `read_skill("auth-proxy")` calls hit
  // the relevance heuristic (which rejects auth skills for projects with no
  // detectable type, e.g. an empty directory) and return "not loaded" — the
  // agent then falls back to training-data implementations and ignores the
  // skill entirely. This keeps the system-prompt skill index, the read_skill
  // tool, and the inline `<auth_skill>` blocks in the prompt all consistent.
  const skillService = SkillService.getInstance()
  skillService.forceLoadSkill('auth-proxy')
  if (wantsGoogle && googleSigninSkill) {
    skillService.forceLoadSkill('google-signin')
  }
  if (withDesign && designSkill) {
    skillService.forceLoadSkill('frontend-design')
  }

  const prompt = buildPrompt(providers, instructions, authProxySkill, googleSigninSkill, designSkill)

  // Track Stop across the whole scaffold+verify+fix sequence. The user's
  // Stop button dispatches 'agent-stop-requested'; each individual
  // sub-agent and the main runAgentWithCallbacks already wire their own
  // AbortControllers to it, but this flag tells THIS function whether to
  // continue into the next iteration of the loop or bail out cleanly.
  // Without it the scaffold-then-verify-then-fix loop would keep firing
  // new turns after a Stop, each one then aborting immediately — wasted
  // tokens and a confusing UX (the user sees "stopped" then watches more
  // turns spawn). The listener lives for the whole runAuthFlow body and
  // is torn down in the outer finally so re-entry behaves cleanly.
  let userAborted = false
  const abortListener = () => { userAborted = true }
  if (typeof window !== 'undefined') {
    window.addEventListener('agent-stop-requested', abortListener)
  }

  try {
    // Scaffold turn — main agent reads the skill bundle inline and writes the
    // proxy backend + frontend wiring.
    await runAgentWithCallbacks(prompt, {
      addUserMessage: true,
      userMessageText,
      useConversationHistory: true,
      cmdOnlyMode,
    })

    // Skip verification if the scaffold turn errored or was aborted —
    // verifying a half-scaffolded project would FAIL → fix → loop with
    // nothing to fix, wasting tokens and burying the real error under
    // misleading verification output. agentStore.status === 'error'
    // covers API/network failures and the error-exhaustion paths in
    // agentService; userAborted covers Stop.
    if (userAborted) {
      logger.info('auth', 'Scaffold turn aborted by user — skipping verification.')
      return
    }
    if (useAgentStore.getState().status === 'error') {
      logger.warn('auth', 'Scaffold turn ended in error — skipping verification.')
      return
    }

    // Verification gate — claude-vaz "verification specialist" pattern adapted
    // to auth scaffolding. Runs an adversarial sub-agent against the just-
    // written endpoint to catch the documented failure modes (MISSING_REQUEST_URI,
    // INVALID_CREDENTIAL_OR_PROVIDER_ID, /v2 path slip, Vite proxy missing,
    // type errors) BEFORE the developer hits them. On FAIL the diagnostic
    // feeds back to the main agent for a focused fix turn, then re-verify.
    //
    // Capped at MAX_FIX_ATTEMPTS so a stuck model can't loop forever — when
    // the cap is hit, we surface the last verifier report to the developer
    // so they have actionable context (which probe failed, which CRITICAL
    // block in the skill maps to the fix).
    const projectPath =
      useProjectStore.getState().currentProject?.path
      || useProjectStore.getState().cmdModeProjectPath
      || ''
    if (!projectPath) {
      logger.warn('auth', 'Skipping verification — no project path resolvable')
      return
    }

    const MAX_FIX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS + 1; attempt++) {
      if (userAborted) {
        logger.info('auth', 'User aborted before verification iteration — exiting loop.')
        return
      }

      const { verdict, report } = await runAuthFlowVerification({
        projectPath,
        providers,
        authProxySkill,
        googleSigninSkill,
        cmdMode: cmdOnlyMode,
      })

      // Stop may have fired during the verifier; the verifier itself
      // aborts cleanly, but we must NOT continue into another iteration.
      if (userAborted) {
        logger.info('auth', 'User aborted during verifier — exiting loop.')
        return
      }

      if (verdict === 'PASS') {
        chatStore.addSystemMessage('Auth flow verified end-to-end.')
        return
      }

      if (verdict === 'PARTIAL') {
        // Environmental limitation (server can't start, ITK unreachable).
        // No retry — the developer needs to resolve the environment first.
        chatStore.addSystemMessage(
          'Auth verification could not run to completion (environmental issue). '
          + 'Read the verifier output above for what was checked and what was skipped.',
          'warn',
        )
        return
      }

      // FAIL path. If we still have attempts left, feed the diagnostic to the
      // main agent for a focused fix turn. Otherwise surface and stop.
      if (attempt > MAX_FIX_ATTEMPTS) {
        chatStore.addSystemMessage(
          `Auth verification failed after ${MAX_FIX_ATTEMPTS} fix attempts. `
          + `Last verifier report is in the chat above — it names the exact probe `
          + `and error code so you (or the next /debug) can target the fix.`,
          'error',
        )
        return
      }

      chatStore.addSystemMessage(
        `Auth verification failed (attempt ${attempt}/${MAX_FIX_ATTEMPTS}). Sending the diagnostic back to the agent for a fix pass…`,
      )
      await runAgentWithCallbacks(buildAuthFixPrompt(report, attempt), {
        addUserMessage: false,
        useConversationHistory: true,
        cmdOnlyMode,
      })

      // Stop or unrecoverable error during the fix turn — bail before the
      // next verification iteration so we don't loop on stale state.
      if (userAborted) {
        logger.info('auth', 'User aborted during fix turn — exiting loop.')
        return
      }
      if (useAgentStore.getState().status === 'error') {
        logger.warn('auth', 'Fix turn ended in error — surfacing and stopping.')
        chatStore.addSystemMessage(
          'Fix attempt errored. Stopping the verification loop — see the chat above for what went wrong.',
          'error',
        )
        return
      }
    }
  } finally {
    if (typeof window !== 'undefined') {
      window.removeEventListener('agent-stop-requested', abortListener)
    }
  }
}

/**
 * Lightweight flow for `#design` alone (no auth). Force-loads the
 * frontend-design skill and injects its body inline so the agent commits
 * to a deliberate aesthetic before generating UI. Mirrors claude-vaz's
 * pattern of opt-in plugin install — explicit user signal, full skill
 * body in context, no decision needed by the model on whether to read it.
 */
export async function runDesignFlow(
  instructions: string,
  userMessageText: string,
  cmdOnlyMode: boolean = false,
): Promise<void> {
  const chatStore = useChatStore.getState()
  const designSkill = await fetchBundledSkill('frontend-design')

  if (!designSkill) {
    chatStore.addSystemMessage(
      'Could not load the frontend-design skill. Continuing without it — the UI will use the model\'s default aesthetics.'
    )
    // Still run the agent with the cleaned text — user's request shouldn't be lost.
    await runAgentWithCallbacks(instructions || userMessageText, {
      addUserMessage: true,
      userMessageText,
      useConversationHistory: true,
      cmdOnlyMode,
    })
    return
  }

  SkillService.getInstance().forceLoadSkill('frontend-design')

  const prompt = [
    `<design_skill name="frontend-design">`,
    designSkill,
    `</design_skill>`,
    ``,
    `The developer dropped \`#design\` in the prompt. Apply the recipe above to ALL UI you build in this turn. Commit to ONE bold aesthetic direction — refined minimalism and maximalist chaos both work, the timid middle does not. Pick distinctive typography (avoid Inter / system defaults). Build a cohesive color palette with intentional accents. The result should be visually striking AND production-grade — not generic AI chrome.`,
    ``,
    `Developer's request:`,
    `> ${instructions || userMessageText}`,
  ].join('\n')

  await runAgentWithCallbacks(prompt, {
    addUserMessage: true,
    userMessageText,
    useConversationHistory: true,
    cmdOnlyMode,
  })
}
