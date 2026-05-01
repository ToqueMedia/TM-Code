import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../../../stores/chatStore'
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
 * (auth-proxy-gip SKILL.md, plus google-signin SKILL.md when Google is
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
): string {
  const wantsGoogle = providers.includes('google')
  const wantsEmail = providers.includes('email-password')

  const skillsBlock = [
    `<auth_skill name="auth-proxy-gip">`,
    authProxySkill,
    `</auth_skill>`,
    ...(googleSigninSkill
      ? [``, `<auth_skill name="google-signin">`, googleSigninSkill, `</auth_skill>`]
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
    `1. Call \`provision_auth(provider: "gip")\`. This creates the per-project GIP tenant on the platform and writes the Firebase config to \`.env\` (VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, VITE_GIP_TENANT_ID, plus backend mirrors GIP_FIREBASE_API_KEY / GIP_TENANT_ID / GCP_PROJECT_ID). Do not skip — without this the credentials don't exist.`,
    ``,
    `2. Inspect the project to choose the backend stack: read package.json (existing deps like express, hono, fastify, @nestjs/core), or look for pyproject.toml / go.mod for non-Node projects. If the project is a fresh frontend-only repo and the developer didn't specify, ask which backend stack they prefer (one short question, then proceed).`,
    ``,
    `3. Implement the auth-proxy backend in your chosen stack — endpoints from the skill: POST /api/auth/proxy/{signup,signin,google,refresh} + POST /api/auth/sync. Wire the Identity Toolkit calls with VITE_FIREBASE_API_KEY (or GIP_FIREBASE_API_KEY server-side). For JWT verification on /api/auth/sync, use the JWKS pattern from the skill (jose / jsonwebtoken / python-jose / golang-jwt depending on stack).`,
    ``,
    `4. Define a users table/document in whatever DB the project uses (Postgres + Prisma/Drizzle, MongoDB, SQLite, Turso, Supabase, etc.). Minimum columns: uid (PK), email (unique), name, avatarUrl, role, createdAt, updatedAt. Custom columns MUST be nullable or have defaults — sync runs from JWT data on first sign-in.`,
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
    ``,
    `Hard rules (do NOT break):`,
    `- NEVER modify .env directly — TM Code injects credentials.`,
    `- NEVER install firebase-admin. The auth-proxy uses the Identity Toolkit REST API with VITE_FIREBASE_API_KEY (a public key); there is no Admin SDK in this stack.`,
    `- NEVER call request_credentials for anything Firebase / GIP / GCP-related. The user does not have GOOGLE_APPLICATION_CREDENTIALS, serviceAccountKey.json, or GIP_SERVICE_ACCOUNT_* — those live only on the TM Code platform worker.`,
    `- NEVER import signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, or signOut from firebase/auth. Only onAuthStateChanged is allowed.`,
    `- ALWAYS call /api/auth/sync after a successful proxy signup or signin to upsert the user row.`,
    `- ALWAYS use authFetch (or the project's equivalent) for protected API calls.`,
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
): Promise<void> {
  const chatStore = useChatStore.getState()
  const wantsGoogle = providers.includes('google')

  // Load the bundled skill content in parallel so the agent gets the full
  // recipe(s) inline — no round-trip to read_skill mid-turn.
  const [authProxySkill, googleSigninSkill] = await Promise.all([
    fetchBundledSkill('auth-proxy-gip'),
    wantsGoogle ? fetchBundledSkill('google-signin') : Promise.resolve(null),
  ])

  if (!authProxySkill) {
    chatStore.addSystemMessage(
      'Could not load the auth-proxy-gip skill. The bundled resources may be missing — reinstall TM Code if this persists.'
    )
    return
  }
  if (wantsGoogle && !googleSigninSkill) {
    chatStore.addSystemMessage(
      'Could not load the google-signin skill. Proceeding with email/password only — re-add `#auth-google` once the skill is available.'
    )
  }

  // Force-load the auth skills into the SkillService cache BEFORE the agent
  // runs. Without this, the agent's `read_skill("auth-proxy-gip")` calls hit
  // the relevance heuristic (which rejects auth skills for projects with no
  // detectable type, e.g. an empty directory) and return "not loaded" — the
  // agent then falls back to training-data implementations and ignores the
  // skill entirely. This keeps the system-prompt skill index, the read_skill
  // tool, and the inline `<auth_skill>` blocks in the prompt all consistent.
  const skillService = SkillService.getInstance()
  skillService.forceLoadSkill('auth-proxy-gip')
  if (wantsGoogle && googleSigninSkill) {
    skillService.forceLoadSkill('google-signin')
  }

  const prompt = buildPrompt(providers, instructions, authProxySkill, googleSigninSkill)

  await runAgentWithCallbacks(prompt, {
    addUserMessage: true,
    userMessageText,
    useConversationHistory: true,
  })
}
