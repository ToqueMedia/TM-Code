/**
 * Defense-in-depth: SKILL prompt rules that the model violates often
 * enough that we enforce them mechanically at write/edit time.
 *
 * Each constant pairs a closed taxonomy (the canonical list of patterns
 * to reject) with a fixed reason string used to build the rejection
 * message in `toolExecutor`. The taxonomy lives here — not inlined into
 * the executor — so the SKILL build-time verifier (and any future lint
 * hook) can reference the same source of truth as the runtime guard.
 *
 * Adding a new check:
 *   1. Append the constant + reason here.
 *   2. Add the matching `checkForbidden*` method on `ToolExecutor` and
 *      wire it into the write_file / create_file / edit_file paths.
 *   3. Mention the rule in the relevant SKILL.md so the model's
 *      first attempt avoids the harness rejection.
 */

/** Client-side firebase/auth method names that are silently broken in the
 *  IDE preview's child webview (popup-style flows) or that bypass the
 *  auth-proxy contract (direct credential exchange). The harness rejects
 *  any TS/JS file that imports `firebase/auth` AND mentions one of these. */
export const FORBIDDEN_FIREBASE_AUTH_NAMES = /\b(signInWithPopup|signInWithRedirect|signInWithCustomToken|signInWithEmailAndPassword|createUserWithEmailAndPassword|GoogleAuthProvider|GithubAuthProvider|FacebookAuthProvider|TwitterAuthProvider|OAuthProvider|EmailAuthProvider|signOut)\b/

/** Packages that scaffold the wrong data-layer shape for the platform's
 *  Publish flow. TM Code Database is libSQL accessed via Drizzle ORM +
 *  drizzle-orm/sqlite-proxy in production (so `drizzle-orm`, `drizzle-kit`
 *  and `@libsql/client` are ALLOWED — they're the platform's data-layer
 *  stack). The packages below are still forbidden because they either:
 *
 *  - Bring an incompatible query engine (Prisma uses a Rust binary that
 *    needs a persistent connection — incompatible with Cloud Run
 *    scale-to-zero + worker-mediated HTTPS proxy).
 *  - Bring a non-SQLite dialect that can't run against the platform DB
 *    (mysql2 / pg).
 *  - Bring a native-bound SQLite driver that doesn't talk HTTP
 *    (better-sqlite3 / sqlite3 — these only work as a process-local
 *    driver, so they break the prod proxy path entirely).
 *
 *  Adding any of these to a package.json `dependencies` / `devDependencies`
 *  block on a project that didn't already have them is rejected at write
 *  time. */
export const FORBIDDEN_DATA_LAYER_DEPS = [
  '@prisma/client',
  'prisma',
  'better-sqlite3',
  'sqlite3',
  'mysql2',
  'pg',
] as const

/** Identity Toolkit `/v2/accounts:*` paths. The auth API endpoints
 *  (`signInWithIdp`, `signInWithPassword`, `signUp`, `lookup`) are all
 *  `/v1`. The `/v2` namespace exists on this host but covers passkeys /
 *  MFA enrollment — calling it for sign-in returns HTML errors that
 *  generic `catch` blocks then map to 401, sending the developer chasing
 *  auth issues for hours. Documented at length in the auth-proxy SKILL. */
export const FORBIDDEN_ITK_V2_PATH = /https?:\/\/identitytoolkit\.googleapis\.com\/v2\/accounts(?::|\/)[\w-]+/

/** Service-account-key imports — the platform runtime authenticates
 *  natively via the metadata server, so any `serviceAccountKey.json`
 *  reference indicates the model is shipping credentials in-repo (or
 *  pretending to). Both forms are rejected. */
export const FORBIDDEN_SERVICE_ACCOUNT_KEY = /(?:from\s+['"][^'"]*serviceAccountKey\.json['"]|require\(\s*['"][^'"]*serviceAccountKey\.json['"]\s*\))/

/** Frontend build script names that the publish-backend Dockerfile must
 *  NEVER call. These produce the FRONTEND bundle — which goes to R2 via
 *  the upload phase, not into the backend container. Catching this in
 *  the harness stops the recurring "vite: not found" Cloud Build
 *  failure documented in publish-backend SKILL §8 anti-patterns. */
export const FRONTEND_BUILD_SCRIPT_PATTERNS = [
  /\bvite\s+build\b/,
  /\bnext\s+build\b/,
  /\bnuxt\s+(?:build|generate)\b/,
  /\bastro\s+build\b/,
  /\bng\s+build\b/,
  /\bsvelte-kit\s+build\b/,
  /\bremix\s+build\b/,
] as const

/** Dockerfile patterns that pair badly with Cloud Run's container
 *  contract. Each entry is `(pattern, kind)` so the rejection message
 *  can pick a specific anti-pattern from publish-backend SKILL §8 to
 *  cite. The harness fires these only on writes to a `Dockerfile`.
 *
 *  `cloudRunPort` matches hard-coded ports common in Express templates
 *  (`app.listen(3000)`) — those fail Cloud Run's startup probe because
 *  Cloud Run injects PORT=8080 and never reaches port 3000. */
export const DOCKERFILE_ANTI_PATTERNS = [
  // CMD that tries to run TS directly via plain node (fails with SyntaxError)
  { pattern: /CMD\s*\[\s*"node"\s*(?:,\s*"[^"]*")*\s*,\s*"[^"]*\.ts"\s*\]/, kind: 'nodeRunsTs' as const },
  // --env-file pointing at .env (which is in .dockerignore)
  { pattern: /--env-file[\s=][^\s"\]]*\.env\b/, kind: 'envFileInCmd' as const },
] as const

/** Path matcher — only fires the Dockerfile checker on actual Dockerfiles
 *  (catches `Dockerfile`, `Dockerfile.prod`, `server.Dockerfile`, plus the
 *  lowercase `dockerfile` variant some Linux projects use). The `/i` flag
 *  is intentional: case-insensitive on POSIX filesystems where both forms
 *  appear in the wild and a stale `dockerfile` would otherwise bypass the
 *  harness silently. */
export const DOCKERFILE_PATH = /(?:^|\/)(?:[A-Za-z][\w.-]*\.)?Dockerfile(?:\.[\w-]+)?$/i

/** Reason strings — single source of truth for the rejection messages.
 *  Composed by `toolExecutor` with the offending `path` so the agent's
 *  next turn sees a precise diagnosis + recovery path. */
export const REJECTION_REASONS = {
  firebaseAuthImport: (path: string, name: string) =>
    `Blocked: ${path} uses '${name}' from firebase/auth — forbidden in this project. ` +
    `Popups are silently blocked in the IDE preview's webview, and direct Firebase JS auth calls bypass the auth-proxy. ` +
    `Use the GIS button pattern instead: read_skill('google-signin') Step 2 (the useGoogleSignIn hook is a drop-in). ` +
    `Email/password and signOut go through POST /api/auth/proxy/{signup,signin,refresh}; see read_skill('auth-proxy'). ` +
    `Only 'onAuthStateChanged' is allowed as an import from firebase/auth.`,

  dataLayerDeps: (path: string, newlyAdded: readonly string[]) =>
    `Write rejected — ${path} adds [${newlyAdded.join(', ')}] to dependencies. ` +
    `The publish-ready data layer uses \`firebase-admin\` (Publishing section, system prompt). ` +
    `Recovery: drop those entries from dependencies, install \`firebase-admin\` instead, ` +
    `and copy the db.ts pattern from read_skill('publish-backend'). ` +
    `The local-dev fallback APP_ID makes \`npm run dev\` work immediately, no emulator setup needed.`,

  itkV2Path: (path: string) =>
    `Blocked: ${path} references identitytoolkit.googleapis.com/v2 — every auth-API call you need ` +
    `(signInWithIdp, signInWithPassword, signUp, lookup) is on /v1. The /v2 namespace covers passkeys / ` +
    `MFA only and returns HTML errors for sign-in flows that generic catch blocks then map to 401, ` +
    `sending the developer chasing auth issues for hours. Recovery: replace /v2 with /v1 inline ` +
    `(don't abstract via \`API_VERSION\`) — read_skill('auth-proxy') has the exact constant.`,

  serviceAccountKey: (path: string) =>
    `Blocked: ${path} imports a serviceAccountKey.json. The platform runtime authenticates natively ` +
    `via the metadata server — there is no service-account JSON to ship and no such file exists in ` +
    `the project. Recovery: drop the import + the credential argument; call ` +
    `\`initializeApp({ projectId: process.env.TM_PROJECT_ID })\` with no second argument. ` +
    `read_skill('publish-backend') section "Never embed serviceAccountKey.json" has the canonical snippet.`,

  dockerfileFrontendBuild: (path: string, scriptName: string, scriptValue: string) =>
    `Blocked: ${path} contains \`RUN npm run ${scriptName}\`, but the project's "${scriptName}" script ` +
    `is "${scriptValue}" — that's a FRONTEND build. The frontend goes to R2 via the upload phase; the ` +
    `backend container only needs the server code. Calling it here also fails Cloud Build because ` +
    `\`npm ci --omit=dev\` (the typical preceding step) strips vite/next/etc. ` +
    `Recovery: read_skill('publish-backend') §8 — pick Template A.1 (multi-stage compile-to-JS, recommended) ` +
    `or A.2 (run-with-tsx) depending on whether you want a build step. Never call the project's frontend build script from the Dockerfile.`,

  dockerfileNodeRunsTs: (path: string) =>
    `Blocked: ${path} CMD invokes \`node\` on a .ts file. Node cannot execute TypeScript directly. ` +
    `Recovery options: (1) compile to JS first with \`npx tsc --project server/tsconfig.json --outDir server/dist\` ` +
    `in a build stage and \`CMD ["node", "server/dist/index.js"]\` (Template A.1 in publish-backend §8); ` +
    `or (2) promote \`tsx\` from devDependencies to dependencies and use \`CMD ["npx", "tsx", "server/index.ts"]\` ` +
    `(Template A.2). Either works for Cloud Run; A.1 has smaller cold start.`,

  dockerfileEnvFileInCmd: (path: string) =>
    `Blocked: ${path} CMD uses --env-file pointing at .env. The .env file is excluded by .dockerignore ` +
    `(per publish-backend §9), so --env-file=.env reads a missing file at runtime and either crashes ` +
    `or silently sets nothing. Cloud Run env vars are injected at deploy time by the platform's ` +
    `readBackendEnvVars helper — the runtime sees \`process.env.GIP_*\` / \`process.env.APP_ID\` directly. ` +
    `Recovery: drop \`--env-file=.env\` from the CMD; read env vars via process.env in the server code as usual.`,
} as const
