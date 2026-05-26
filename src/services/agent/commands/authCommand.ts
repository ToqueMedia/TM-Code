import { invoke } from '@/utils/invokeMetrics'
import { useChatStore } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { runAgentWithCallbacks } from '../agentRunner'
import SkillService from '../skillService'
import { logger } from '../../../utils/logger'

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
    `   - Auth store (Zustand if React, Pinia if Vue, etc.) with signup/login/logout${wantsGoogle ? '/setUser' : ''}, AND an \`init()\` action that reads \`getAuthToken()\`, calls \`GET /api/auth/me\`, sets user from the response (or \`null\` when token missing/expired and refresh fails). This is the SESSION-PERSISTENCE mechanism — without it, a hard refresh after login lands the user back on /login because the store starts empty.`,
    `   - AuthGuard component for protected routes`,
    `   - Login/Signup screens that call the proxy endpoints. After every successful proxy response: \`setAuthToken(idToken, refreshToken)\` → \`authFetch('/api/auth/sync', ...)\` → \`setUser(synced)\`. Skipping setAuthToken means the next authFetch has no Authorization header.`,
    `   - src/lib/authClient.ts (or equivalent) with setAuthToken + authFetch helpers — pattern in the skill`,
    `   - **Bootstrap in main.tsx**: wrap \`createRoot(...).render(<App/>)\` in \`useAuthStore.getState().init().finally(() => createRoot(...).render(...))\`. Calling \`init()\` from a component \`useEffect\` is too late — the first paint already happened with \`user: null\` and AuthGuard has already redirected to /login. This is non-negotiable; tests for it run in the verification step below.`,
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
          `Apply the frontend-design recipe above to the auth UI you scaffold this turn — Login, Signup, Success, AuthGuard. Commit to ONE bold aesthetic direction (brutalist, editorial, retro-futuristic, organic, luxury, maximalist, industrial — or your own). Pick distinctive typography (avoid Inter/system defaults). Build a cohesive color palette with intentional accents. No timid middle ground. The result should be visually striking AND production-grade — not generic AI chrome.`,
          ``,
          `Scope of the design pass: presentation surfaces only — JSX/template structure, theme tokens, className/style, typography, layout, motion. The auth contract from the skill above stays intact: \`setAuthToken\`, \`authFetch('/api/auth/sync')\`, \`setUser\`, \`onSuccess\`, the bootstrap \`init()\` call in \`main.tsx\` — every one of those steps must exist in the final code. If you find yourself rewriting an existing handler "while you're there", stop and revert that change. Backend files (\`server/\`, \`api/\`, \`*.route.ts\`) are out of scope for the design pass unless the developer explicitly named them.`,
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
    `- Session persistence is half the scaffold, not a follow-up: the auth store MUST expose \`init()\` AND \`main.tsx\` MUST call it before the first render. The skill's "Session bootstrap" section has the canonical Zustand + main.tsx example — follow it verbatim. Skipping this means refresh-after-login lands on /login or an infinite spinner, every single time.`,
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
  try {
    // Scaffold turn — main agent reads the skill bundle inline and writes the
    // proxy backend + frontend wiring.
    await runAgentWithCallbacks(prompt, {
      addUserMessage: true,
      userMessageText,
      useConversationHistory: true,
      cmdOnlyMode,
    })

  } finally {
    // Belt-and-braces: each sub-step (scaffold turn, verifier, fix turn)
    // resets its own status in its finally, but the chain has enough
    // moving parts (loop returns, abort listener races, sub-agent crash
    // paths) that a stray non-idle status can slip through and pin the
    // top-bar activity indicator on "Reasoning…" after the flow ended.
    // A user reported exactly that — header read "A raciocinar…" after
    // the "Auth flow verified end-to-end" system message had already
    // landed. Single explicit reset here covers every exit path.
    if (useAgentStore.getState().status !== 'idle') {
      useAgentStore.getState().setStatus('idle')
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

  // Envelope copy is the load-bearing part of this flow. Earlier wording
  // ("Apply the recipe to ALL UI you build in this turn") sent the model
  // into greenfield mode even when the project was already built — which
  // is the common shape for `#design` ("make the existing app look
  // better"). The model would `write_file` whole components and drop
  // handlers / API calls / hook deps along the way (see PLAN-DATA-VIEWER's
  // sibling discussion; user-reported regression in login + backend after
  // running `#design` on a working app). The reframed envelope below
  // splits the directive into two beats:
  //   1. Greenfield → apply the recipe in full, as before.
  //   2. Refactor (file already exists) → apply only to presentation
  //      surfaces; every handler, API call, hook dep, auth-contract step
  //      survives verbatim; backend files out of scope unless named.
  // It is still a prompt-level mitigation — the model decides whether to
  // honour it. The rollback-banner path is the real defense (see
  // recommendation in this turn's analysis); this is the cheap
  // intervention while that bigger change is queued.
  const prompt = [
    `<design_skill name="frontend-design">`,
    designSkill,
    `</design_skill>`,
    ``,
    `The developer dropped \`#design\` in the prompt. The aesthetic direction in the recipe above is the goal — distinctive typography (avoid Inter / system defaults), cohesive color palette with intentional accents, asymmetric layout where it serves the design, one orchestrated motion moment over many scattered ones. Commit to ONE direction; refined minimalism and maximalist chaos both work, the timid middle does not. The result should be visually striking AND production-grade — not generic AI chrome.`,
    ``,
    `Decide first which mode you are in for each file you touch:`,
    ``,
    `- **Greenfield** — the target file does not exist yet. Apply the recipe in full: new tokens, new typography, new layout. Free hand.`,
    `- **Refactor** — the target file already exists. The design pass applies to **presentation surfaces only**: JSX/template structure, theme tokens, className / style props, typography choices, layout primitives, motion. **Preserve verbatim**: every event handler, every \`useEffect\`/\`useMemo\`/\`useCallback\` dependency, every API call, every router target, every state-management call (\`setAuthToken\`, \`authFetch\`, \`setUser\`, \`onSuccess\`, store actions, fetcher hooks), every imported helper that has side effects. If the file has \`useState\`, \`useEffect\`, \`fetch\`/\`axios\`, or any auth/data-layer import, **assume refactor**.`,
    ``,
    `When in doubt about a single line — keep it. The bar is "the prior behaviour survives the rewrite minus the visual swap"; removing anything that is not part of the visual layer is a regression, even when the new layout reads better without it. If you find yourself rewriting a handler "while you're there", stop and revert that part of the change before continuing.`,
    ``,
    `Out of scope for this turn unless the developer explicitly named them: backend files (\`server/\`, \`api/\`, \`*.route.ts\`, \`*.controller.ts\`), database schemas, migration files, build / lint / TS config. "Make the app look better" is a frontend presentation request — touching the backend is scope creep.`,
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
