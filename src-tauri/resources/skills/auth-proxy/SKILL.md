---
name: auth-proxy
description: Implement user authentication (signup, signin, Google sign-in, session) for the user's app. The TM Code platform provisions a per-project auth tenant and writes the credentials to .env via provision_auth. You implement the proxy + frontend in whatever backend stack the project uses (Express, Hono, Fastify, NestJS, FastAPI, Go, etc.). The auth-proxy itself is a thin REST forwarder — keep it free of admin-SDK installs. On the client, only onAuthStateChanged is imported from the auth library.
license: MIT
metadata:
  author: tm-code
  version: 3.0
  language: en
---

# Auth Proxy — Stack-Agnostic Recipe

This skill describes the **protocol** for adding authentication to a project via the TM Code Authentication API. Pick whatever backend stack already exists (or the one the developer asked for) — Express, Hono, Fastify, NestJS, FastAPI, Go, etc. The pattern is identical; only the syntax changes.

`provision_auth` has already:
- Reserved the per-project auth tenant on the platform.
- Written the platform-managed credentials into `.env` (both neutral TM_* names and legacy mirrors).

Your job is to implement the auth-proxy endpoints + the frontend client.

## CRITICAL: Read these before writing any code

These six rules are violated repeatedly across model generations. Each violation produces a specific user-visible bug. **MUST** comply with every one.

### CRITICAL — Wire the Vite dev proxy

When frontend and backend run on different ports, the frontend's `vite.config.ts` **MUST** include:
```ts
server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } }
```
Adjust the target port to match your backend. **Without this, every `/api/*` request hits port 5173 and returns 404.** CORS headers on the backend are NOT a substitute — the proxy is what makes the request leave port 5173 at all. Same logic applies to Next.js (use `rewrites()` in `next.config.js`), Nuxt, SvelteKit. Verify by `curl http://localhost:5173/api/auth/me` — must return JSON, not 404 HTML.

### CRITICAL — The auth-proxy is a thin REST forwarder

The auth-proxy itself does not install `firebase-admin`. It forwards signup/signin requests to the platform's auth API using the public client key in .env (`VITE_TM_AUTH_KEY` for the frontend, `TM_AUTH_KEY` for the server). The data layer (where user records live) is a separate concern and uses `firebase-admin` per the Publishing section of your system prompt — that's not a contradiction, the two surfaces have different needs.

### CRITICAL — Skip `request_credentials` for platform-managed credentials

`provision_auth` has already written everything the project needs. Admin SDK keys, service-account files, and infrastructure tokens live only on the platform side; surfacing the credentials form for them shows the developer a dialog they cannot satisfy.

### CRITICAL — Never import client-side Firebase auth methods

These imports from `firebase/auth` are forbidden on the client: `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `GoogleAuthProvider`, `signOut`. Only `onAuthStateChanged` is allowed AS AN IMPORT (note: it will not fire in this proxy flow — use the bootstrap pattern below instead). All auth flows go through your backend proxy.

### CRITICAL — Always navigate after `setUser`

`setUser` populates the auth store; nothing else redirects automatically. Every auth flow (signup, signin, google) **MUST** call its router's `navigate(...)` after `setUser`. Email/password flows do this in the form's `onSubmit` handler. Google sign-in does this via the hook's `onSuccess` option: `useGoogleSignIn(ref, { onSuccess: () => navigate('/success') })`. AuthGuard only redirects FROM protected routes TO login — never the inverse.

### CRITICAL — Always call `setAuthToken` after token exchange

After every successful proxy call (signup, signin, google), **MUST** call `setAuthToken(idToken, refreshToken)` BEFORE the next `authFetch`. Skipping this means the next `/api/auth/sync` call has no Authorization header and returns 401.

### CRITICAL — Always call `/api/auth/sync` after a successful auth call

For all three flows (signup, signin, google), after `setAuthToken` **MUST** `await authFetch('/api/auth/sync', { method: 'POST', body: JSON.stringify({...profileFields}) })` to upsert the user into the local DB. Then `setUser(syncedUser)`.

### CRITICAL — Prisma + SQLite: use ABSOLUTE `DATABASE_URL` at runtime

Prisma's runtime client (`@prisma/client` v6+) resolves relative SQLite URLs **relative to the generated client in `node_modules/.prisma/client/`**, NOT relative to `process.cwd()` or to `schema.prisma`. The Prisma CLI (`db push`, `migrate`) resolves relative to the schema. **These disagree.** Symptom: `db push` creates the DB at `<root>/prisma/dev.db`, but the server crashes on the first query with `Error code 14: Unable to open the database file` because it's looking at `<root>/node_modules/.prisma/client/prisma/dev.db` — which doesn't exist.

Officially open in Prisma since 2020: [prisma/prisma#2040](https://github.com/prisma/prisma/issues/2040), [#9649](https://github.com/prisma/prisma/issues/9649), [#27085](https://github.com/prisma/prisma/issues/27085), [studio#1273](https://github.com/prisma/studio/issues/1273), [discussion #28842](https://github.com/prisma/prisma/discussions/28842). The fix is unchanged across Prisma 5/6/7: **force an absolute path before instantiating PrismaClient.**

**DO NOT** rely on `DATABASE_URL=file:./prisma/dev.db` in scripts or `.env` — it appears to work (CLI migrates) but fails at runtime. **DO** override `process.env.DATABASE_URL` to an absolute `file://` URL in your Prisma singleton module BEFORE `new PrismaClient()`:

```ts
// server/lib/prisma.ts (or wherever the singleton lives)
import { PrismaClient } from '@prisma/client'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function ensureAbsoluteSqliteUrl(): void {
  const raw = process.env.DATABASE_URL
  if (!raw || !raw.startsWith('file:')) return
  const body = raw.slice('file:'.length).replace(/^\/+/, '/')
  if (body.startsWith('/')) return // already absolute
  const relative = raw.slice('file:'.length).replace(/^\.?\/+/, '')
  const here = dirname(fileURLToPath(import.meta.url))
  let cur = here
  while (cur !== dirname(cur)) {
    if (existsSync(resolve(cur, 'prisma/schema.prisma'))) {
      process.env.DATABASE_URL = `file:${resolve(cur, relative)}`
      return
    }
    cur = dirname(cur)
  }
}
ensureAbsoluteSqliteUrl()

export const prisma = new PrismaClient()
```

Verify by curling `/api/auth/sync` with a valid JWT — must return 200 with the upserted user row, not 500 with `PrismaClientInitializationError` / `Error code 14`. Also map P2021 (table missing) and P1003 (file missing) in your `/sync` and `/me` catch blocks to a 503 with a recovery hint, so the next failure is diagnosable in one glance instead of a stack trace dump.

### CRITICAL — Persist the session on app load

Login is one half of auth; **session persistence is the other half** and the model forgets it more than half the time. Without it, a hard refresh after login lands the user on an infinite spinner — the auth store starts empty, and nothing rehydrates it. Implement the bootstrap pattern below alongside the login handlers, in the same scaffold pass — not as a follow-up.

Mechanical contract (all three steps required):

1. **Persist the token** at the moment of issue. After every successful `/api/auth/proxy/{signup,signin,google}` response, call `setAuthToken(idToken, refreshToken)` *before* returning. The storage layer is `sessionStorage` by default (cookies for SSR projects). See "Frontend — auth helper" for the canonical implementation.
2. **Rehydrate on every load**. The auth store **MUST** expose an `init()` that reads `getAuthToken()`, calls `GET /api/auth/me`, and sets `user` from the response (or `null` when the token is missing/expired and refresh fails). See "Session bootstrap" for the canonical Zustand example.
3. **Call `init()` BEFORE first render** from the entry file (`main.ts(x)` / `app.ts`) — wrap `createRoot(...).render(<App/>)` in `useAuthStore.getState().init().finally(...)`. Typical resolve time is ≤300ms (one `GET /api/auth/me` round-trip on warm connection). Calling `init()` from a component `useEffect` is too late: the first paint already happened with `user: null` ~50ms in, and AuthGuard has already redirected to `/login` before `/me` returns.

Why this matters more than it looks: in this proxy flow `onAuthStateChanged` never fires (no client-side method ever updates `auth.currentUser`), so the listener-based pattern Firebase tutorials teach is silently a no-op here. The bootstrap `init()` + `/api/auth/me` call IS the persistence mechanism — there is no fallback.

Verify after wiring:

```bash
# 1. Sign in via the UI. Confirm sessionStorage has _auth_token in DevTools.
# 2. Hard-refresh the page (Cmd+R).
# 3. Expected: lands on the post-auth route in ≤1s (cold start ≤2s).
#    Network tab shows GET /api/auth/me → 200 with the user row.
# 4. Failure modes:
#    - Lands on /login → init() not called before render OR token not persisted.
#    - Infinite spinner → init() called but never resolves loading=false.
#    - 401 from /me → JWKS URL wrong (see "JWT verification middleware").
```

### CRITICAL — Port 5173 must hold for auth-enabled projects (IDE handles it)

The platform's auth tenant has redirect URIs locked to `http://localhost:5173`. If Vite falls back to 5174 (because 5173 is occupied), Google sign-in returns 400 `redirect_uri_mismatch` and the auth flow breaks silently — the auth API call surfaces as "API key not valid" or a generic 400 with no port hint.

**The IDE's `start_dev_server` already handles this.** `devServerManager` detects `EADDRINUSE` on dev-server start, calls the `kill_port` Tauri command to free the port, and retries once. You do NOT need to run any shell command to clear port 5173.

**DO NOT** run `lsof -ti:5173 | xargs kill -9` yourself. That command kills WHATEVER process owns the port — including the IDE's OWN dev server when the developer is running `npm run tauri dev`, which crashes the IDE mid-conversation.

After `start_dev_server`, verify the dev-server logs show `:5173` (not `:5174`). If the auto-recovery didn't get it, ASK the developer what else is holding the port — don't escalate to manual kills.

## What's in `.env` after `provision_auth`

Frontend (Vite-style, preferred names):
- `VITE_TM_AUTH_KEY` — public client key (used by both the client SDK and the server-side auth-API calls).
- `VITE_TM_AUTH_DOMAIN` — auth redirect domain
- `VITE_TM_PROJECT_ID` — project namespace identifier (public side)
- `VITE_TM_TENANT_ID` — the per-project tenant id
- `VITE_TM_GOOGLE_CLIENT_ID` — present only when Google sign-in is configured

Backend mirrors:
- `TM_AUTH_KEY` — same value as VITE_TM_AUTH_KEY (server reads this name)
- `TM_TENANT_ID` — same value as VITE_TM_TENANT_ID
- `TM_PROJECT_ID` — same value as VITE_TM_PROJECT_ID

Legacy names also in .env for backward compat with already-scaffolded projects: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_GIP_TENANT_ID`, `VITE_GOOGLE_CLIENT_ID`, `GIP_FIREBASE_API_KEY`, `GIP_TENANT_ID`, `GCP_PROJECT_ID`. New code reads the `TM_*` names; existing projects keep working with the old names.

**Do not modify `.env` directly.** It is platform-managed.

## Loading `.env` at runtime

`provision_auth` writes credentials to `.env`. Most runtimes do not load `.env` automatically — wire it in, or `process.env.TM_AUTH_KEY` is `undefined` at runtime and every auth-API call returns 400 `API_KEY_INVALID`.

Pick whatever fits the runtime. Examples:

- **Node 20.6+** via tsx or node directly: pass `--env-file=.env` in the dev/start script (e.g. `tsx watch --env-file=.env server/index.ts`).
- **Older Node / general fallback**: install `dotenv` and `import 'dotenv/config'` at the top of the entry file before any `process.env.X` access.
- **NestJS**: `ConfigModule.forRoot({ isGlobal: true })`.
- **Bun**: loads `.env` automatically — no setup needed.
- **Deno**: pass `--env-file=.env` to `deno run`, or use `Deno.env`.
- **Python (FastAPI etc.)**: `python-dotenv` with `load_dotenv()` at startup, or `pydantic-settings`.
- **Go**: `github.com/joho/godotenv` with `godotenv.Load()` at startup.

Verify after wiring with a fail-fast guard near startup:

```ts
if (!process.env.TM_AUTH_KEY) {
  throw new Error('TM_AUTH_KEY missing — is .env being loaded?')
}
```

Without this guard, missing env vars surface only as cryptic 400s from the auth API ("API key not valid"), wasting debugging time.

### Frontend (Vite) — `VITE_*` vars: classify the layout BEFORE setting `envDir`

`provision_auth` writes `.env` to the **project root**. Vite reads `.env` from the directory containing its own `vite.config.*`. The `envDir` override is a **conditional** fix — applying it to a flat layout BREAKS the project (Vite looks for `.env` in a directory that doesn't have one, and `import.meta.env.VITE_GOOGLE_CLIENT_ID` becomes `undefined`, which then fails the silent guard `if (!clientId) return`).

**STEP 1 — Classify the layout by answering ONE question**: where does `vite.config.ts` live relative to `.env`?

 - **Same directory as `.env`** (vite.config.ts and .env are siblings) → **FLAT layout**
 - **One level deeper than `.env`** (vite.config.ts is in `client/` or `frontend/` while `.env` is at the root) → **MONOREPO layout**

**STEP 2 — Apply the correct rule:**

#### FLAT layout — DO NOT set `envDir`

```ts
// vite.config.ts at project root, .env at project root
import { defineConfig } from 'vite'
export default defineConfig({
  // No envDir — Vite finds .env next to its config by default.
  plugins: [react()],
  // ...
})
```

Setting `envDir: path.resolve(__dirname, '..')` here points Vite at the PARENT of the project — there's no `.env` there, all `VITE_*` become `undefined`, and the GIS button silently fails to render. Symptom is identical to having no `.env` at all.

#### MONOREPO layout — DO set `envDir` to the project root

```ts
// vite.config.ts inside <root>/client/, .env at <root>/.env
import { defineConfig } from 'vite'
import path from 'path'
export default defineConfig({
  envDir: path.resolve(__dirname, '..'),   // step UP into the monorepo root
  plugins: [react()],
  // ...
})
```

Alternative: place a frontend-only `client/.env` containing the `VITE_*` keys (manual sync — `envDir` is preferred).

> **Canonical directory names**: when splitting into sub-packages, the directory **MUST** be one of `client`, `server`, `frontend`, `backend`, `web`, `api`. Custom names (`app`, `ui`, `service`) are invisible to the IDE's project-kind detector and the wrong preview surface opens.

**STEP 3 — Verify**: open `npm run dev`'s browser console and run:
```js
console.log(import.meta.env.VITE_GOOGLE_CLIENT_ID)
// "<long.apps.googleusercontent.com>" → ready
// undefined → envDir misconfigured for the layout (over-set on flat, missing on monorepo)
```

## Ports and CORS — let the framework defaults stand

Pick the framework's default port (Vite=5173, Next=3000, Express/your-choice). The TM Code IDE detects the dev-server URL from log output and classifies it by HTTP content-type — there is no "reserved port" you must use. Hardcoding 7773/7777 is no longer required.

Three coordination concerns when frontend and backend run on different ports:

**1. Frontend host (CRITICAL)**: when using a parallel runner (concurrently, npm-run-all, turbo, pnpm -r, workspaces) the frontend script MUST include `--host 0.0.0.0`:
```json
"dev:client": "vite --host 0.0.0.0"   // ✅ binds to IPv4 + IPv6
"dev:client": "vite"                   // ❌ Node 18+ binds to IPv6-only,
                                       //    IDE preview shows "Connection refused"
```
This is because Node 18+ resolves `localhost` to `::1` only, but the IDE preview connects via `127.0.0.1`. Without `--host`, the dev server is up but unreachable from the iframe. The IDE auto-injects `--host` for top-level commands but cannot reach inside wrapper sub-scripts. The same applies to `next dev`, `nuxt dev`, `astro dev`, `svelte-kit dev`, and `ng serve`.

**2. Backend port**: bind to whatever the runtime gives you, defaulting to a sensible value:
```ts
app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', ...)
```

**3. CORS**: the frontend port is unknown at write-time (the dev server may pick a different one if the default is busy). Three options, in order of preference:

- **Permissive in dev** (simplest, only safe for local dev):
  ```ts
  app.use(cors({ origin: true, credentials: true }))
  ```
- **Env-driven** (recommended if your stack supports it):
  ```ts
  const allowed = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean)
  app.use(cors({ origin: allowed.length ? allowed : true, credentials: true }))
  ```
  Then the dev script or `.env` declares `CORS_ORIGIN=http://localhost:5173`.
- **Hardcoded list** (fragile — only when you control all the ports): include every realistic dev origin. Avoid; the natural-port world makes this brittle.

The auth helper (`authFetch`) on the frontend uses `/api/...` paths. Wire the Vite dev proxy to forward `/api` to the backend so the browser sees same-origin requests and CORS doesn't even apply for the proxy:
```ts
// vite.config.ts
server: {
  proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } }
}
```
With the proxy in place, CORS only matters for direct cross-origin calls (e.g. third-party APIs) — the auth flow stays same-origin.

## Hard rules

1. The auth-proxy itself does not install `firebase-admin`. It talks to the platform's auth API directly via REST with the public client key (`VITE_TM_AUTH_KEY` / `TM_AUTH_KEY`). The data layer (where user records persist) is a separate concern and uses `firebase-admin` per the Publishing section of your system prompt — not a contradiction; two surfaces with different needs.
2. After `provision_auth`, skip `request_credentials` for any platform-managed credential. Admin SDK keys, service-account files, and infrastructure tokens live only on the platform side; surfacing the credentials form for them shows a dialog the developer cannot satisfy.
3. **NEVER** import `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `GoogleAuthProvider`, or `signOut` from `firebase/auth` on the client. Only `onAuthStateChanged` is allowed AS AN IMPORT. Note that the listener WILL NOT FIRE in this proxy flow because no client-side method ever updates `auth.currentUser` — for session restoration use the bootstrap pattern below, not `onAuthStateChanged`. All auth flows go through your backend proxy.
4. **NEVER** modify `.env`. It is platform-managed.
5. **ALWAYS** call `/api/auth/sync` after a successful proxy signup or signin to upsert the user row in your DB.
5b. **ALWAYS** navigate to the post-auth route after `setUser` — for ALL three flows (signup, signin, google). `setUser` only updates the store; nothing redirects automatically. Email/password handlers do this in the form's `onSubmit`; the Google flow does it via `useGoogleSignIn(ref, { onSuccess: () => navigate('/success') })`.
6. **ALWAYS** use the project's auth-helper (e.g. `authFetch`) for protected API calls — never raw `fetch` with manual headers spread around the codebase.
7. **ALWAYS** call your store's `init()` (or equivalent bootstrap) from the app's entry file (`main.ts(x)` / `app.ts`) BEFORE the first render. Without it, a refresh after login lands the user on an infinite loading state — the auth store has no signal to rehydrate from. See the "Session bootstrap" section below.
8. **ALWAYS** wire the Vite dev proxy when frontend and backend run on different ports. Without it, `POST /api/auth/proxy/google` from the browser hits the Vite dev server (`localhost:5173`) and returns **404** — the request never reaches the backend. The fix is one line in `vite.config.ts`:
   ```ts
   server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } }
   ```
   Adjust the target port to match your backend. Adding CORS on the backend is NOT a substitute — the proxy must exist for `/api/...` paths to leave port 5173 at all. This applies equally to Next.js (use `rewrites()` in `next.config.js`), Nuxt, SvelteKit, etc. Verify by curling `http://localhost:5173/api/auth/me` — it must return JSON, not a 404 HTML page.
9. **ALWAYS** call `setAuthToken(idToken, refreshToken)` after a successful Google sign-in token exchange — same as signup/signin. Skipping it means subsequent `authFetch` calls have no Authorization header and `/api/auth/sync` returns 401.

## Endpoint surface to implement

Mount these under `/api` (or whatever prefix the project already uses; `/api` is the convention this skill assumes throughout):

```
POST /api/auth/proxy/signup    body: { email, password, name? }       → { idToken, refreshToken, email, localId, expiresIn }
POST /api/auth/proxy/signin    body: { email, password }              → { idToken, refreshToken, email, localId, expiresIn }
POST /api/auth/proxy/google    body: { idToken: <google_id_token> }   → { idToken, refreshToken, email, localId, displayName, photoUrl, expiresIn }
POST /api/auth/proxy/refresh   body: { refreshToken }                 → { idToken, refreshToken, expiresIn }
POST /api/auth/sync            (auth-required)  body: profile fields  → upserted user row
GET  /api/auth/me              (auth-required)  no body                → current user row from DB
```

The `/me` endpoint is REQUIRED for session bootstrap on app load — see the
"Session bootstrap" section below for why `onAuthStateChanged` alone cannot
restore the session in this proxy-only flow.

### Apply rate limiting

Add per-IP rate limits on the credential-handling endpoints (`/signup`, `/signin`,
`/google`, `/refresh`) before shipping to production. Express: `express-rate-limit`
(15 req / 5 min). Hono / Fastify / NestJS: equivalent middleware. Without this,
the endpoints are open targets for credential stuffing and brute-force attacks.

## the auth API REST endpoints you'll call

Base URL: `https://identitytoolkit.googleapis.com/v1`
Secure-token base: `https://securetoken.googleapis.com/v1`

### CRITICAL — USE `/v1`, NEVER `/v2`

`accounts:signInWithIdp`, `accounts:signInWithPassword`, `accounts:signUp` are **all `/v1`**. The `/v2` namespace exists on this host but covers DIFFERENT APIs (passkeys, MFA enrollment, etc.) — it does NOT include any of the endpoints you'll call here.

**Why this rule has a CRITICAL block of its own**: when a generated proxy hardcodes `/v2/accounts:signInWithIdp`, Google returns 400 or 404 with an HTML error page (not a JSON the auth API error). A standard `catch (err) { res.status(401).json(...) }` then maps it to 401, and the developer chases authentication issues for hours while the actual cause is a wrong path segment. This is a recurring failure mode (BugHunterKimi May 2026 session, others) because the model's training data has BOTH `/v1` and `/v2` Google APIs and silently picks `/v2` under generation pressure.

**Defense**: when you write the constant, write it inline rather than abstracting:
```ts
// ✅ explicit, hard to drift
const ITK_BASE = 'https://identitytoolkit.googleapis.com/v1'

// ❌ tempting but treacherous — model writes /v2 here ~30% of the time
const ITK_BASE = `https://identitytoolkit.googleapis.com/${API_VERSION}`
```

**Verification**: after writing the proxy, curl the endpoint with a bogus token:
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'Content-Type: application/json' \
  -d '{"idToken":"bogus"}' \
  http://localhost:3001/api/auth/proxy/google
```
- Expected: **401** with JSON body `{ "error": ... }`
- If you get **502** with HTML body: the upstream URL is wrong (`/v2` is the most-common typo — see the "USE `/v1`" CRITICAL above for the failure rate). Fix the constant.

### CRITICAL — `signInWithIdp` requires `postBody` + `requestUri`, NEVER `idToken` at the top level

The `accounts:signInWithIdp` endpoint takes the Google ID token wrapped in a **form-encoded `postBody` string**, alongside a **`requestUri`** field. It does NOT accept `idToken` as a top-level JSON key. If you pass `{ idToken, providerId, returnSecureToken }` directly, Identity Toolkit responds **400 / `MISSING_REQUEST_URI`** because there is no `requestUri` field — and your proxy maps that to 401 at the client.

**Correct (sole accepted shape)**:
```ts
const body = {
  postBody: `id_token=${idToken}&providerId=google.com`,
  requestUri: "http://localhost",
  returnSecureToken: true,
  returnIdpCredential: true,
  tenantId: process.env.GIP_TENANT_ID,
}
// then: POST {ITK}/accounts:signInWithIdp?key={API_KEY}  body: JSON.stringify(body)
```

**Wrong (rejected with `MISSING_REQUEST_URI`)**:
```ts
const body = { idToken, providerId: 'google.com', returnSecureToken: true }
// no postBody, no requestUri → Identity Toolkit refuses.
```

**Why this rule has a CRITICAL block of its own**: every other auth endpoint in this skill (`signUp`, `signInWithPassword`) accepts top-level JSON keys like `email` / `password` / `idToken`. The model generalises from those — under generation pressure it writes the same shape for `signInWithIdp` and silently drops the `postBody`/`requestUri` indirection that Identity Toolkit's OAuth-flow endpoint specifically requires. Observed failure: BugHunter project May 2026, frontend posted `{ idToken }` to `/api/auth/proxy/google`; the proxy forwarded `{ idToken, providerId, returnSecureToken }` to Identity Toolkit; Google returned `MISSING_REQUEST_URI`; client console showed `Google sign-in failed: MISSING_REQUEST_URI`.

**Defense**: when you write the proxy route for Google sign-in, write the full request body literal with `postBody`, `requestUri`, `returnSecureToken`, `returnIdpCredential`, and `tenantId`. Do NOT pass `idToken` directly into `authProxy(...)` — wrap it in `postBody` first. Test BEFORE handing the feature to the user.

**Verification** — bogus-token curl (same pattern as the `/v1` and `providerId` rules):
```bash
curl -s -o /tmp/r.json -w "%{http_code}\n" -X POST http://localhost:5173/api/auth/proxy/google \
  -H "Content-Type: application/json" \
  -d '{"idToken":"bogus"}' && cat /tmp/r.json
```
- Expected: **401** with JSON `{ "error": "INVALID_IDP_RESPONSE" }` or similar (Identity Toolkit reached the endpoint and rejected the fake token — proxy shape is correct).
- If you get **401** with body containing `MISSING_REQUEST_URI`: you forgot `requestUri` and `postBody`. Rewrite the proxy body using the "Correct" shape above.
- If you get **502** with HTML: wrong upstream URL (see `/v1` rule).

### CRITICAL — `postBody` uses `providerId` (camelCase), NEVER `provider_id` (snake_case)

Inside the `signInWithIdp` request body, the `postBody` field is a form-encoded string whose `providerId` key **MUST be camelCase**. Identity Toolkit's `/v1` API rejects snake_case `provider_id` with `INVALID_CREDENTIAL_OR_PROVIDER_ID` — and the error message echoes the wrong key back verbatim, which is the only way you'll know what went wrong.

**Correct**:
```ts
postBody: `id_token=${idToken}&providerId=google.com`
//                              ^^^^^^^^^^ camelCase
```

**Wrong (rejected by Identity Toolkit)**:
```ts
postBody: `provider_id=google.com&id_token=${idToken}`
//        ^^^^^^^^^^^ snake_case → INVALID_CREDENTIAL_OR_PROVIDER_ID
```

**Why this rule has a CRITICAL block of its own**: the legacy Google Identity Toolkit REST API (deprecated years ago) used `provider_id` (snake_case). The current Identity Toolkit at `identitytoolkit.googleapis.com/v1` uses `providerId` (camelCase). The model's training data contains BOTH forms because the legacy API was widely documented and copy-pasted across blog posts, gists, and SDK examples that pre-date the migration. Under generation pressure the model collapses to the snake_case version it has seen more often in raw training data, even though THIS skill (the canonical reference) shows camelCase. Observed failure: BugHunter session 2026-05-16, Google response was `INVALID_CREDENTIAL_OR_PROVIDER_ID : Invalid IdP response/credential: http://localhost?provider_id=google.com&id_token=...` — the upstream literally echoed the wrong key.

**Defense**: when you write the `postBody` line, write the FULL string with `providerId` inline. Do NOT abstract the key as a constant or read it from anywhere — every layer of indirection is another opportunity for the model to switch to snake_case.

**Verification**: same bogus-token curl as the `/v1` rule above:
- Expected: **401** with JSON body `{ "error": ... }` (Identity Toolkit rejected the bogus credential)
- If you get **401** with body containing `INVALID_CREDENTIAL_OR_PROVIDER_ID` AND the response message includes the literal string `provider_id=`: you wrote snake_case. Find the `postBody` line, change to `providerId=`.

The same camelCase rule applies to OTHER Identity Toolkit body fields you may add later: `idToken` (not `id_token` at the JSON body level — but DOES stay `id_token` inside `postBody` because postBody is form-encoded, not JSON), `displayName` (not `display_name`), `returnSecureToken` (not `return_secure_token`), `tenantId` (not `tenant_id`). The pattern: **JSON body fields are camelCase; the form-encoded `postBody` string preserves `id_token` (snake_case is part of OAuth standard for that one specific key) but everything else inside it is camelCase — including `providerId`.**

```
POST {ITK}/accounts:signUp?key={API_KEY}
  body: { email, password, displayName, tenantId, returnSecureToken: true }

POST {ITK}/accounts:signInWithPassword?key={API_KEY}
  body: { email, password, tenantId, returnSecureToken: true }

POST {ITK}/accounts:signInWithIdp?key={API_KEY}
  body: {
    postBody: "id_token=<google_id_token>&providerId=google.com",
    requestUri: "http://localhost",
    returnSecureToken: true,
    returnIdpCredential: true,
    tenantId
  }

POST {SECURE}/token?key={API_KEY}        (form-urlencoded)
  body: grant_type=refresh_token&refresh_token={refreshToken}
```

The **`tenantId` field is required** on signup/signin/google calls. Read it from `process.env.GIP_TENANT_ID` (Node) or the equivalent in your runtime.

## Error mapping (recommended status codes)

the auth API returns errors as `{ error: { message: <CODE> } }`. Map them to HTTP statuses your client can act on:

```
EMAIL_EXISTS                        → 409 "Email already registered"
WEAK_PASSWORD                       → 400 "Password must be at least 6 characters"
INVALID_EMAIL                       → 400 "Invalid email address"
OPERATION_NOT_ALLOWED               → 403 "Account creation is disabled"
EMAIL_NOT_FOUND                     → 401 "Invalid email or password"
INVALID_PASSWORD                    → 401 "Invalid email or password"
INVALID_LOGIN_CREDENTIALS           → 401 "Invalid email or password"
USER_DISABLED                       → 403 "Account disabled"
TOO_MANY_ATTEMPTS_TRY_LATER         → 429 "Too many attempts. Try again later."
```

Collapse the two "wrong email" / "wrong password" codes into one generic message to avoid user enumeration.

## JWT verification middleware

For routes that need to know who the user is (`/api/auth/sync`, `/api/auth/me`, any protected endpoint), verify the `Authorization: Bearer <token>` token.

**CRITICAL — JWKS URL is non-negotiable.** The platform auth API's ID tokens (the ones returned by `signInWithIdp`, `signInWithPassword`, `signUp`) are signed by `securetoken@system.gserviceaccount.com` — not by Google's general OAuth/OIDC JWKS.

```
JWKS URL:  https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
Issuer:    https://securetoken.google.com/<GCP_PROJECT_ID>
Audience:  <GCP_PROJECT_ID>
Algorithm: RS256
Tenant check: payload.firebase?.tenant must equal <GIP_TENANT_ID>
```

### Anti-patterns — these URLs DO NOT work and will cause every protected endpoint to return 401:

```
❌ https://www.googleapis.com/robot/v1/metadata/googleapis.com/robot   (service-account discovery, not JWKS)
❌ https://www.googleapis.com/oauth2/v3/certs                          (GIS/OIDC tokens only — wrong audience)
❌ https://www.googleapis.com/oauth2/v1/certs                          (legacy, PEM not JWKS)
❌ https://www.gstatic.com/firebasejs/...                              (client SDK, not server cert source)
```

If `/me` or `/sync` returns 401 *with a fresh token that signInWithIdp just issued*, the JWKS URL is the first suspect.

### Reference snippet — `jose` (Node / Bun / Deno / edge)

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose'

const JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
))

export async function verifyFirebaseToken(token: string) {
  const projectId = process.env.GCP_PROJECT_ID!
  const { payload } = await jwtVerify(token, JWKS, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  })
  const expectedTenant = process.env.GIP_TENANT_ID
  if (expectedTenant && payload.firebase && (payload.firebase as { tenant?: string }).tenant !== expectedTenant) {
    throw new Error('Tenant mismatch')
  }
  return payload
}
```

For other languages: `jsonwebtoken` + `jwks-rsa` (Node legacy), `python-jose`, `golang-jwt` — same URL, same issuer, same audience, same algorithm.

**Development** (emulators) — `decodeJwt` without signature verification is acceptable for the tenant-id check, but never ship that to production.

After verification, attach the decoded payload to the request (`req.userId = payload.sub`, etc.).

## Reference implementation snippets

These are illustrative — adapt to the project's stack.

### Signup handler (TypeScript, framework-agnostic)

```typescript
async function signup(req: { email: string; password: string; name?: string }) {
  const apiKey = process.env.GIP_FIREBASE_API_KEY!
  const tenantId = process.env.GIP_TENANT_ID!
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: req.email,
        password: req.password,
        displayName: req.name || req.email.split('@')[0],
        tenantId,
        returnSecureToken: true,
      }),
    },
  )
  const data = await res.json()
  if (!res.ok) throw mapError(data?.error?.message || 'Signup failed')
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    email: data.email,
    localId: data.localId,
    expiresIn: data.expiresIn,
  }
}
```

Wrap the same fetch logic for `signInWithPassword`, `signInWithIdp` (Google), and the secure-token refresh.

### Sync handler (TypeScript)

After signup or signin, the client posts to `/api/auth/sync` with the JWT in `Authorization: Bearer <idToken>`. Verify the token, then upsert into your `users` table:

```typescript
const decoded = await verifyFirebaseToken(req.headers.authorization)
const db = getDb()
await db.users.upsert({
  uid: decoded.sub,
  email: decoded.email,
  name: decoded.name,
  avatarUrl: decoded.picture,
  // app-specific fields from req.body that aren't in the JWT:
  ...req.body.extras,
})
return db.users.findUnique({ where: { uid: decoded.sub } })
```

The `users` schema needs at minimum `uid (PK)`, `email (unique)`, `name`, `avatarUrl`, `role`, `createdAt`, `updatedAt`. Custom columns (e.g. `phone`, `gender`) MUST be nullable or have defaults — sync runs from JWT data on first sign-in, before the app collects those fields.

### Frontend — `src/lib/firebase.ts` (minimal init for the auth library)

```typescript
import { initializeApp } from 'firebase/app'
import { getAuth, inMemoryPersistence, setPersistence } from 'firebase/auth'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
})

export const auth = getAuth(app)
auth.tenantId = import.meta.env.VITE_GIP_TENANT_ID

// Inside an iframe (e.g. Studio preview), avoid IndexedDB partitioning.
if (window !== window.parent) setPersistence(auth, inMemoryPersistence)
```

Export as `auth`, not `firebaseAuth`. Only import `onAuthStateChanged` from `firebase/auth` — nothing else.

> **Important — `onAuthStateChanged` will NOT fire in this proxy flow.**
> Because no client-side method (`signInWithPopup`, `signInWithEmailAndPassword`,
> `signInWithCustomToken`, etc.) is ever called, `auth.currentUser` stays
> `null` forever and the listener never triggers. The import is allowed
> because some apps still use it for tab-sync or token-expiry events, but
> for **session restoration on app load** you MUST use the bootstrap
> pattern below — not the listener.

### Session bootstrap (REQUIRED — call from main.ts/app.ts before first render)

The proxy flow stores the JWT in `sessionStorage` (or cookies). On a hard
refresh, the store starts empty — you have to actively rehydrate from the
stored token. Without this step the user lands on an infinite spinner after
any reload.

```typescript
// src/store/authStore.ts (Zustand example — adapt to your state lib)
interface AuthState {
  user: UserRow | null
  loading: boolean
  init: () => Promise<void>
  setUser: (u: UserRow | null) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  setUser: (u) => set({ user: u }),
  init: async () => {
    const token = getAuthToken()
    if (!token) {
      set({ user: null, loading: false })
      return
    }
    try {
      const res = await authFetch('/api/auth/me')
      if (res.ok) {
        set({ user: await res.json(), loading: false })
      } else {
        // Token invalid/expired and refresh failed — clear and show login.
        setAuthToken(null, null)
        set({ user: null, loading: false })
      }
    } catch {
      set({ user: null, loading: false })
    }
  },
}))
```

```typescript
// src/main.tsx — call init() BEFORE first render
import { useAuthStore } from './store/authStore'

useAuthStore.getState().init().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />)
})
```

After login (signup/signin/google), call `useAuthStore.getState().setUser(syncedUserRow)`
explicitly — the store has no other way to learn about the new user.

**Then navigate to the post-auth route** (`/success`, `/dashboard`, whatever your app uses). Setting the user does NOT redirect — `AuthGuard` patterns redirect *to* `/login` when the user is missing, not *from* `/login` when the user appears. Every auth handler — email/password form `onSubmit`, Google sign-in callback, signup form — must call its router's `navigate(...)` after `setUser`. The Google flow is the easy one to forget because the navigation has to be wired through `useGoogleSignIn`'s `onSuccess` option (the hook itself doesn't know which route to go to).

### Frontend — auth helper (`src/lib/authClient.ts`)

```typescript
const TOKEN_KEY = '_auth_token'
const REFRESH_KEY = '_refresh_token'

export function setAuthToken(token: string | null, refreshToken?: string | null) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token)
  else sessionStorage.removeItem(TOKEN_KEY)
  if (refreshToken !== undefined) {
    if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken)
    else sessionStorage.removeItem(REFRESH_KEY)
  }
}
export function getAuthToken() { return sessionStorage.getItem(TOKEN_KEY) }

let refreshing: Promise<boolean> | null = null
async function tryRefresh() {
  const rt = sessionStorage.getItem(REFRESH_KEY)
  if (!rt) return false
  const res = await fetch('/api/auth/proxy/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  })
  if (!res.ok) return false
  const data = await res.json()
  setAuthToken(data.idToken, data.refreshToken)
  return true
}

export async function authFetch(url: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers)
  const token = getAuthToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('Content-Type') && opts.body) headers.set('Content-Type', 'application/json')
  let res = await fetch(url, { ...opts, headers })
  if (res.status === 401 && sessionStorage.getItem(REFRESH_KEY)) {
    if (!refreshing) refreshing = tryRefresh()
    const ok = await refreshing
    refreshing = null
    if (ok) {
      const retry = new Headers(opts.headers)
      retry.set('Authorization', `Bearer ${getAuthToken()}`)
      if (!retry.has('Content-Type') && opts.body) retry.set('Content-Type', 'application/json')
      res = await fetch(url, { ...opts, headers: retry })
    }
  }
  return res
}
```

Adapt the storage layer (sessionStorage vs cookies) to the project's needs — e.g. SSR projects may need an HTTP-only cookie flow with the same endpoint surface.

### Auth flow sequence (recap)

**App load (every refresh):**
0. Entry file calls `useAuthStore.getState().init()` BEFORE first render.
   `init` reads `getAuthToken()`, calls `GET /api/auth/me`, sets `user` from
   the response (or `null` if no token / token invalid).

**Login:**
1. User submits the signup/signin form → frontend calls `/api/auth/proxy/{signup,signin}`.
2. Backend hits the auth API → returns `{ idToken, refreshToken, localId, email }`.
3. Frontend stores tokens via `setAuthToken`.
4. Frontend calls `/api/auth/sync` (auth-required) to upsert the user row.
5. Frontend calls `useAuthStore.getState().setUser(syncedUserRow)` to hydrate
   the store immediately (no listener will tell us, see note above).
6. Subsequent API calls use `authFetch` — auto-refresh on 401 via `/api/auth/proxy/refresh`.

**Logout:**
1. Frontend calls `setAuthToken(null, null)` and `useAuthStore.getState().setUser(null)`.
2. No backend call needed — the JWT just expires; refresh tokens stay revocable
   server-side if you maintain a denylist (out of scope for V1).

---

## FINAL REMINDER — the three rules that cost the most when broken

The full rule list is above. These three are repeated here at the end because **a single violation of any of them burns the entire feature**, and the failures look like generic auth issues that send the developer chasing the wrong cause for hours. Re-read these before submitting any auth-related change:

1. **`/v1`, never `/v2`** on `identitytoolkit.googleapis.com/accounts:*`. The `/v2` namespace covers passkeys / MFA only. A `/v2` typo returns HTML errors that generic `catch` blocks map to 401 — the developer sees "auth not working" with zero hint that the URL is wrong. The harness rejects writes containing `/v2/accounts:*` to fail-fast at edit time, but you're expected to write `/v1` first try, not lean on the harness. **Symptom of failure**: every protected endpoint 401s with a fresh token that just signed in successfully.

2. **`providerId`, never `provider_id`** inside the `signInWithIdp` postBody. CamelCase. The legacy Identity Toolkit (deprecated) used snake_case and is over-represented in training data; the current `/v1` API rejects snake_case with `INVALID_CREDENTIAL_OR_PROVIDER_ID`. Write the postBody line inline with `providerId=google.com` — no abstractions, no constants. **Symptom of failure**: Google's response echoes back `Invalid IdP response/credential: http://localhost?provider_id=google.com&id_token=...` — the literal `provider_id=` in the error message confirms the snake_case slip.

3. **Persist the session AND call `init()` BEFORE first render.** Login alone doesn't keep the user logged in across refresh — it's two halves of one feature. Call `setAuthToken` after every proxy response, and wrap `createRoot(...).render(<App/>)` in `useAuthStore.getState().init().finally(...)`. Calling `init()` from a `useEffect` is too late: the first paint already redirected to `/login` ~50ms before `/me` returns. **Symptom of failure**: user signs in, sees the dashboard for a second, refreshes, lands on the login screen as if they never authenticated.
