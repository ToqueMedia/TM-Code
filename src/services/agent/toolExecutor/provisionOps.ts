/**
 * Provision tools — provision_auth, provision_database, provision_files, provision_deploy.
 *
 * Extracted from toolExecutor.ts as part of the SOLID decomposition.
 * These tools provision platform-managed resources (auth tenants, databases,
 * file storage, deploy infrastructure) by calling the TM Code Worker APIs
 * and writing credentials to .env.
 */

import { invoke } from '@/utils/invokeMetrics'
import { useProjectStore } from '../../../stores/projectStore'
import { PUBLISHING_SKILL_NAME } from '../skillService'
import { tauriFetch } from '../../tauriFetch'
import { resolveWorkerUrl, resolveDeployUrl } from '../../../utils/devUrls'
import { IS_VITE_DEV } from '../../../utils/viteEnv'
import type { ToolRegistrationContext } from './context'

const DEV_DEPLOY_HEADER: Record<string, string> = IS_VITE_DEV
  ? { 'TM-Code': 'dev-deploy' }
  : {}
import FirebaseAuthService from '../../auth/firebaseAuth'

export function registerProvisionTools(ctx: ToolRegistrationContext): void {

  // === provision_auth ===
  // One-shot tool that provisions authentication for the current project:
  // 1. Calls the backend's /v1/auth/provision-gip to get-or-create the
  //    per-project auth tenant on the shared platform project. Idempotent.
  // 2. Writes the returned credentials to .env via write_env_vars: the
  //    neutral TM_* names (preferred for new code) PLUS the legacy
  //    FIREBASE_* / GIP_* / GCP_PROJECT_ID names (backward compat with
  //    already-scaffolded projects whose code still references them).
  // 3. Returns a structured summary with the auth contract (env keys, env
  //    loading rules, auth-API call shape, frontend wiring, DB caveats,
  //    smoke test) — read by the agent before it scaffolds the auth-proxy.
  //
  // The agent uses this when the user requests login/signup/auth in their
  // project. After this tool returns, the agent should:
  //   - read_skill('auth-proxy') for the frontend recipe
  //   - read_skill('google-signin') if Google sign-in is requested
  //   - mount the auth-proxy router in the backend entry (app.use('/api', authProxyRouter))
  //
  // This tool does NOT write code or copy boilerplate. The agent chooses the
  // backend stack (Express / Hono / Fastify / Nest / FastAPI / Go / etc.) and
  // implements routes following the skill — see authCommand.ts.
  ctx.tools.set('provision_auth', {
    definition: {
      name: 'provision_auth',
      description:
        'Set up TM Code Authentication for the current project. Reserves a per-project auth tenant on the platform and writes the necessary credentials to .env. Use ONCE per project when the user requests login/signup/auth. The agent then implements the auth-proxy and frontend in whatever stack fits the project (Express, Hono, Fastify, FastAPI, etc.) — see read_skill("auth-proxy") for the protocol. After this returns, the project has every credential it needs: the auth-proxy uses the public client key written to .env for identity provider calls. Skip request_credentials for any platform-managed credential (admin SDK keys, service-account files, infrastructure tokens) — they live only on the TM Code worker and the user does not have them.',
      input_schema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['gip'],
            description: 'Auth provider. Currently only "gip" is supported.',
          },
        },
        required: ['provider'],
      },
    },
    execute: async (input) => {
      const provider = String(input.provider || '').toLowerCase()
      if (provider !== 'gip') {
        return `Unsupported auth provider: ${provider}. Only "gip" is supported.`
      }

      const project = useProjectStore.getState().currentProject
      if (!project) {
        return 'No project is open. Open a project before provisioning auth.'
      }

      // Early-return guard: if auth is already provisioned (detected from
      // .env + filesystem markers), don't re-run the network call. The
      // backend is idempotent (get-or-create) so re-running is safe — but
      // returning early with an instructive message avoids wasted tokens
      // AND signals to the agent "fix existing" instead of "re-scaffold".
      // Defense-in-depth alongside the system-prompt section and the UI
      // hint that warn before the tool is even invoked.
      try {
        const { detectScaffolding } = await import('../../scaffoldingDetector')
        const detected = await detectScaffolding(project.path)
        const hasEmailAuth = detected.applied.includes('auth.email-password')
        const hasGoogleAuth = detected.applied.includes('auth.google')
        if (hasEmailAuth || hasGoogleAuth) {
          const evidence: string[] = []
          if (hasEmailAuth) evidence.push(...(detected.evidence['auth.email-password'] ?? []))
          if (hasGoogleAuth) evidence.push(...(detected.evidence['auth.google'] ?? []))
          // Telemetry for the agent-initiated re-provision path. The
          // smart-router (chat-mode + cmd-mode) covers user-initiated
          // hashtag re-runs; this captures the case where the model
          // reaches for provision_auth on its own despite the system-
          // prompt section. High frequency = system prompt isn't being
          // attended to; consider strengthening the bookend.
          import('../../analytics').then(({ trackEvent }) => {
            void trackEvent('provision_auth_early_return', {
              applied: [hasEmailAuth ? 'auth.email-password' : '', hasGoogleAuth ? 'auth.google' : ''].filter(Boolean).join(','),
            })
          }).catch(() => { /* non-critical */ })
          return `Already provisioned. Detected: ${evidence.join(', ')}.\n\nDO NOT re-run provision_auth on the default path — the .env credentials already exist and the backend is idempotent (returns the same tenant). The default task is to FIX the existing implementation:\n  1. read_file the marker paths above to see what's there.\n  2. Diagnose the actual bug (read_dev_server_logs for runtime errors, execute_command "npx tsc --noEmit" for type errors).\n  3. Edit the broken file with edit_file.\n\nEXCEPTION — explicit re-provisioning. If the developer's CURRENT message includes any of: "re-provision", "rotate credentials", "wipe and start over", "reset the auth", "delete and re-create the tenant", "reprovisiona", "rotaciona credenciais", "apaga e recomeça" — they have OPTED IN. In that case, ack in chat what you'll do, then call provision_auth again (the same call you just received). The platform is idempotent so the tenant won't duplicate; .env is overwritten with the same values; no destructive change to data. If the developer's intent is unclear, ASK before re-running.`
        }
      } catch { /* non-critical — fall through to normal provisioning */ }

      const firebaseAuth = FirebaseAuthService.getInstance()
      const idToken = await firebaseAuth.getIdToken()
      if (!idToken) {
        return 'Not authenticated to TM Code. Sign in first, then retry.'
      }

      const workerUrl = resolveWorkerUrl()
      let provisionRes: Awaited<ReturnType<typeof tauriFetch>>
      try {
        provisionRes = await tauriFetch(`${workerUrl}/v1/auth/provision-gip`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            projectId: project.id,
            projectName: project.name,
          }),
        })
      } catch (err) {
        // Same hard-stop contract as the HTTP-error path below. Network
        // failures used to read as transient by the model and trigger
        // "let me ask the developer for the credentials instead", which
        // is always wrong (the credentials don't exist until provision_auth
        // succeeds).
        return (
          `PROVISION_AUTH FAILED — STOP THE AUTH IMPLEMENTATION NOW.\n\n` +
          `Network error reaching the auth provisioning endpoint: ${err instanceof Error ? err.message : String(err)}\n\n` +
          `Do NOT fall back to request_credentials for VITE_FIREBASE_*, VITE_TM_*, VITE_GOOGLE_CLIENT_ID. ` +
          `Those credentials do not exist until provision_auth succeeds; asking the developer to type them is impossible to satisfy.\n\n` +
          `Required recovery: report the network error to the developer in chat, suggest checking their connection, and wait for them to decide whether to retry. Do not auto-retry.`
        )
      }

      if (!provisionRes.ok) {
        const body = await provisionRes.text().catch(() => '')
        // STOP signal — without this, the model rationalises around the
        // failure and falls back to request_credentials for VITE_FIREBASE_*
        // and friends, which only ever produces a form the developer
        // cannot satisfy. Hard-block the rationalisation by naming the
        // exact wrong-next-steps and prescribing the correct recovery.
        return (
          `PROVISION_AUTH FAILED — STOP THE AUTH IMPLEMENTATION NOW.\n\n` +
          `Error from worker (HTTP ${provisionRes.status}): ${body.slice(0, 300)}\n\n` +
          `What this means: the platform tenant for this project could not be created. ` +
          `Without it, NONE of the auth credentials exist — there is no Firebase API key, no auth domain, ` +
          `no tenant id, no Google client id. Auth simply cannot be implemented until provision_auth succeeds.\n\n` +
          `Wrong recovery paths (DO NOT TAKE):\n` +
          `  ✗ request_credentials for VITE_FIREBASE_*, VITE_TM_*, VITE_GOOGLE_CLIENT_ID — the developer does not have these; the form will block on the platform-managed field IDs anyway.\n` +
          `  ✗ "implement auth-proxy manually" — the proxy still needs the platform tenant; without it every call returns API_KEY_INVALID.\n` +
          `  ✗ scaffold a LoginScreen / Firebase init expecting VITE_FIREBASE_API_KEY to exist later.\n\n` +
          `Required recovery:\n` +
          `  1. STOP the auth task. Do not write any auth-related code.\n` +
          `  2. Tell the developer in chat what happened — quote the error above verbatim.\n` +
          `  3. Suggest one of: (a) retry provision_auth in a new chat turn if this is a transient error, (b) report the error to TM Code support if it persists, (c) skip the auth feature for now.\n` +
          `  4. Wait for the developer's decision. Do not auto-retry.`
        )
      }

      const data = (await provisionRes.json()) as {
        tenantId?: string
        apiKey?: string
        authDomain?: string
        projectId?: string
        googleClientId?: string | null
      }

      if (!data.tenantId || !data.apiKey || !data.authDomain || !data.projectId) {
        return `Provisioning returned incomplete data: ${JSON.stringify(data)}`
      }

      // Write the credentials to .env via the same single-write-path used by
      // request_credentials. Dual-write the new TM-prefixed names + the
      // legacy Firebase/GIP/GCP names so existing user projects (which
      // reference the legacy names in their code) continue to work, while
      // new code generated by the agent uses the neutral names. Both sets
      // hold the same values; the duplication is the migration cost paid
      // once per project. The legacy names will be removed in a future
      // release after enough projects have migrated.
      const envVars: Array<{ key: string; value: string }> = [
        // Neutral names (preferred for new code)
        { key: 'VITE_TM_AUTH_KEY', value: data.apiKey },
        { key: 'VITE_TM_AUTH_DOMAIN', value: data.authDomain },
        { key: 'VITE_TM_PROJECT_ID', value: data.projectId },
        { key: 'VITE_TM_TENANT_ID', value: data.tenantId },
        { key: 'TM_AUTH_KEY', value: data.apiKey },
        { key: 'TM_TENANT_ID', value: data.tenantId },
        { key: 'TM_PROJECT_ID', value: data.projectId },
        // Legacy names (kept for backward compatibility with already-scaffolded
        // projects). New agent-generated code reads the TM_* names above;
        // these continue to be written so a re-provision on an old project
        // doesn't break existing references.
        { key: 'VITE_FIREBASE_API_KEY', value: data.apiKey },
        { key: 'VITE_FIREBASE_AUTH_DOMAIN', value: data.authDomain },
        { key: 'VITE_FIREBASE_PROJECT_ID', value: data.projectId },
        { key: 'VITE_GIP_TENANT_ID', value: data.tenantId },
        { key: 'GCP_PROJECT_ID', value: data.projectId },
        { key: 'GIP_TENANT_ID', value: data.tenantId },
        { key: 'GIP_FIREBASE_API_KEY', value: data.apiKey },
      ]
      if (data.googleClientId) {
        envVars.push({ key: 'VITE_TM_GOOGLE_CLIENT_ID', value: data.googleClientId })
        envVars.push({ key: 'VITE_GOOGLE_CLIENT_ID', value: data.googleClientId }) // legacy
      }

      try {
        await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
      } catch (err) {
        return `Wrote tenant ${data.tenantId} but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
      }

      // .env just changed — invalidate detection cache so the next
      // detectScaffolding call picks up the new credentials immediately.
      try {
        const { invalidateScaffoldingCache } = await import('../../scaffoldingDetector')
        invalidateScaffoldingCache(project.path)
      } catch { /* non-critical */ }

      // Structured contract: machine-readable header + skill-readable
      // body. The header lists the env vars and the rules the agent must
      // honour when implementing the proxy. Empirically (BugHunterKimi
      // session, May 2026) the prose-only response let the agent forget
      // canonical rules — `tenantId` was dropped from `signInWithIdp`,
      // backend env was read from `VITE_*` instead of `GIP_*` mirrors,
      // dotenv.config() was used manually instead of `--env-file`.
      // The structured block makes each rule one bullet per scan line.
      const lines: string[] = []
      // Tenant id is internal-ish (matters for diagnosing auth bugs) but
      // the platform GCP project id is not relevant to the chat agent —
      // it would leak the platform project name when the developer asks
      // the agent to summarise what happened or generate manual-deploy
      // scripts. Keep the tenant id (already in .env via VITE_GIP_TENANT_ID),
      // drop the project id.
      lines.push(`Authentication tenant ready: ${data.tenantId}.`)
      lines.push(`.env written: ${envVars.map((v) => v.key).join(', ')}.`)
      lines.push('')
      lines.push('## Auth contract (do not improvise — these rules are not negotiable)')
      lines.push('')
      lines.push('### Env keys (already in .env — read them, do not regenerate)')
      lines.push('  - Frontend (Vite, public): VITE_TM_AUTH_KEY, VITE_TM_AUTH_DOMAIN, VITE_TM_PROJECT_ID, VITE_TM_TENANT_ID' + (data.googleClientId ? ', VITE_TM_GOOGLE_CLIENT_ID' : ''))
      lines.push('  - Backend (server-only): TM_AUTH_KEY, TM_TENANT_ID, TM_PROJECT_ID')
      lines.push('  - The backend reads the server-only names (TM_* without VITE_ prefix), the frontend reads the VITE_TM_* mirrors. Both hold the same values; the split avoids the bug where the agent reads a frontend key on the server before dotenv loads.')
      lines.push('  - Legacy names (VITE_FIREBASE_*, GIP_*, GCP_PROJECT_ID, VITE_GOOGLE_CLIENT_ID) are also written for backward compat with existing code. New code reads the TM_* names — explain to the developer as "your project credentials" in chat prose, not by listing variable names.')
      lines.push('')
      lines.push('### Env loading (eliminates the dotenv-config-after-imports class of bug)')
      lines.push('  - Node 20.6+: pass --env-file=.env in the dev script (e.g. `tsx watch --env-file=../.env src/index.ts`).')
      lines.push('  - Bun: loads .env automatically.')
      lines.push('  - NestJS: ConfigModule.forRoot({ isGlobal: true }).')
      lines.push('  - Older Node fallback only: `import \'dotenv/config\'` at the very top of the entry file. Never `dotenv.config({ path: ... })` after other imports — ESM hoists imports above the call.')
      lines.push('')
      lines.push('### Auth-API calls')
      lines.push('  - Every signInWithIdp / signInWithPassword / signUp request body includes `tenantId` (read from `TM_TENANT_ID`). Without it, the auth API returns 400 with INVALID_ID_TOKEN or a tenant-mismatch error.')
      lines.push('  - Map auth-API 4xx responses to 401 (auth failure), not 502. 502 is for upstream 5xx / network errors only.')
      lines.push('')
      lines.push('### Frontend wiring')
      lines.push('  - Vite proxy MUST forward /api to the backend port — `server.proxy[\'/api\']` in vite.config.ts. Without it, every fetch(\'/api/...\') hits port 5173 and returns 404 HTML. CORS headers are NOT a substitute.')
      lines.push('  - In a monorepo (vite.config.ts in client/ while .env is at root), set `envDir: path.resolve(__dirname, \'..\')`. In a flat layout, do NOT set envDir — over-set silently breaks all VITE_* reads.')
      lines.push('  - firebase.ts: `auth.tenantId = import.meta.env.VITE_TM_TENANT_ID`. Inside an iframe (IDE preview), call `setPersistence(auth, inMemoryPersistence)`.')
      lines.push('  - Only `onAuthStateChanged` is importable from firebase/auth. NEVER signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, etc. — popup is silently blocked in the IDE preview webview.')
      lines.push('')
      lines.push('### Data layer — publish-ready by DEFAULT (TM Code Database)')
      lines.push('  - Use `drizzle-orm` + `@libsql/client` for persistence. The harness rejects incompatible-shape deps (`@prisma/client`, `prisma`, `better-sqlite3`, `sqlite3`, `mysql2`, `pg`) on writes to package.json in **Chat mode only** — Prisma needs a persistent connection (incompatible with Cloud Run scale-to-zero + worker HTTPS proxy); native-bound SQLite drivers and non-SQLite dialects don\'t round-trip through the worker. **Terminal/CMD mode is stack-free**: no harness restriction on database drivers — you may freely install mysql2, pg, Prisma, etc.')
      lines.push('  - Generate `server/db.ts` with the dev/prod connection switch: `drizzle-orm/libsql/node` against `DATABASE_URL=file:./dev.db` in dev, `drizzle-orm/sqlite-proxy` against `TMDB_URL` + `TMDB_TOKEN` in prod. The libSQL endpoint and Turso credentials stay in the TM Code Worker — never in user code or `.env`.')
      lines.push('  - Schema in TypeScript via `server/schema.ts`. Generate migrations with `drizzle-kit generate`; the deploy pipeline reapplies them against the app\'s TMDB at publish time.')
      lines.push('  - Full SQL ergonomics — `where + orderBy` on different fields, multi-where, JOINs, aggregations, transactions. No composite-index trap. Performance indexes via `index().on(...)` in Drizzle schema.')
      lines.push('')
      lines.push('### Dockerfile — generated in the SAME scaffold turn')
      lines.push('  - When the project has a backend (server/ or backend/ directory, or backend deps), generate a `Dockerfile` + `.dockerignore` at the project root in the same turn that creates the backend code. The Publish detector classifies a project as composite only when `Dockerfile` is present; without it, Publish ships the frontend and the backend stays unpublished — silent failure mode.')
      lines.push('  - Templates by language in `read_skill("publish-backend")` §8. Node 22 is the default; Python (FastAPI/Flask) is the other shipped option.')
      lines.push('  - Skip `cloudbuild.yaml` — the platform build pipeline runs an inline spec server-side; a file at the project root is unused.')
      lines.push('')
      lines.push('### Existing-project rule')
      lines.push('  - When you find legacy `firebase-admin/firestore` or Prisma in the project, port it to Drizzle + libSQL first, before adding auth code. A hybrid persistence layer breaks Publish.')
      lines.push('  - `firebase-admin/auth` stays — it\'s used for GIP JWT verification, separate from the data layer. Only the `/firestore` and `/database` imports are removed.')
      lines.push('  - For the auth-proxy boilerplate, `read_skill("auth-proxy")` covers Express, Fastify, NestJS, Hono, FastAPI.')
      lines.push('')
      lines.push('### After the phase that adds /api/auth/* — REQUIRED smoke test')
      lines.push('  - `execute_command: curl -s -o /dev/null -w \'%{http_code} %{content_type}\\n\' http://localhost:5173/api/auth/me` MUST return `401 application/json`. If 404 HTML, the Vite proxy is missing — fix before claiming the phase done.')
      lines.push('')
      lines.push('## Next-step references')
      lines.push('  1. read_skill("auth-proxy") for the full protocol.')
      lines.push('  2. read_skill("google-signin") if Google sign-in is requested.')
      lines.push('  3. CREDENTIALS COMPLETE — request_credentials is for third-party integrations the developer adds (OpenAI, Stripe, etc.), not for anything the platform manages. The public client key in .env is the only auth credential the project needs; admin keys and service-account files live only on the platform side.')

      return lines.join('\n')
    },
  })

  // === provision_database ===
  // Reserves a per-app SQLite/libSQL database on the platform's Turso fleet
  // and writes the two credentials user code needs (`TMDB_URL` +
  // `TMDB_TOKEN`) to .env. The Turso platform token and the database's
  // own JWT stay on the TM Code Worker — user code only sees the
  // app-scoped TMDB token, which the worker validates per request.
  //
  // The endpoint is idempotent (worker reuses an existing record when
  // present), so re-running on an already-provisioned project just
  // returns the existing credentials. Same shape as provision_auth.
  ctx.tools.set('provision_database', {
    definition: {
      name: 'provision_database',
      description:
        "Set up TM Code Database (per-app SQLite/libSQL on Turso) for the current project. Reserves the app's database on the platform, mints an app-scoped TMDB token, and writes TMDB_URL + TMDB_TOKEN to .env. The Turso platform token and per-DB JWT stay on the TM Code Worker — user code talks to the worker via HTTPS using the TMDB_TOKEN. Call when the project needs persistence in production (an auth user record, app state, anything that must survive container restarts). Local dev alone does not need this — db.ts can stay on `DATABASE_URL=file:./dev.db`. The endpoint is fully idempotent: calling on an already-provisioned project returns the same credentials with zero side-effect, so call it whenever the .env mechanical check (look for TMDB_URL and TMDB_TOKEN) shows either is missing — including after a transient failure where you're retrying. After a successful return, generate `server/db.ts` with the dev/prod connection switch from read_skill(\"publish-backend\") and `server/schema.ts` for Drizzle.",
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    execute: async () => {
      const project = useProjectStore.getState().currentProject
      if (!project) {
        return 'No project is open. Open a project before provisioning the database.'
      }

      const firebaseAuth = FirebaseAuthService.getInstance()
      const idToken = await firebaseAuth.getIdToken()
      if (!idToken) {
        return 'Not authenticated to TM Code. Sign in first, then retry.'
      }

      const workerUrl = resolveWorkerUrl()
      let provisionRes: Awaited<ReturnType<typeof tauriFetch>>
      try {
        provisionRes = await tauriFetch(
          `${workerUrl}/v1/apps/${encodeURIComponent(project.id)}/database/provision`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({}),
          },
        )
      } catch (err) {
        // Same hard-stop posture as provision_auth: network failure must
        // not become "let me ask the developer for the DB URL", because
        // the developer doesn't own those credentials. Wait for the user.
        return (
          `PROVISION_DATABASE FAILED — STOP DATA-LAYER WORK.\n\n` +
          `Network error reaching the database provisioning endpoint: ${err instanceof Error ? err.message : String(err)}\n\n` +
          `Do NOT fall back to request_credentials for TMDB_URL, TMDB_TOKEN, DATABASE_URL — those credentials are minted by the platform and do not exist until provision_database succeeds.\n\n` +
          `Required recovery: report the network error to the developer in chat, suggest checking their connection, and wait for them to decide whether to retry. Do not auto-retry.`
        )
      }

      if (!provisionRes.ok) {
        const body = await provisionRes.text().catch(() => '')
        return (
          `PROVISION_DATABASE FAILED — STOP DATA-LAYER WORK.\n\n` +
          `Error from worker (HTTP ${provisionRes.status}): ${body.slice(0, 300)}\n\n` +
          `What this means: the platform could not provision a per-app database. ` +
          `Without it, TMDB_URL / TMDB_TOKEN do not exist and production persistence cannot be wired up.\n\n` +
          `Wrong recovery paths (DO NOT TAKE):\n` +
          `  ✗ request_credentials for TMDB_URL / TMDB_TOKEN / DATABASE_URL — the developer does not own these.\n` +
          `  ✗ swap to a different ORM/driver hoping it bypasses the platform — in Chat mode the harness rejects Prisma, mysql2, pg, sqlite3, better-sqlite3 on package.json writes; Terminal/CMD mode is stack-free and has no such restriction.\n\n` +
          `Required recovery:\n` +
          `  1. STOP the data-layer task. Do not write db.ts / schema.ts / migrations.\n` +
          `  2. Tell the developer what happened — quote the error above verbatim.\n` +
          `  3. If the error says "group not found" / "HTTP 400" / "Turso ..." (any platform-side rejection): ask the developer to share the line that starts with \`[turso] createDatabase:\` from the TM Code Worker logs (\`wrangler tail\` or the dev terminal). That line shows the org + group + db-name the worker actually sent, which pinpoints whether it's a config issue (wrong group), a stale build (wrangler dev not restarted), or a true upstream outage.\n` +
          `  4. Suggest one of: (a) retry provision_database in a new chat turn if transient, (b) report to TM Code support if it persists, (c) keep persistence local-dev-only by using DATABASE_URL=file:./dev.db without the prod branch.\n` +
          `  5. Wait for the developer's decision. Do not auto-retry.`
        )
      }

      const data = (await provisionRes.json()) as {
        tmdbUrl?: string
        tmdbToken?: string
        dbName?: string
        reused?: boolean
      }

      if (!data.tmdbUrl || !data.tmdbToken || !data.dbName) {
        return `Provisioning returned incomplete data: ${JSON.stringify(data)}`
      }

      const envVars: Array<{ key: string; value: string }> = [
        { key: 'TMDB_URL', value: data.tmdbUrl },
        { key: 'TMDB_TOKEN', value: data.tmdbToken },
      ]

      try {
        await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
      } catch (err) {
        return `Database provisioned (${data.dbName}) but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
      }

      const reusedSuffix = data.reused ? ' (reused existing)' : ''
      const lines: string[] = []
      lines.push(`Database ready: ${data.dbName}${reusedSuffix}.`)
      lines.push(`.env written: TMDB_URL, TMDB_TOKEN.`)
      lines.push('')
      lines.push('## Database contract (do not improvise)')
      lines.push('')
      lines.push('### Connection switch (server/db.ts)')
      lines.push('  - Dev (`NODE_ENV !== "production"`): `drizzle-orm/libsql/node` with `createClient({ url: process.env.DATABASE_URL ?? "file:./dev.db" })`.')
      lines.push('  - Prod (`NODE_ENV === "production"`): `drizzle-orm/sqlite-proxy` driver, forwarding queries to `${TMDB_URL}` over HTTPS with `Authorization: Bearer ${TMDB_TOKEN}`. The worker accepts `POST { sql, params, method }` for single queries and `POST { batch: [...] }` for transactions.')
      lines.push('  - The user code MUST NOT import `@libsql/client` directly in production — the worker is the only path to Turso. Direct libsql connections from Cloud Run will fail (no platform token in user env).')
      lines.push('')
      lines.push('### Schema (server/schema.ts)')
      lines.push('  - Drizzle table definitions in TypeScript. Add `index().on(field)` for query hot paths.')
      lines.push('  - Generate migrations with `drizzle-kit generate --config=drizzle.config.ts` after schema changes.')
      lines.push('  - The deploy pipeline reapplies migration SQL against the app\'s TMDB on publish. Local dev runs `drizzle-kit push` or `drizzle-kit migrate` against the file:./dev.db, never against TMDB.')
      lines.push('')
      lines.push('### Forbidden')
      lines.push('  - `@prisma/client`, `prisma`, `better-sqlite3`, `sqlite3`, `mysql2`, `pg` — the write_file harness rejects these on package.json edits **in Chat mode only**. Terminal/CMD mode is stack-free — no harness restriction on database drivers. The reason for Chat mode: Prisma needs a persistent connection (incompatible with Cloud Run scale-to-zero + worker HTTPS proxy); native-bound SQLite drivers and non-SQLite dialects don\'t round-trip through the worker.')
      lines.push('  - Hard-coding TMDB_URL or TMDB_TOKEN in any committed file. They live ONLY in .env.')
      lines.push('')
      lines.push('### Next steps')
      lines.push('  1. read_skill("publish-backend") for the full db.ts template + sqlite-proxy fetcher.')
      lines.push('  2. Write server/schema.ts with the tables you need (start small — add columns later).')
      lines.push('  3. Write server/db.ts using the dev/prod switch from the skill.')
      lines.push('  4. Generate the first migration with drizzle-kit.')

      return lines.join('\n')
    },
  })

  // === provision_files ===
  // Reserves the per-app file storage credentials on the platform and
  // writes TM_FILES_URL / TM_FILES_TOKEN / TM_FILES_PUBLIC_BASE to .env.
  //
  // Storage layout on R2: `{slug}/_files/{userKey}`. Reads are served
  // directly by the slug's subdomain (`https://{slug}.toquemedia.net/_files/key`)
  // — no Worker hop, no CORS for same-origin frontend fetches. Writes
  // go through this Worker (PUT /v1/apps/{appId}/files/{key}) with
  // TM_FILES_TOKEN as a bearer.
  //
  // Same idempotency semantics as provision_database / provision_auth:
  // second call reuses the existing record.
  ctx.tools.set('provision_files', {
    definition: {
      name: 'provision_files',
      description:
        "Set up TM Code File Storage for the current project. Tries R2 via the platform Worker first; on failure, falls back to LOCAL filesystem (.toquemedia/uploads/). Writes TM_FILES_URL + TM_FILES_TOKEN + TM_FILES_PUBLIC_BASE to .env (R2 mode) or TM_FILES_MODE=local (local mode). Use ONCE when the project needs to handle user uploads (avatars, images, attachments, documents). **Required before writing any upload route** — the alternative (base64 in DB) is forbidden: it bloats the DB, kills query latency, and has no CDN. After provisioning, generate the files helper from read_skill(\"publish-backend\") §9.5 at `backend/src/files.ts` (or `server/src/files.ts`). In your files.ts, check `process.env.TM_FILES_MODE === 'local'` to switch between R2 (Worker PUT) and local (fs.writeFile). Idempotent: second call returns the same credentials.",
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    execute: async () => {
      const project = useProjectStore.getState().currentProject
      if (!project) {
        return 'No project is open. Open a project before provisioning file storage.'
      }

      const firebaseAuth = FirebaseAuthService.getInstance()
      const idToken = await firebaseAuth.getIdToken()
      if (!idToken) {
        return 'Not authenticated to TM Code. Sign in first, then retry.'
      }

      // Compute a candidate slug from the project name. The worker accepts
      // this as a fallback when no deploy record exists yet — most agent
      // calls to provision_files happen pre-publish (during scaffolding of
      // upload routes), so the deploy record doesn't exist. After the first
      // publish, the worker will pin to the actual deploy slug regardless
      // of what we send here.
      //
      // Algorithm must match the backend's slugify() + the frontend's
      // slugSuggest() exactly — /[^a-z0-9-]+/g strips non-alnum chars
      // (does NOT replace with hyphens). Mismatched algorithms produce
      // different slugs for the same project name, leading to two
      // subdomain entries being registered.
      const candidateSlug = project.name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9-]+/g, '')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63) || project.id.slice(0, 32)

      const workerUrl = resolveWorkerUrl()
      let provisionRes: Awaited<ReturnType<typeof tauriFetch>>
      try {
        provisionRes = await tauriFetch(
          `${workerUrl}/v1/apps/${encodeURIComponent(project.id)}/files/provision`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ slug: candidateSlug }),
          },
        )
      } catch (err) {
        // Network error — fall back to local filesystem storage
        const uploadsDir = `${project.path}/.toquemedia/uploads`
        try { await invoke('create_directories_all', { path: uploadsDir }) } catch {}
        try {
          await invoke('write_env_vars', {
            projectPath: project.path,
            vars: [{ key: 'TM_FILES_MODE', value: 'local' }],
          })
        } catch {}
        return (
          `PROVISION_FILES: platform unreachable — falling back to LOCAL file storage.\n\n` +
          `Network error: ${err instanceof Error ? err.message : String(err)}\n\n` +
          `Local fallback active:\n` +
          `  - Uploads go to .toquemedia/uploads/ (gitignored)\n` +
          `  - TM_FILES_MODE=local written to .env\n` +
          `  - Serve via static middleware: app.use('/uploads', express.static('.toquemedia/uploads'))\n` +
          `  - writeFile() saves to disk, readFile() reads from disk, deleteFile() removes from disk\n\n` +
          `In your files.ts, check process.env.TM_FILES_MODE === 'local' to switch between R2 (Worker PUT) and local (fs.writeFile). ` +
          `The public URL for local files is /uploads/{key} on the dev server.\n\n` +
          `base64-in-DB is still FORBIDDEN.`
        )
      }

      if (!provisionRes.ok) {
        const body = await provisionRes.text().catch(() => '')
        // Non-OK response — fall back to local filesystem storage
        const uploadsDir = `${project.path}/.toquemedia/uploads`
        try { await invoke('create_directories_all', { path: uploadsDir }) } catch {}
        try {
          await invoke('write_env_vars', {
            projectPath: project.path,
            vars: [{ key: 'TM_FILES_MODE', value: 'local' }],
          })
        } catch {}
        return (
          `PROVISION_FILES: platform returned HTTP ${provisionRes.status} — falling back to LOCAL file storage.\n\n` +
          `Error body: ${body.slice(0, 300)}\n\n` +
          `Local fallback active:\n` +
          `  - Uploads go to .toquemedia/uploads/ (gitignored)\n` +
          `  - TM_FILES_MODE=local written to .env\n` +
          `  - Serve via static middleware: app.use('/uploads', express.static('.toquemedia/uploads'))\n` +
          `  - writeFile() saves to disk, readFile() reads from disk, deleteFile() removes from disk\n\n` +
          `In your files.ts, check process.env.TM_FILES_MODE === 'local' to switch between R2 (Worker PUT) and local (fs.writeFile). ` +
          `The public URL for local files is /uploads/{key} on the dev server.\n\n` +
          `base64-in-DB is still FORBIDDEN.`
        )
      }

      const data = (await provisionRes.json()) as {
        url?: string
        token?: string
        publicBase?: string
        reused?: boolean
      }

      if (!data.url || !data.token || !data.publicBase) {
        return `Provisioning returned incomplete data: ${JSON.stringify(data)}`
      }

      const envVars: Array<{ key: string; value: string }> = [
        { key: 'TM_FILES_URL', value: data.url },
        { key: 'TM_FILES_TOKEN', value: data.token },
        { key: 'TM_FILES_PUBLIC_BASE', value: data.publicBase },
      ]

      try {
        await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
      } catch (err) {
        return `File storage provisioned but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
      }

      const reusedSuffix = data.reused ? ' (reused existing)' : ''
      const lines: string[] = []
      lines.push(`File storage ready${reusedSuffix}.`)
      lines.push(`.env written: TM_FILES_URL, TM_FILES_TOKEN, TM_FILES_PUBLIC_BASE.`)
      lines.push('')
      lines.push('## Storage contract (do not improvise)')
      lines.push('')
      lines.push('### Write path (server/files.ts)')
      lines.push('  - PUT to `${TM_FILES_URL}/{key}` with `Authorization: Bearer ${TM_FILES_TOKEN}` and the file body as the request body.')
      lines.push('  - Response: `{ publicUrl, key, size, contentType }`. Store the `publicUrl` in your DB row — never the bytes themselves.')
      lines.push('  - Max 10 MB per upload. The Worker enforces this — your route should also pre-validate to reject early.')
      lines.push('  - Keys allow nested paths (`posts/cover.jpg`). Forbidden: `..`, leading `/`, control chars.')
      lines.push('')
      lines.push('### Read path')
      lines.push('  - Public URL is `${TM_FILES_PUBLIC_BASE}/_files/{key}` — same origin as your frontend, no CORS. Cloudflare serves it directly from R2, zero Worker invocations on the read path.')
      lines.push('  - Embed in `<img src=...>` / `<video src=...>` etc. with normal browser caching.')
      lines.push('')
      lines.push('### Delete path')
      lines.push('  - DELETE on `${TM_FILES_URL}/{key}` with the same bearer. Returns `{ deleted: key }`.')
      lines.push('  - When the app itself is deleted, the platform cleans up the whole prefix — you do not need to delete files manually unless the user explicitly removes them.')
      lines.push('')
      lines.push('### Forbidden')
      lines.push('  - base64-in-DB columns (`avatarData`, `imageBase64`, `dataUrl: "data:image/..."`). Use the publicUrl returned by the upload instead.')
      lines.push('  - Storing TM_FILES_TOKEN anywhere in committed code. It lives ONLY in .env.')
      lines.push('  - Direct R2 SDK calls (`@aws-sdk/client-s3`, `wrangler-r2`) — the Worker is the only authorized write path.')
      lines.push('')
      lines.push('### Next steps')
      lines.push('  1. read_skill("publish-backend") §9.5 for the full files.ts helper.')
      lines.push('  2. Write `backend/src/files.ts` exporting `uploadFile(key, body, contentType)` and `deleteFile(key)`.')
      lines.push('  3. Wire upload routes that accept multipart/form-data, validate type+size, then call uploadFile.')
      lines.push('  4. Store the returned publicUrl in the relevant DB row.')

      return lines.join('\n')
    },
  })

  // === provision_deploy ===
  // Mirrors provision_auth for the backend deploy side. With the Firestore
  // data model there's no per-app database to provision — the app's data
  // lives at apps/{APP_ID}/... under the shared (default) Firestore in
  // dev-studio-projects, isolated by Security Rules. The tool:
  // 1. Calls /v1/projects/deploy/init to reserve <slug>.toquemedia.net +
  //    create the projectDeployments record (subscription/quota gated).
  // 2. Writes APP_ID (= project.id) to .env so the server code can build
  //    its paths under apps/${APP_ID}/...
  // 3. Returns a summary the agent reads before swapping the DB layer to
  //    the Firebase Admin SDK (read_skill('publish-backend')
  //    for the cost-conscious access patterns).
  //
  // Reserved for the Publish flow. The agent should NOT call this during
  // normal scaffolding — the system prompt's Publishing section explains
  // the rationale (paid commitment, hostname reservation, quota slot).
  // Idempotent: if APP_ID is already in .env, returns no-op.
  ctx.tools.set('provision_deploy', {
    definition: {
      name: 'provision_deploy',
      description:
        "Reserve a public hostname for this project and register it in the platform's publish quota. Writes APP_ID to .env (the per-app data namespace). RESERVED for the Publish flow — do NOT call this from scaffolding turns. The publish-ready code shape (firebase-admin data layer, Dockerfile, cache pattern) must be in place BEFORE this is called; use APP_ID with a local-dev fallback in your db.ts so the backend runs without this tool ever firing. Idempotent: a second call when APP_ID already exists returns a no-op. May return DEPLOY_QUOTA (free=0/vibe=1/pro=2/max=5 active publishes) — surface verbatim and stop.",
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    execute: async () => {
      const project = useProjectStore.getState().currentProject
      if (!project) {
        return 'No project is open. Open a project before provisioning the deploy.'
      }

      // Defense-in-depth: the system prompt instructs the agent to NOT
      // call provision_deploy during normal scaffolding turns — the
      // Publish flow owns this. The agent may still call it (e.g., if a
      // legacy prompt or a user instruction asks for it). Make it
      // idempotent so a stray call from scaffolding doesn't double-
      // reserve, double-consume quota, or trigger surprise public-host
      // commitments. If APP_ID is already in .env, treat as no-op.
      try {
        const existing = await invoke<string>('read_file', {
          path: `${project.path}/.env`,
        })
        if (typeof existing === 'string' && /^\s*APP_ID\s*=/m.test(existing)) {
          return (
            `provision_deploy already applied to "${project.name}" — APP_ID is in .env. ` +
            `Skipping re-provision. If you intended to rotate the slug or move to a different ` +
            `plan, the developer must do that from Settings → Deploys (not from the agent).`
          )
        }
      } catch {
        // .env doesn't exist yet — fine, continue with the normal flow.
      }

      const firebaseAuth = FirebaseAuthService.getInstance()
      const idToken = await firebaseAuth.getIdToken()
      if (!idToken) {
        return 'Not authenticated to TM Code. Sign in first, then retry.'
      }
      const workerUrl = resolveDeployUrl()

      // /init reserves the slug + creates the projectDeployments record
      // (quota gated, idempotent on re-run). No DB provisioning — the
      // platform database is a shared default with per-app path scoping;
      // nothing to physically create up front.
      //
      // Pass customSubdomain so the backend's resolveAndReserveSubdomain
      // takes the explicit-slug path (step 1) instead of deriving from
      // projectName (step 3). Without this, the backend always creates
      // a slug from projectName — if the user later changes the slug via
      // the PublishModal, both the suggested and custom slugs end up
      // registered. The slug algorithm here MUST match slugSuggest() +
      // the backend's slugify() exactly.
      const deploySlug = project.name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9-]+/g, '')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63) || project.id.slice(0, 32)
      let initRes: Awaited<ReturnType<typeof tauriFetch>>
      try {
        initRes = await tauriFetch(`${workerUrl}/v1/projects/deploy/init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
            ...DEV_DEPLOY_HEADER,
          },
          body: JSON.stringify({
            projectId: project.id,
            projectName: project.name,
            customSubdomain: deploySlug,
          }),
        })
      } catch (err) {
        return `Failed to reach deploy/init: ${err instanceof Error ? err.message : String(err)}`
      }
      if (!initRes.ok) {
        const body = await initRes.text().catch(() => '')
        // Surface the structured DEPLOY_QUOTA / subscription codes so the
        // agent can offer the right next step (upgrade vs. remove existing).
        return `Deploy init failed (HTTP ${initRes.status}): ${body.slice(0, 300)}`
      }
      const initData = (await initRes.json()) as { slug?: string }
      const slug = initData.slug
      if (!slug) {
        return 'Init returned without a slug — unexpected response shape.'
      }

      // Write APP_ID to .env. APP_ID is the project.id (same identifier
      // used in projectDeployments + the path namespace under
      // apps/{APP_ID}/... in Firestore). GCP_PROJECT_ID is already there
      // from provision_auth; no other vars to add.
      const envVars: Array<{ key: string; value: string }> = [
        { key: 'APP_ID', value: project.id },
      ]
      try {
        await invoke('write_env_vars', { projectPath: project.path, vars: envVars })
      } catch (err) {
        return `Reserved slug "${slug}" but failed to write .env: ${err instanceof Error ? err.message : String(err)}`
      }

      // Invalidate scaffolding cache so detection picks up the new vars.
      try {
        const { invalidateScaffoldingCache } = await import('../../scaffoldingDetector')
        invalidateScaffoldingCache(project.path)
      } catch { /* non-critical */ }

      const lines: string[] = []
      lines.push(`Deploy infrastructure ready for "${project.name}".`)
      lines.push(`  - Public hostname: ${slug}.toquemedia.net (locked to this project)`)
      lines.push(`  - Data namespace: apps/${project.id}/... (platform-managed)`)
      lines.push(`  - .env written: APP_ID`)
      lines.push('')
      lines.push('## What to do next')
      lines.push('')
      lines.push(`1. Confirm the publish-ready code shape is already in place (it should be — that's the platform default): firebase-admin data layer with the local-dev APP_ID fallback, Dockerfile + cloudbuild.yaml at root, read-once + in-memory cache pattern applied. If anything is missing, read_skill("${PUBLISHING_SKILL_NAME}") and fill the gaps.`)
      lines.push('2. The developer can now click Publish — the IDE handles build + bring-online from there.')
      lines.push('')
      lines.push('CREDENTIALS COMPLETE — do NOT call request_credentials for database / cloud / service-account keys. The platform runtime authenticates natively (no JSON keys, no API tokens). The only env vars the backend reads at runtime are APP_ID + the auth keys provision_auth already wrote.')

      return lines.join('\n')
    },
  })
}
