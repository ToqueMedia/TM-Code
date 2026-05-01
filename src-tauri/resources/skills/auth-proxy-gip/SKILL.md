---
name: auth-proxy-gip
description: Implement user authentication (signup, signin, Google OAuth, session) for the user's app. The TM Code platform provisions a per-project GIP tenant and writes the credentials to .env via provision_auth. You implement the proxy + frontend in whatever backend stack the project uses (Express, Hono, Fastify, NestJS, FastAPI, Go, etc.). Do NOT install firebase-admin. Do NOT use Firebase JS SDK auth methods on the client — only onAuthStateChanged is allowed.
license: MIT
metadata:
  author: tm-code
  version: 3.0
  language: en
---

# Auth Proxy (GIP) — Stack-Agnostic Recipe

This skill describes the **protocol** for adding GIP authentication to a project. Pick whatever backend stack already exists (or the one the developer asked for) — Express, Hono, Fastify, NestJS, FastAPI, Go, etc. The pattern is identical; only the syntax changes.

`provision_auth` has already:
- Created a per-project GIP tenant on the platform.
- Written the platform-managed credentials into `.env`.

Your job is to implement the auth-proxy endpoints + the frontend client.

## What's in `.env` after `provision_auth`

Frontend (Vite-style):
- `VITE_FIREBASE_API_KEY` — public Firebase Web API key (used by both the client SDK and the server-side Identity Toolkit calls).
- `VITE_FIREBASE_AUTH_DOMAIN` — `<project>.firebaseapp.com`
- `VITE_FIREBASE_PROJECT_ID` — GCP project id where the tenant lives
- `VITE_GIP_TENANT_ID` — the per-project tenant id
- `VITE_GOOGLE_CLIENT_ID` — present only when Google sign-in is configured

Backend mirrors:
- `GIP_FIREBASE_API_KEY` — same value as VITE_FIREBASE_API_KEY (server reads this name)
- `GIP_TENANT_ID` — same value as VITE_GIP_TENANT_ID
- `GCP_PROJECT_ID` — same value as VITE_FIREBASE_PROJECT_ID

**Do NOT modify `.env` yourself.** It is system-managed.

## Hard rules

1. **NEVER** install `firebase-admin`. There is no Admin SDK in this stack — the auth-proxy talks to the Identity Toolkit REST API directly with `VITE_FIREBASE_API_KEY` (a public key).
2. **NEVER** call `request_credentials` after `provision_auth` for anything Firebase / GIP / GCP-related. The user does not have (and will never have) `GOOGLE_APPLICATION_CREDENTIALS`, `serviceAccountKey.json`, or `GIP_SERVICE_ACCOUNT_*` — those live only on the TM Code platform worker.
3. **NEVER** import `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `GoogleAuthProvider`, or `signOut` from `firebase/auth` on the client. Only `onAuthStateChanged` is allowed AS AN IMPORT. Note that the listener WILL NOT FIRE in this proxy flow because no client-side method ever updates `auth.currentUser` — for session restoration use the bootstrap pattern below, not `onAuthStateChanged`. All auth flows go through your backend proxy.
4. **NEVER** modify `.env`. It is platform-managed.
5. **ALWAYS** call `/api/auth/sync` after a successful proxy signup or signin to upsert the user row in your DB.
6. **ALWAYS** use the project's auth-helper (e.g. `authFetch`) for protected API calls — never raw `fetch` with manual headers spread around the codebase.
7. **ALWAYS** call your store's `init()` (or equivalent bootstrap) from the app's entry file (`main.ts(x)` / `app.ts`) BEFORE the first render. Without it, a refresh after login lands the user on an infinite loading state — the auth store has no signal to rehydrate from. See the "Session bootstrap" section below.

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

## Identity Toolkit REST endpoints you'll call

Base URL: `https://identitytoolkit.googleapis.com/v1`
Secure-token base: `https://securetoken.googleapis.com/v1`

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

Identity Toolkit returns errors as `{ error: { message: <CODE> } }`. Map them to HTTP statuses your client can act on:

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

For routes that need to know who the user is (`/api/auth/sync`, any protected endpoint), verify the `Authorization: Bearer <token>` token.

**Production** — verify against Google's secure-token JWKS:

```
JWKS URL:  https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
Issuer:    https://securetoken.google.com/<GCP_PROJECT_ID>
Audience:  <GCP_PROJECT_ID>
Tenant check: payload.firebase?.tenant must equal <GIP_TENANT_ID>
```

Use `jose` (Node, Bun, Deno, edge runtimes), `jsonwebtoken` + `jwks-rsa`, `python-jose`, `golang-jwt`, or any peer.

**Development** (e.g. when emulators are involved) — `decodeJwt` without signature verification is acceptable for the tenant-id check.

After verification, attach the decoded payload to the request (`req.user = { uid, email, name, picture }` or your framework's equivalent).

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

### Frontend — `src/lib/firebase.ts` (Vite + Firebase Web SDK)

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
2. Backend hits Identity Toolkit → returns `{ idToken, refreshToken, localId, email }`.
3. Frontend stores tokens via `setAuthToken`.
4. Frontend calls `/api/auth/sync` (auth-required) to upsert the user row.
5. Frontend calls `useAuthStore.getState().setUser(syncedUserRow)` to hydrate
   the store immediately (no listener will tell us, see note above).
6. Subsequent API calls use `authFetch` — auto-refresh on 401 via `/api/auth/proxy/refresh`.

**Logout:**
1. Frontend calls `setAuthToken(null, null)` and `useAuthStore.getState().setUser(null)`.
2. No backend call needed — the JWT just expires; refresh tokens stay revocable
   server-side if you maintain a denylist (out of scope for V1).
