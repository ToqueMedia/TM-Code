import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../../../stores/chatStore'
import { runAgentWithCallbacks } from '../agentRunner'
import { logger } from '../../../utils/logger'

/**
 * /auth — explicit trigger for the GIP auth scaffolding flow.
 *
 *   /auth email-password
 *   /auth google
 *   /auth email-password google
 *   /auth email-password google use minimal forms, no avatar upload
 *
 * Pattern follows /payments: this command pre-loads the authoritative skill
 * content (auth-proxy-gip SKILL.md, plus google-signin SKILL.md when Google is
 * requested) and injects it into the agent's prompt as <auth_skills> context.
 * The agent gets a single, self-contained instruction with everything needed
 * to implement — no round-trip to read_skill, no uncertainty about which
 * recipe applies.
 *
 * Works in chat AND CMD modes — registered in slashCommandRegistry, which
 * both prompt-bar hooks consult.
 */

type Provider = 'email-password' | 'google'

/**
 * Canonical argument values surfaced by the prompt-bar autocomplete after the
 * user types `/auth ` (space). Aliases like `password`, `email`, `gmail`
 * still parse correctly via PROVIDER_ALIASES below — they are just not shown
 * in the menu to keep the picker uncluttered.
 */
export const AUTH_ARG_SUGGESTIONS: Array<{ value: string; description: string }> = [
  { value: 'email-password', description: 'Email + password sign-up and sign-in' },
  { value: 'google',         description: 'Google sign-in via Google Identity Services' },
]

const PROVIDER_ALIASES: Record<string, Provider> = {
  'email-password': 'email-password',
  'email/password': 'email-password',
  'email_password': 'email-password',
  'emailpassword': 'email-password',
  'password': 'email-password',
  'email': 'email-password',
  'google': 'google',
  'gmail': 'google',
  'oauth-google': 'google',
}

interface ParsedArgs {
  providers: Provider[]
  instructions: string
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const providers: Provider[] = []
  const remaining: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const provider = PROVIDER_ALIASES[token.toLowerCase()]
    if (provider && !providers.includes(provider)) {
      providers.push(provider)
    } else {
      // First non-provider token marks the start of free-form instructions —
      // everything from here on is treated as the user's prose, even if a
      // later word would otherwise look like a provider name.
      remaining.push(...tokens.slice(i))
      break
    }
  }

  return { providers, instructions: remaining.join(' ').trim() }
}

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
    `The developer triggered \`/auth\` and wants to add ${providerLine} to this project. The skill content above is the authoritative protocol — follow it. Stack choice (Express, Hono, Fastify, NestJS, FastAPI, Go, etc.) is YOURS to make: match what the project already uses, or pick something sensible if it's a fresh project.`,
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

export async function executeAuth(args: string, _projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()
  const parsed = parseArgs(args)

  if (parsed.providers.length === 0) {
    chatStore.addSystemMessage(
      'Usage: `/auth <provider> [more providers] [instructions]`\n\n' +
      'Providers:\n' +
      '  • `email-password` — email + password sign-up/sign-in\n' +
      '  • `google` — Google sign-in (GIS)\n\n' +
      'Examples:\n' +
      '  /auth email-password\n' +
      '  /auth google\n' +
      '  /auth email-password google\n' +
      '  /auth email-password google use minimal forms, no avatar upload'
    )
    return
  }

  const wantsGoogle = parsed.providers.includes('google')

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
      'Could not load the google-signin skill. Proceeding with email/password only — re-run `/auth google` once the skill is available.'
    )
  }

  const prompt = buildPrompt(parsed.providers, parsed.instructions, authProxySkill, googleSigninSkill)

  await runAgentWithCallbacks(prompt, {
    addUserMessage: true,
    userMessageText: `/auth ${args}`.trim(),
    useConversationHistory: true,
  })
}
