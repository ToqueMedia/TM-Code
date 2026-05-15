---
name: publish-backend
description: Prepare a fullstack project (Vite/React/Vue/Svelte frontend + Express/Fastify/NestJS backend) for TM Code's Publish flow. The platform manages hosting + database; your job on the project side is to use the platform admin SDK on the server with the read-once + in-memory cache pattern as the default, scope every collection under the per-app namespace, and ship the Dockerfile + build config. Skip any service-account credential file — the platform runtime authenticates natively. Skip onSnapshot for static or infrequently-changing data. Keep the in-memory cache pattern in place — the platform DB bills per read.
license: MIT
metadata:
  author: tm-code
  version: 1.0
  language: en
---

# Publish-backend prep — recipe

This skill describes the **protocol** for making a fullstack project deployable via TM Code's Publish flow with the platform DB as the user's data layer. The platform:

- Hosts the **frontend** on the platform edge — automatic.
- Hosts the **backend** as a managed container, named after the project, on the platform runtime.
- Provides **the platform database** access via the runtime's native auth — **no API tokens, no service account JSON files, no credentials of any kind in .env**. The database is reached via `firebase-admin` initialised with the project id only; the platform service account carries the necessary IAM role.
- Proxies `/api/*` from `<slug>.toquemedia.net` to the backend service URL.

`provision_deploy` has already (when called by the dispatching flow):
- Reserved the slug on toquemedia.net.
- Reserved an `appId` (= `projectId`) for the user's data namespace.
- Written `TM_PROJECT_ID`, `APP_ID`, plus the legacy `GCP_PROJECT_ID`/`GIP_*` mirrors into `.env`.

Your job: swap the existing DB layer to the platform DB, design the data with the cost-conscious patterns below, write the container build, and wire env reads.

## CRITICAL: Read these before writing any code

### CRITICAL — Read-once + in-memory cache is the DEFAULT pattern

The platform DB charges per document read. The standard React/Vue/Node pattern of "useQuery + refetch on focus" produces 100x more reads than necessary. The required pattern for every collection that isn't genuinely real-time:

1. **App boot**: one bulk read of each critical collection → store in memory (Zustand / Pinia / module-level Map / Redux).
2. **Reads**: every subsequent component-level access reads from the in-memory store, NOT from the platform DB.
3. **Writes**: write to the platform DB AND update the in-memory store in the same transaction (write-through). No read-before-write — the cache already has the current state.
4. **Cache invalidation**: rare. Mutations the user made come from the local cache. Mutations from OTHER users on collaborative data should use onSnapshot scoped to that one collection.

Bill impact: typical app with 1k DAU and the default React-Query "refetch on focus" pattern bills ~50-100 reads/user/session. Same app with read-once + cache bills 5-10 reads/user/session. 10x reduction.

### CRITICAL — Use onSnapshot ONLY for genuinely real-time data

`onSnapshot` is appropriate for:
- Chat messages, collaborative documents, presence indicators
- Live counters where the user is watching the number tick
- Notification feeds where new items appear without a refresh

`onSnapshot` is WRONG for:
- User profile data (load once on app boot, cache forever — invalidate on profile-edit)
- Settings / preferences (one read, write-through on change)
- Catalogues / product lists (load once + refresh button OR scheduled stale-while-revalidate)
- Historical data (orders, audit logs, anything append-only the user reviews)
- Counts / aggregates (use `count()` aggregation queries, not listeners)

Wrong-pattern penalty: an `onSnapshot` on a 100-doc collection bills 100 reads on subscribe + N reads per change ever after, even if the user never looks at the result.

### CRITICAL — Never embed serviceAccountKey.json or use credential files

The platform runtime runs as a platform service account. The platform admin SDK auto-detects this when initialised with **no credential argument** — it picks up the platform service account's identity via the runtime metadata server. This is more secure than shipping a JSON key (no secret to rotate, no leak risk) and zero config.

```ts
// CORRECT — runtime credentials auto-detected
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

if (getApps().length === 0) {
  initializeApp({
    projectId: process.env.TM_PROJECT_ID,
  })
}
export const db = getFirestore()
```

```ts
// WRONG — never do this
import serviceAccount from './serviceAccountKey.json' // ← no such file exists
initializeApp({ credential: cert(serviceAccount as any) })
```

### CRITICAL — Multi-tenant data layout is `apps/{appId}/...`

Every user-app shares the platform DB `(default)` database (the named-database model would bill us per-app from read #1). Isolation is enforced by **path scope + Security Rules**, not by physical separation. The platform service account can read/write anywhere but the application code MUST scope every operation under `apps/{APP_ID}/...`.

```ts
// Production: APP_ID is injected by the platform. Local dev: fall back to a
// stable per-project namespace so `npm run dev` works without ceremony.
const APP_ID =
  process.env.APP_ID ||
  `local-dev-${(process.env.npm_package_name || 'app').replace(/[^a-z0-9]/gi, '-').toLowerCase()}`

const appRoot = db.collection('apps').doc(APP_ID)
const users = appRoot.collection('users')
const posts = appRoot.collection('posts')
```

A query against `db.collection('users')` (without the `apps/{APP_ID}` prefix) is a tenant-leak bug — it would return users from EVERY user-app. Never write a query that doesn't start at the `appRoot`.

### CRITICAL — Never ship a query that requires a composite index

The platform DB rejects compound queries without a composite index — but it does so **at runtime, not build time**, and the runtime error link is to the platform's internal Firestore console, which the user CANNOT access (it's a shared internal service). If your code reaches production with an un-indexed query, the user receives an opaque "FAILED_PRECONDITION: the query requires an index" error with no way to act on it.

**Index management is platform-side, not per-project.** Indexes for the shared database live in `toquemedia-studio-api/firestore/indexes.json` and deploy from there. The user's project does NOT get to add a `firestore.indexes.json` and `firebase deploy` it — that deploy would either be ignored or overwrite another tenant's manifest.

**Therefore, design queries that do NOT require a composite index. Period.** Composite indexes are needed when ANY of these is true:
- Two or more `.where()` clauses on different fields with at least one inequality operator
- One `.where(field, '==')` plus `.orderBy(differentField)`
- Any `.where(... 'array-contains' ...)` combined with `.where()` or `.orderBy()` on another field

Acceptable query shapes (no composite index required):

| Pattern | Allowed |
|---|---|
| `.doc(id).get()` — direct key read | ✅ |
| `.where('field', '==', x).get()` — single-field equality | ✅ |
| `.where('field', '==', x).limit(N).get()` — same field + limit | ✅ |
| `.orderBy('field').get()` — single-field sort | ✅ |
| `.where('field', '==', x).orderBy('field')` — same field | ✅ |
| `.where('a', '==', x).where('b', '==', y)` — multiple equalities, single-field index suffices on Firestore today | ✅ |
| `.where('a', '==', x).where('createdAt', '>', t)` — equality + inequality on different fields | ❌ needs composite |
| `.where('a', '==', x).orderBy('b')` — equality + orderBy on different field | ❌ needs composite |
| `.where('tags', 'array-contains', t).orderBy('createdAt')` | ❌ needs composite |

**Workarounds for the ❌ rows (use these instead of asking for an index):**

1. **Denormalise**: store a precomputed sort key. `users_byRoleAndDate/{role}_{yyyymmdd}` collection where the doc id encodes the compound key — reads become `.doc(...)`.

2. **In-memory sort on small result sets**: if the result set is bounded (e.g. ≤ 200 docs), fetch with a single equality `where()` and sort/filter in Node. The 50k/day platform quota covers this for most app traffic; the platform actively prefers this shape over composite indexes.
   ```ts
   const docs = (await appCollection('todos')
     .where('userId', '==', uid)   // single-field, no composite index
     .get()).docs.map(d => d.data())
   docs.sort((a, b) => b.createdAt - a.createdAt)  // sort in memory
   ```

3. **Aggregate documents**: instead of `where(a).orderBy(b)`, maintain a per-user "feed" document at `apps/{appId}/users/{uid}/_feed/latest` that the writer updates atomically. Readers do a single `.get()`.

4. **Bucketing**: instead of `where(category).orderBy(createdAt)`, write each item to `apps/{appId}/category/{cat}/items/{itemId}` and list with `.orderBy(documentId)` — no composite needed.

**If — after exhausting workarounds 1–4 — a composite index is genuinely the right answer**, do NOT silently ship the code. Instead:
- Surface the requirement to the user in chat BEFORE writing the query: "this query needs a composite index on (`field_a`, `field_b`); the platform's index manifest must be updated. Do you want me to denormalise instead, or proceed and request the index from platform support?"
- If proceeding, write the index requirement into a `INDEX-REQUEST.md` at the project root with the exact composite shape the platform engineer needs to add. The platform deploy pipeline reads this file and refuses the deploy until the manifest has been updated, so the dev never reaches a runtime "requires an index" surprise.

Pre-flight check before completing the task — grep your own code:
```bash
# Catch the two most common composite-index-requiring patterns:
grep -rE "\.where\([^)]+\)\.where\([^)]+\)" server/ --include='*.ts'   # multi-where
grep -rE "\.where\([^)]+\)\.orderBy\(" server/ --include='*.ts'        # where + orderBy
```
If either grep returns hits, audit each one against the table above. Do not mark the task done until every multi-where / where+orderBy is either (a) on the same field, (b) refactored to one of the four workarounds, or (c) documented in `INDEX-REQUEST.md`.

### CRITICAL — Client never touches the platform DB directly in v1

The `firebase/firestore` package is **NOT** imported in the user's frontend. All reads/writes go through the user's platform-managed backend, which authenticates via the runtime's native credentials and bypasses Security Rules entirely.

This is enforced by the platform's deny-all Security Rules on the shared database. If you add `import { collection } from 'firebase/firestore'` to client code, every request is rejected — there is no claim configuration the user can apply to fix it.

If the app needs real-time, expose an SSE endpoint from the platform-managed backend that wraps a server-side `onSnapshot` and pushes deltas to the client. Do not work around the deny-all by trying to mint custom claims.

## Step-by-step protocol

### 1. Server: platform admin SDK setup

```bash
npm install firebase-admin
# If migrating from prisma, drop:
npm uninstall @prisma/client prisma
```

Create `server/lib/db.ts`:
```ts
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

if (getApps().length === 0) {
  initializeApp({
    projectId: process.env.TM_PROJECT_ID,
  })
}

/**
 * Data namespace for this app. In production the platform injects
 * `APP_ID` (set when the project is registered for publishing). In local
 * dev there's no publish yet and no APP_ID — fall back to a stable
 * `local-dev-<pkg>` namespace so `npm run dev` works without ceremony.
 * Crashing on missing APP_ID would break login locally for no reason.
 */
const APP_ID =
  process.env.APP_ID ||
  `local-dev-${(process.env.npm_package_name || 'app').replace(/[^a-z0-9]/gi, '-').toLowerCase()}`

export const db = getFirestore()
export const appRoot = db.collection('apps').doc(APP_ID)
export { FieldValue }

/** Convenience helper: typed reference to a collection under this app's root. */
export function appCollection<T = FirebaseFirestore.DocumentData>(name: string) {
  return appRoot.collection(name) as FirebaseFirestore.CollectionReference<T>
}
```

### 2. Translate the existing schema to platform DB documents

The platform DB is schema-less but consistent shape per collection is what makes queries possible. Translate each table to a collection; each row to a document; the row's PK becomes the document ID.

```ts
// server/db/types.ts
export interface User {
  uid: string                  // doc id; do NOT duplicate as a field
  email: string                // unique — enforced application-side (the platform DB doesn't have unique constraints; see step 3)
  name?: string
  avatarUrl?: string
  role: 'user' | 'admin'
  phone?: string
  bio?: string
  location?: string
  createdAt: FirebaseFirestore.Timestamp
  updatedAt: FirebaseFirestore.Timestamp
}

export interface Post {
  id: string                   // doc id
  authorUid: string
  title: string
  body: string
  publishedAt: FirebaseFirestore.Timestamp | null
  createdAt: FirebaseFirestore.Timestamp
  updatedAt: FirebaseFirestore.Timestamp
}
```

Conventions:
- **Document ID = natural key** when one exists (uid for users, slug for posts). Otherwise use the platform DB's auto-id.
- **Timestamps** use `FieldValue.serverTimestamp()` on create + update; never new `Date()` from the client (clock drift).
- **No foreign-key types** — store the related doc's ID as a string field (`authorUid` above). Joins happen via Pipeline operations or in-app code.
- **Don't store the document ID as a field** — `doc.id` is always available.

### 3. Translate every Prisma/ORM call

Pattern map (Prisma → platform admin SDK):

| Prisma | Platform DB (admin SDK) |
|---|---|
| `prisma.user.findUnique({ where: { uid } })` | `(await appCollection('users').doc(uid).get()).data()` |
| `prisma.user.upsert({ where: { uid }, create, update })` | `appCollection('users').doc(uid).set(payload, { merge: true })` |
| `prisma.user.update({ where: { uid }, data })` | `appCollection('users').doc(uid).update(data)` |
| `prisma.user.delete({ where: { uid } })` | `appCollection('users').doc(uid).delete()` |
| `prisma.user.findMany({ where: { role: 'admin' } })` | `(await appCollection('users').where('role', '==', 'admin').get()).docs.map(d => d.data())` |
| `prisma.$transaction([a, b])` | `db.runTransaction(async (tx) => { tx.update(...); tx.update(...) })` |
| Atomic increment | `update({ count: FieldValue.increment(1) })` |
| Array append | `update({ tags: FieldValue.arrayUnion('x') })` |

**Unique-constraint emulation** (the platform DB has no unique constraints — email collision detection is application-side):
```ts
const exists = await appCollection('users').where('email', '==', email).limit(1).get()
if (!exists.empty) throw new Error('Email already in use')
// Then create. Race condition window exists — use a transaction for stricter guarantees.
```

For true uniqueness use a transaction OR an index document at `apps/{appId}/_index/email_{normalizedEmail}` that the create path writes atomically.

### 4. In-memory cache pattern — CLIENT-side (Zustand example)

The frontend bootstraps critical collections into a Zustand store on app start. Every component reads from the store; mutations write through to the platform DB + the store simultaneously.

```ts
// client/src/stores/userStore.ts
import { create } from 'zustand'

interface User { uid: string; email: string; name?: string; role: 'user' | 'admin' }

interface UserState {
  current: User | null
  cache: Map<string, User>        // shared cache for any user the app has loaded
  bootstrapped: boolean

  /** Called once after sign-in. Loads the current user + initial peer list. */
  bootstrap: (authUid: string) => Promise<void>
  /** Get a user from cache; falls back to a one-shot fetch if cold. */
  getUser: (uid: string) => Promise<User | null>
  /** Mutation: writes through to the platform DB + updates cache. No read-before-write. */
  updateProfile: (patch: Partial<Pick<User, 'name' | 'avatarUrl'>>) => Promise<void>
}

export const useUserStore = create<UserState>((set, get) => ({
  current: null,
  cache: new Map(),
  bootstrapped: false,

  bootstrap: async (authUid) => {
    if (get().bootstrapped) return
    // Single fetch — populates store. Subsequent component reads hit memory, not the platform DB.
    const res = await authFetch('/api/users/me')
    const me: User = await res.json()
    const cache = new Map(get().cache)
    cache.set(me.uid, me)
    set({ current: me, cache, bootstrapped: true })
  },

  getUser: async (uid) => {
    const cached = get().cache.get(uid)
    if (cached) return cached
    const res = await authFetch(`/api/users/${uid}`)
    if (!res.ok) return null
    const user: User = await res.json()
    const cache = new Map(get().cache)
    cache.set(uid, user)
    set({ cache })
    return user
  },

  updateProfile: async (patch) => {
    const current = get().current
    if (!current) throw new Error('Not signed in')
    // Write-through: optimistic local update FIRST so UI feels instant,
    // then persist to the platform DB. On failure, revert.
    const next = { ...current, ...patch }
    const cache = new Map(get().cache)
    cache.set(current.uid, next)
    set({ current: next, cache })
    try {
      await authFetch(`/api/users/${current.uid}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    } catch (err) {
      // Revert.
      cache.set(current.uid, current)
      set({ current, cache })
      throw err
    }
  },
}))
```

Key points:
- `bootstrap` runs once after auth — N reads upfront, zero subsequent reads for cached data.
- `getUser` is the lazy variant — peer profiles load on demand, then stay cached.
- `updateProfile` is optimistic: UI updates instantly, network write happens in the background, revert on failure.
- Same pattern for posts, settings, notifications, anything not real-time.

### 5. In-memory cache pattern — SERVER-side (Express + node-cache)

The backend is generally stateless — every request is a fresh process from the load balancer's POV — but **within a single backend instance**, an in-memory cache survives across requests and meaningfully reduces the platform DB reads for hot data.

```ts
// server/lib/cache.ts
import NodeCache from 'node-cache'

// 60s TTL is a sane default for read-mostly data. Adjust per-collection.
export const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 })

export async function withCache<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
  const hit = cache.get<T>(key)
  if (hit !== undefined) return hit
  const fresh = await loader()
  cache.set(key, fresh, ttl)
  return fresh
}
```

```ts
// server/routes/users.ts
import { withCache } from '../lib/cache.js'
import { appCollection } from '../lib/db.js'

router.get('/api/users/:uid', async (req, res) => {
  const user = await withCache(`user:${req.params.uid}`, 60, async () => {
    const snap = await appCollection('users').doc(req.params.uid).get()
    return snap.exists ? snap.data() : null
  })
  if (!user) return res.status(404).json({ error: 'Not found' })
  res.json(user)
})
```

**Invalidation on writes**:
```ts
router.patch('/api/users/:uid', async (req, res) => {
  await appCollection('users').doc(req.params.uid).update({
    ...req.body,
    updatedAt: FieldValue.serverTimestamp(),
  })
  cache.del(`user:${req.params.uid}`)
  res.json({ ok: true })
})
```

### 6. Real-time path — server-side onSnapshot + SSE

When the user's app needs live updates (chat, presence, collaborative cursors), the listener runs **on the backend**, not in the browser. The backend opens a server-side `onSnapshot` (which works on the server and is not subject to Security Rules), and pushes deltas to the client over SSE.

```ts
// server/routes/chat.ts
import { appCollection } from '../lib/db.js'

router.get('/api/conversations/:id/stream', async (req, res) => {
  // SSE headers — keep the connection open.
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const unsub = appCollection('conversations')
    .doc(req.params.id)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .onSnapshot((snap) => {
      const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      res.write(`data: ${JSON.stringify(messages)}\n\n`)
    })

  req.on('close', () => unsub())
})
```

The client consumes it with `EventSource('/api/conversations/abc/stream')` — same-origin, no client SDK needed.

Bill math: only one listener per active conversation regardless of how many clients are reading. The backend fans out the delta to all SSE subscribers in-process, so 100 clients in the same room cost 1 DB read per new message instead of 100.

### 7. Security Rules — platform-owned, deny-all

The shared platform database is locked down by platform-owned rules that deny all client access:

```javascript
// platform-side: toquemedia-studio-api/firestore/rules.firestore (do not edit from user projects)
match /apps/{appId}/{document=**} {
  allow read, write: if false;
}
```

This is intentional. The trust model is:
- **Backend (the platform runtime)** authenticates via the runtime's native credentials → Security Rules don't apply → full access to `apps/{APP_ID}/...`.
- **Client (browser)** has only a auth JWT → Security Rules apply → access denied.

**Do not write `firestore.rules` in the user's project.** Per-project rule files would either be ignored (the platform rules are authoritative on the shared DB) or overwrite another user's deploy if pushed via a direct deploy. If a future feature needs direct client access, request it from platform support — it is not a per-project decision.

### 8. Dockerfile

The platform runtime IS Cloud Run. Your Dockerfile must satisfy the Cloud Run container contract:

> *"The ingress container within an instance must listen for requests on `0.0.0.0` on the port to which requests are sent. Notably, the ingress container should not listen on `127.0.0.1`."* — Cloud Run docs
>
> *"By default, requests are sent to `8080`, but you can configure Cloud Run to send requests to the port of your choice."*

Three rules that flow from the contract and are violated repeatedly:

1. **Bind `0.0.0.0`, not `127.0.0.1` / `localhost`** — Cloud Run drops the request otherwise.
2. **Read `process.env.PORT` (default 8080)** — Cloud Run injects this; ignoring it is a startup probe failure.
3. **No `.env` file inside the image** — secrets reach the container via Cloud Run env vars (the platform reads them from `.env` and forwards them at deploy time via `readBackendEnvVars`). Putting `.env` in the image is a credential leak AND `.dockerignore` excludes it anyway, so a `--env-file=.env` CMD silently breaks at runtime.

#### Step 0 — Classify the layout BEFORE writing the Dockerfile

Look at `package.json` at the project root:

| Signal | Layout |
|---|---|
| `scripts.build === "vite build"` (or `next build`, `nuxt build`, `astro build`, `ng build`) | **Frontend-only build script.** The backend has no build script — the project is FLAT (root `package.json` shared by frontend and backend). Use the FLAT-layout template. |
| `workspaces` defined + `client/` + `server/` siblings, each with own `package.json` | **Monorepo.** Use the SUBPACKAGE template (build context = `server/`). |
| Single `package.json` with `scripts.build === "tsc -p server/tsconfig.json"` (or similar server-only build) | **Server-subdir layout.** Use the SUBDIR template. |

#### Template A — FLAT layout (root `package.json` shared, backend in `server/`)

This is the most common case for `react-express-*` style projects. Server source is `.ts`; runs via `tsx` in dev. **Two valid Dockerfile shapes:**

**A.1 — Compile-to-JS (recommended, smallest image):**

```dockerfile
# Stage 1 — compile server TS to JS using devDeps
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY server ./server
# Compile server only. The frontend is built and uploaded separately by the
# platform — never call `npm run build` here, that's `vite build`.
RUN npx tsc --project server/tsconfig.json --outDir server/dist

# Stage 2 — runtime: prod deps only + compiled JS
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./server/dist
# Cloud Run injects PORT (default 8080); the server MUST read it and bind 0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
```

Requires a `server/tsconfig.json` whose `compilerOptions.outDir` is `dist` (or matches `--outDir` above) and `module: "NodeNext"` / `target: "ES2022"`. Generate it in the same scaffold turn if absent.

**A.2 — Run-with-tsx (no compile step; tsx as prod dep):**

```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# tsx runs .ts directly — promote it from devDeps to deps in package.json
# BEFORE building this image, otherwise `npm ci --omit=dev` strips it.
RUN npm ci --omit=dev
COPY server ./server
COPY tsconfig*.json ./
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
```

Trade-off: tsx parses TS at startup (~150ms cold start cost) but skips the build stage. Pick A.1 unless cold start time isn't a concern.

#### Template B — SUBDIR layout (server/ has its own package.json)

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npx tsc

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

Requires the Cloud Build context to include `server/` only — handled by the IDE's `collect_backend_tarball`, which already excludes `src/` / `public/` / `vite.config.*` at the project root.

#### Template C — Python 3.12 (FastAPI / Flask)

```dockerfile
FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
ENV PORT=8080
EXPOSE 8080
# FastAPI via uvicorn; for Flask: `gunicorn -b 0.0.0.0:8080 server.app:app`
CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT}"]
```

Python contract:
- Admin SDK init is `firebase_admin.initialize_app()` (no creds — runtime auto-detects).
- `APP_ID` via `os.environ['APP_ID']`; same shape as Node.
- Framework MUST bind on `0.0.0.0:${PORT}`. Hard-coding the port fails Cloud Run's startup probe.

Other languages (Go, Rust, Ruby, Java) follow the same pattern: read `APP_ID` from env, bind `0.0.0.0:${PORT}`, use the native platform admin client. Ask before shipping a non-Node / non-Python Dockerfile.

#### Anti-patterns — DO NOT do any of these

Each line below failed in production. The harness rejects writes that match these patterns; the rejection message points back to this section.

1. **`RUN npm run build` when the project's `build` script is `vite build` / `next build` / `nuxt build` / `astro build` / `ng build`.** That's the FRONTEND build. The frontend goes to R2 separately via the upload phase. Running it in the container produces nothing the runtime needs and almost always fails because the `--omit=dev` step before stripped vite/next/etc.
2. **`npm ci --omit=dev` BEFORE compiling TypeScript.** Strips tsc/tsx/vite/etc. — the compile step that follows fails with `tsc: not found` or `vite: not found`. Either install deps fully in a build stage (Template A.1 / B), or promote the runtime-needed devDeps to `dependencies` (Template A.2).
3. **`CMD ["node", "server/index.ts"]`.** Node cannot execute `.ts` directly. Either compile to `.js` first (Template A.1 / B) or use `tsx` (Template A.2).
4. **`CMD ["node", "--env-file=.env", "server/index.ts"]`.** `.env` is in `.dockerignore` (next section), so `--env-file=.env` reads a non-existent file and either crashes or silently sets nothing. Cloud Run env vars are injected at deploy time by `readBackendEnvVars`; the runtime sees `process.env.X` directly.
5. **Hard-coded port: `app.listen(3000, ...)` or `EXPOSE 3000` mismatched with `PORT`.** Cloud Run injects `PORT=8080` (or whatever the service is configured for); a hard-coded port fails the startup probe and the deploy hangs at "waiting for backend to come online" until the 45s timeout in `waitForBackendReady`. Always: `app.listen(Number(process.env.PORT) || 8080, '0.0.0.0', ...)`.
6. **Listening on `127.0.0.1` / `localhost`.** Cloud Run docs (verbatim): *"the ingress container should not listen on 127.0.0.1"*. Bind `0.0.0.0` explicitly.
7. **`COPY serviceAccountKey.json` or any credential JSON.** The platform runtime authenticates natively via the metadata server. Shipping a key in the image is a leak AND mismatches the IAM identity Cloud Run actually has. The harness blocks this — see the parallel CRITICAL block above.

### 9. `.dockerignore`

```
node_modules
.git
.env
.env.*
dist
**/*.log
**/.DS_Store
src
public
index.html
vite.config.ts
```

The frontend (`src/`, `public/`, etc.) is built separately by the platform. The platform DB rules and indexes are platform-owned (managed in `toquemedia-studio-api`), not bundled into the user's container.

### 10. Build pipeline

The platform builds the image server-side. Your project ships the Dockerfile + .dockerignore only. Skip any build-config file at the project root — the platform's build pipeline runs an inline spec against your Dockerfile.

### 11. Update package.json scripts

No the platform DB-specific scripts are needed in the user's `package.json`. There are no local migrations (the platform DB is schemaless), no per-project rules deploy (rules are platform-owned), and no per-project index deploy (indexes are platform-owned).

Local dev: the local emulator is available but optional. The simplest path is to point dev at the same the platform DB database the prod backend uses — every read counts towards the 50k/day free tier, which covers typical dev usage easily.

### 12. Server env reads

Only env vars the server actually needs:

| Var | Source | Purpose |
|---|---|---|
| `TM_PROJECT_ID` | provision_auth → .env | Platform project id for admin SDK initApp |
| `APP_ID` | provision_deploy → .env | Multi-tenant data namespace |
| `PORT` | platform runtime injects | Bind address |
| `TM_AUTH_KEY` | provision_auth → .env | Auth-API REST calls (public client key) |
| `TM_TENANT_ID` | provision_auth → .env | Per-app tenant scope |

(Legacy names `GCP_PROJECT_ID` / `GIP_FIREBASE_API_KEY` / `GIP_TENANT_ID` are also in .env for backward compat with already-scaffolded projects — new code reads the `TM_*` names.)

NOT needed:
- `GOOGLE_APPLICATION_CREDENTIALS` — the platform service account is detected automatically.
- `serviceAccountKey.json` — never bundled into the container.
- Any database-specific API token — IAM handles auth.

## Pipeline operations — when you actually need joins or full-text search

Most app code doesn't need this. The 4 cases where it's worth reaching for:

1. **JOIN-style queries**: "give me posts AND their authors in one round-trip". Without Pipeline operations you'd do N+1 reads. With Pipelines you can subquery the authors collection inline.
2. **Full-text search** on user-generated content (post bodies, comments). Don't roll your own — use the platform DB full-text feature.
3. **Geospatial**: "stores within 5km". Use `$near` on a geospatial-indexed field.
4. **Server-side aggregations**: `count()`, `sum()`, `avg()` over a filtered collection. These are dedicated aggregation queries that bill 1 read per aggregation, not per scanned document.

For these, lean on the platform DB's pipeline operations (subquery, aggregate, full-text, geospatial). The MongoDB-compatibility shim is the easier API surface if the dev already knows MongoDB.

## Verification

Before reporting done:

1. **Server boots locally**:
   ```bash
   docker build -t test-backend .
   docker run --rm -p 8080:8080 --env-file .env test-backend
   ```
   The `--env-file .env` passes every credential the server reads (TM_PROJECT_ID, APP_ID, TM_AUTH_KEY, TM_TENANT_ID, plus legacy mirrors). The server should boot. `curl http://localhost:8080/api/health` → `{"status":"ok"}`.

   Note: local Docker won't have the platform service account → the platform DB reads/writes will 401. That's expected; verify the boot, deploy to the platform runtime for full e2e.

2. **No firebase/firestore import in client code**:
   ```bash
   grep -rn "from 'firebase/firestore'" src/ client/src/ 2>/dev/null
   ```
   Should return nothing. Direct client access is denied at the platform rules level.

3. **Cache behaviour**: open DevTools Network tab → reload the app → confirm **1 fetch per critical collection on boot**, **zero fetches** when navigating between cached views. Mutations should produce exactly 1 PATCH/POST + the local UI updates instantly without a follow-up GET.

Report what was implemented + skip the parts already complete. If the project was using Prisma + SQLite, the port to Admin SDK + cache + Dockerfile are the bulk of the work.

---

## FINAL REMINDER — the three rules that cost the most when broken

The full rule list is above. These three are repeated here at the end because **a single violation burns either the deploy turn or a customer's trust** — two leak data / credentials, the third produces a 7-minute Cloud Build failure with an opaque "vite: not found" stack trace. Both modes look like generic infra problems until someone traces the cause to the SKILL rule that was missed. Re-read these before submitting any publish-backend change:

1. **Never embed `serviceAccountKey.json` or use credential files.** The platform runtime auto-detects credentials via the metadata server. Initialize with `{ projectId: process.env.TM_PROJECT_ID }` and **no second argument**. The harness rejects writes that import any `serviceAccountKey.json`, but you're expected to write the no-credential form first try. **Symptom of failure**: the deploy ships a JSON key in the bundle, the IAM mismatch produces 403s on every read, and now there's a leaked credential to rotate.

2. **Every collection access starts at `apps/{APP_ID}/...`.** A query against `db.collection('users')` (without the prefix) returns rows from EVERY user-app sharing the database — that's a multi-tenant data leak with no way to undo. The local-dev fallback `local-dev-<pkg-name>` keeps `npm run dev` working without ceremony; production gets the real `APP_ID` injected by the platform. **Symptom of failure**: user A logs in and sees user B's data — the platform service account can read everything, so the queries succeed and the bug is invisible until a customer notices.

3. **NEVER `RUN npm run build` in the backend Dockerfile when the project's `build` script is `vite build` / `next build` / `nuxt build` / `astro build` / `ng build`.** That's the FRONTEND build — frontend assets go to R2 separately via the upload phase. Calling it in the container is dead code AND fails Cloud Build because the typical preceding `RUN npm ci --omit=dev` strips vite/next/etc. Pick §8 Template A.1 (multi-stage compile-to-JS) or A.2 (run-with-tsx) based on layout. The harness rejects this write, but the recovery wastes a turn — write the right Dockerfile first try. **Symptom of failure**: Cloud Build dies at step 6/8 with `sh: vite: not found` after 5-7 min of pulling images; the deploy modal flips to "container/build failed" and the user must apagar the orphan deploy before retrying.
