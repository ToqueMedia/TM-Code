# PLAN-DEPLOY-V2

**Status:** mid-flight. Phases 0 + 1 shipped. Phases 3 + 4 collapsed into a single Cloud Run + Firestore path that is **code-complete pending first real end-to-end deploy**. Phases 2, 5, 6 deferred. The v1 deploy path (Cloudflare R2 + Workers + D1, single shape) is **hidden** from the UI as of 2026-05-07.

**Last updated:** 2026-05-13.

## Pivot summary (read first)

The plan below was written assuming an all-Cloudflare backend (Workers Containers + D1 over HTTP). During implementation it pivoted to a hybrid:

| Component | Original plan | Current reality |
|---|---|---|
| Frontend hosting | R2 + Workers | Same — unchanged |
| Backend runtime | Workers Containers (CF) | **Cloud Run** (GCP, `dev-studio-projects`) |
| Database | D1 over HTTP | **Firestore** `(default)` with path-scoped multi-tenancy under `apps/{appId}/...` |
| Backend trust model | Per-app D1 token in env | **ADC** — Cloud Run runtime SA reads Firestore natively, no creds in `.env` |
| Auth claims | (none needed) | Same — GIP token's `firebase.tenant` claim suffices; client never hits Firestore directly |

Why: Workers Containers GA was too fresh to bet on; D1's HTTP API forced token-management in user `.env`; Firestore + ADC + Cloud Run's free tier turned out cheaper and operationally simpler. Phases 3 (Containers) and 4 (composite + D1 swap) collapsed into a single composite-on-Cloud-Run path delivered together.

---

## 1. Product position (why this exists)

The welcome screen presents two flows. The deploy plan only serves one of them:

| Card | Promise | Deploy strategy |
|---|---|---|
| **Novo Projeto** | "Do zero ao live — chat, preview e deploy num clique" | This plan. Scaffolded, on rails, one-click. |
| **Modo Terminal** | Free-form agentic terminal, like Claude Code / Codex | **Not supported by IDE.** User runs `/start-server`, deploys themselves outside TM Code. |

This split is the load-bearing decision. It lets the plan **drop "any language any Dockerfile"** as a requirement, because the user who wants that is already in Modo Terminal where TM Code never offered deploy in the first place. The constraint of a rigid scaffolded shape is now acceptable — the IDE owns the infrastructure files, the user owns the code.

---

## 2. Architecture: all-Cloudflare, with GIP for auth

```
User domain (custom or <slug>.toquemedia.net)
        ↓
Cloudflare Worker (router, KV-backed route map)
  ├── /api/*       → Workers Container  (user's backend, any runtime)
  ├── /__auth/*    → Google Identity Platform (per-tenant SDK)
  ├── /assets/*    → R2                  (static, edge-cached)
  └── /*           → Workers Static Assets (SPA HTML, SPA fallback)

D1 (sqlite at the edge)              Cloudflare Account (one, TM-owned)
  └── per-app database               Per-user isolation by name prefix

GIP (Google Identity Platform)       GCP (one TM-owned project)
  └── per-app tenant                 Multi-tenancy: tenants/{tenantId}
```

**Auth lives outside Cloudflare** because (a) the IDE's `provision_auth` already wires GIP end-to-end and (b) GIP's multi-tenant model is mature and gives us strong isolation between user-app users. Cloudflare Access targets B2B SSO, not consumer auth flows, so it isn't a fit. Everything else collapses into Cloudflare.

**The Worker is a router**, not a runtime. The user's backend code never runs *in* the Worker — it runs in a Cloudflare Container. The Worker forwards `/api/*` to the container via the binding (in-process, no internet hop), and serves static / proxies auth on every other path.

---

## 3. Confirmed decisions

| # | Question | Decision |
|---|---|---|
| 1 | Compute platform | **Cloudflare only**: Workers Static Assets + Workers Containers (GA 2026-04-13). Cloud Run dropped from plan — the "any language" case is served by Modo Terminal. |
| 2 | Database | **D1**. Co-located with the runtime (Worker binding + Container fetch to Worker), so the cross-cloud latency penalty that vetoed D1 in the previous draft no longer applies. |
| 3 | Auth | **GIP unchanged — and already in the right shape**. Verified from code (`toolExecutor.ts:2563+`, console URL `console.cloud.google.com/customer-identity;tenantId=TM-*?project=dev-studio-projects`): `provision_auth` already creates per-app tenants inside the shared TM Code GCP project `dev-studio-projects`. There is no per-user GCP project model to deprecate, and no migration needed. The tool's current contract (tenant + `.env` write, idempotent, agent picks backend stack) is what v2 needs. |
| 4 | Multi-tenancy | **Single Cloudflare account + single GCP project**, namespace by `tmcode-{userId}-{slug}` across Worker name, R2 prefix, D1 db name, container image tag, GIP tenant id. |
| 5 | Plan gating | **Paid only**: `explorer` (free) cannot deploy. Backend `init` returns 403; frontend swaps "Publish" for an upgrade CTA. |
| 6 | Custom domain | All deploys (incl. API-only fullstack split) get `<slug>.toquemedia.net`; user-level custom domain is routed through Cloudflare via the same Worker entry. |
| 7 | Build location | **Remote build via wrangler containers**. No `docker build` on the user's host — wrangler ships the source to Cloudflare's build service. Removes Docker as a dependency for deploy. |
| 8 | Versioning / rollback | Keep last 3 Worker + container deploys per app; one-click rollback in DeploysSection. |

---

## 4. `DeployPlan` (central type)

```ts
type DeployPlan =
  | { kind: 'static-spa'; outputDir: string; spaFallback?: string }
  | { kind: 'cf-ssr'; adapter: SsrAdapter; assetsDir: string; workerEntry: string }
  | { kind: 'workers-container'; runtime: ContainerRuntime; port: number; envVars: string[] }
  | { kind: 'composite'; frontend: StaticOrSsrPlan; backend: ContainerPlan; apiPrefix: string }

type SsrAdapter = 'next-on-pages' | 'sveltekit' | 'nuxt' | 'astro'

type ContainerRuntime =
  | { lang: 'node'; version: '20' | '22' }
  | { lang: 'python'; version: '3.12' }
  | { lang: 'go'; version: '1.22' }
  | { lang: 'rust'; edition: '2021' }
  | { lang: 'ruby' | 'java'; version: string }
```

Persisted at project root in `.toquemedia-deploy.json`, separate from `.toquemedia-template` (scaffold manifest). Survives rebuilds; allows manual override.

---

## 5. Worker route KV schema

```ts
type RouteEntry =
  | { kind: 'static';            assetsPrefix: string }
  | { kind: 'cf-ssr';            workerBindingName: string }
  | { kind: 'workers-container'; containerBindingName: string; cacheable: boolean }
  | { kind: 'composite';         containerBindingName: string; apiPrefix: string; assetsPrefix: string }
```

API-only deploy → `workers-container` entry (proxies all traffic). Fullstack → `composite` entry (proxies `/api/*` to container, serves rest from R2). Identical custom-domain flow regardless of kind.

---

## 6. Runtime detection

`src/services/deploy/runtimeDetector.ts` — pure function over `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml` / `build.gradle`. Inferences below; fallback delegates to the agent via an `inferDeployPlan` skill.

| Signal | Plan |
|---|---|
| `package.json` + `next` | `cf-ssr` adapter `next-on-pages` |
| `package.json` + `nuxt` | `cf-ssr` adapter `nuxt` |
| `package.json` + `@sveltejs/kit` | `cf-ssr` adapter `sveltekit` |
| `astro.config.*` + `output: 'server'` | `cf-ssr` adapter `astro` |
| `package.json` + Express/Fastify/Nest, no adapter | `workers-container` Node |
| `package.json` Vite-only (no SSR) | `static-spa` |
| `requirements.txt` ∨ `pyproject.toml` | `workers-container` Python |
| `go.mod` | `workers-container` Go |
| `Cargo.toml` with `[[bin]]` | `workers-container` Rust |
| Monorepo (`workspaces` or `client/server` dirs) | `composite` (recurse per subdir) |

---

## 7. Agent tool: `provision_deploy`

Mirrors the existing `provision_auth`. Idempotent. Behaviour by plan kind:

- **static-spa**: validate that the build script produces `outputDir`. Write a minimal `wrangler.toml` declaring the assets binding.
- **cf-ssr**: install the relevant Cloudflare adapter (`@sveltejs/adapter-cloudflare`, etc.), edit framework config to the Cloudflare preset, adjust `package.json` build script.
- **workers-container**: generate `Dockerfile` from `src-tauri/resources/dockerfiles/<runtime>.dockerfile`, generate `wrangler.toml` with `[[containers]]` + `[[durable_objects.bindings]]` + `[[migrations]]`, generate `src/worker.ts` wrapper that exports a `MyContainer extends Container` class and a `fetch` that forwards to `getContainer(env.MY_CONTAINER, request.cf.colo).fetch(request)`. Add `.dockerignore` if absent.
- **composite**: recurse for each subdir; the front-matter `apiPrefix` is wired into the Worker route map.

All generated infra files live under `.toquemedia-deploy/` (a single directory) where reasonable — the user's source tree stays clean. The exceptions (`wrangler.toml`, `Dockerfile`, `.dockerignore`) live at project root because tooling expects them there. We do not put TS source in the user's tree unless it's an SSR-adapter requirement.

Writes `.toquemedia-deploy.json` at the end. Does not touch app code.

---

## 8. Backend API (`toquemedia-studio-api`)

```
POST /v1/projects/deploy/init
  body:    { projectId, plan: DeployPlan }
  returns: { slug, gipTenantId, gipApiKey, cloudflare: { accountId, kvNamespaceId, d1DatabaseId? } }
  effect:  rejects free plan; idempotently provisions GIP tenant, R2 prefix,
           D1 database (if plan declares it), KV namespace entry. All resources
           named `tmcode-{userId}-{slug}` for cost attribution + cleanup.

POST /v1/projects/deploy/assets/upload
  body:    { projectId, slug, chunkIndex, totalChunks, files: [{path, content}] }
  returns: { uploaded: n }
  effect:  chunked R2 writes under <slug>/. Same shape as v1 — chunk size /
           parallelism kept (8 MB / 50 files / concurrency 3) to dodge per-
           request CPU budget on Cloudflare's API surface.

POST /v1/projects/deploy/container/build
  body:    { projectId, slug, sourceTarballUrl, dockerfile }
  returns: { imageRef }
  effect:  wrangler containers build remote (source already in R2 staging
           bucket); returns the Cloudflare-internal image ref. No Docker
           required on the IDE host.

POST /v1/projects/deploy/worker/deploy
  body:    { projectId, slug, workerScript, wranglerConfig }
  returns: { workerUrl }
  effect:  wrangler deploy. Worker bundle is the router generated by
           provision_deploy; bindings (containers, R2, D1, KV) come from
           wranglerConfig.

POST /v1/projects/deploy/finalize
  body:    { projectId, slug }
  effect:  writes the KV route entry, sets up custom-domain CNAME if
           requested, persists deploy record in Firestore.
```

---

## 9. Migration from current state

**Auth: nothing to migrate.** GIP tenants are already in the shared TM Code GCP project; the `.env` contract (`VITE_FIREBASE_*` + `GIP_*` + `GCP_PROJECT_ID`) is exactly what the v2 Worker router will read. Users who have run `provision_auth` keep working unchanged.

**Deploys: probably nothing to migrate either.** v1 was hidden 2026-05-07 (~5 days before this plan). Any user who deployed under v1 between go-live and hide-date is a candidate for migration of R2 / D1 resource names — to be confirmed by querying the backend's deployment Firestore collection.

If candidates are found:
- Dual-mode for 6 months: v1 deploys keep serving via the v1 code path, detected by `planVersion: 1` on the deploy record. New deploys land on v2.
- After 6 months, surface a migration banner (resource rename, no behaviour change).

If no candidates are found (likely): drop the v1 endpoints in the same PR as the v2 launch.

---

## 10. Cleanup of v1 path (Phase 0 — pre-requisite)

The v1 path was a single-shape deploy (Hono Worker bundle from `backend/dist/worker.js` + Drizzle for D1). Verified from code: `src-tauri/src/commands/filesystem.rs:407` (`collect_deploy_bundle`), `src/services/deployService.ts` (4-phase orchestration), `src-tauri/src/commands/filesystem.rs:452-470` (worker.js discovery). The cleanup makes the bundle plan-aware so v2 strategies can plug in without rewriting these surfaces.

**Frontend (`src/services/deployService.ts`):**
- `callPhase('worker', ...)` and `hasWorker` flag → remove. Worker handling moves into the strategy modules (§14).
- `DeployBundle.worker_file?` interface field → remove.

**Rust (`src-tauri/src/commands/filesystem.rs`):**
- `DeployBundle.worker_file: Option<DeployBundleFile>` → remove.
- Worker.js discovery (lines 452-470) + the `has_backend && worker_file.is_none()` validation that errors with "run npm run build in backend/" → remove. v2 strategies will collect artifacts plan-aware (see §7).
- Consider renaming `collect_deploy_bundle` → `collect_deploy_artifacts` to signal the shape change; not load-bearing.

**Skills / agent commands:**
- `provision_auth` tool — **no refactor needed**. Verified from code: it does NOT install Hono boilerplate. It calls the backend, creates a GIP tenant in the shared project, writes `.env`. The stale comment at `toolExecutor.ts:2537` ("Copies the bundled auth-proxy boilerplate") is documentation rot from a feature that was never built — clean it up in the same PR.
- `auth-proxy-gip` skill — keep, still valid for dev mode (Vite proxy `/api` → user's local backend) and for the v2 runtime (proxy still lives in the user's backend code, just running in a Workers Container instead of locally).
- New `provision_deploy` tool — new file, no conflict with existing tools (§7).

**Backend (`toquemedia-studio-api`):**
- `/v1/projects/deploy/worker` endpoint → keep until §9 migration audit confirms there are no v1 deploys still pointing at it. If zero, remove in the same PR; if some exist, gate behind `planVersion: 1`.
- New v2 endpoints (§8) — additive, no breakage of v1 paths.

**Templates:**
- No `src-tauri/resources/auth-boilerplate/` exists (verified). The earlier v2 draft mentioned auditing it — that was wrong; nothing to audit.
- `react-express-prisma-auth` — Prisma stays, but DB driver switches to **Prisma D1** (`@prisma/adapter-d1`, GA since 2024) so the same template deploys to v2 cleanly. Local dev keeps the SQLite file path.
- Other templates need no changes for Phase 0; their deploy story lands in Phases 1-4.

---

## 11. Templates × DeployPlan coverage

| Template | Plan kind | Status |
|---|---|---|
| `react-ts-vite` | `static-spa` | ✅ out-of-box |
| `vue-ts-vite` | `static-spa` | ✅ out-of-box |
| `svelte-ts-vite` | `static-spa` | ✅ out-of-box |
| `astro` (static) | `static-spa` | ✅ out-of-box |
| `angular-ts` | `static-spa` (flatten `dist/<app>/`) | ✅ with detector fix |
| `nextjs-ts` | `cf-ssr` (next-on-pages) | needs adapter wiring (Phase 2) |
| `nuxt-ts` | `cf-ssr` (nuxt-cloudflare) | needs adapter wiring (Phase 2) |
| `react-express-ts` | `composite` (static-spa + workers-container Node) | Phase 3 |
| `react-express-prisma-auth` | `composite` + D1 (Prisma D1 adapter swap) | Phase 3 |
| `express-ts` | `workers-container` Node | Phase 3 |
| `fastify-ts` | `workers-container` Node | Phase 3 |
| `nestjs-ts` | `workers-container` Node | Phase 3 |

11/11 templates covered. No template is "Modo Terminal only".

---

## 12. Phasing

| Phase | Scope | State (2026-05-13) | Cumulative coverage |
|---|---|---|---|
| **0** | Cleanup of v1 worker-bundle path | ✅ Shipped | — |
| **1** | Detector + `static-spa` (Vite/Vue/Svelte/Astro static) → R2 + Worker | ✅ Shipped | 5/11 templates |
| **2** | `cf-ssr` (SvelteKit, Nuxt, Astro-SSR, Next-on-pages) | ❌ Deferred — see scope below | 8/11 templates |
| **3+4** | `composite` Cloud Run + Firestore (Vite frontend + Node backend) — replaced original Workers-Containers + D1 split | 🟡 Code complete, awaiting first real deploy validation | 11/11 Vite-shape templates |
| **5** | Multi-lang Cloud Run runtimes (Python / Go / Rust / Ruby / Java Dockerfiles) | ❌ Deferred | anything the agent writes within scaffolded shapes |
| **6** | Polish: clickable Cloud Build logs, rollback UI, env var editor, custom domain UX | ❌ Deferred | shippable |

### Phase 3+4 — what "code complete" means (and what's missing)

Implemented:
- `provision_deploy` writes `APP_ID` to `.env`, reserves slug, persists record.
- `#deploy-backend` hashtag loads `deploy-cloud-run-firestore` skill.
- IDE `deployService.deploy()` composite branch: bundle → init → upload → `collect_backend_tarball` → `/container/build` (trigger) → `/container/build-status` poll (3s, 15-min ceiling) → `/container/deploy` → finalize.
- Backend `submitCloudBuildTrigger` + `getCloudBuildStatus` split. `runContainerBuildTrigger` + `runContainerBuildStatus`. Source tarball cleanup on terminal status.
- Cloud Run provisioning REST client (`cloudRunProvision.ts`), idempotent create-or-update.
- KV `serveSite` proxies `/api/*` to `backendUrl` (Cloud Run service URL).
- Quota gate (`vibe=1 / pro=2 / max=5 / explorer=0`) wired in `runDeployInit` (403 + `DEPLOY_QUOTA` code).
- Platform-owned Firestore rules: `toquemedia-studio-api/firestore/rules.firestore` — deny-all client access. Deployed via `npm run deploy:firestore-rules`.

Not yet done:
- First real end-to-end deploy of `login-test` (or any composite project).
- Cloud Run health-check after provision before declaring success.
- Cleanup path when user deletes a deployed project (Cloud Run service + AR image + Firestore `apps/{appId}/...` purge).
- Bucket lifecycle policy on `gs://tmcode-build-sources` (auto-delete after 1 day) as safety net for the IDE-side tarball cleanup.

### Phase 2 — cf-ssr (deferred, scoped)

Adds three template-specific build adapters before `static-spa` would work:
- `nextjs-ts` → `@cloudflare/next-on-pages` (caveats around edge-runtime APIs).
- `nuxt-ts` → `cloudflare` Nitro preset.
- `astro` → already deployable when configured for static; SSR mode needs `@astrojs/cloudflare`.

Detector additions (`runtimeDetector.ts`): inspect `package.json` for the adapter dep + a `wrangler.toml` or `_routes.json` artefact post-build. If adapter missing, `provision_deploy` should install it (mirrors how `provision_auth` installs auth code).

Effort: 2-3 weeks. Risk: Next-on-pages edge-runtime caveats are case-by-case; needs clear "not all Next features work" surfacing.

### Phase 5 — multi-lang Cloud Run runtimes (deferred, scoped)

Today the skill emits a Node 22 multi-stage Dockerfile. Phase 5 adds the agent a menu of canonical Dockerfile templates per language. The deploy pipeline itself doesn't change — Cloud Build + Cloud Run accept any container.

Order of attack: Python (FastAPI/Flask) first, Go (chi/Echo) second, then Rust, Ruby, Java. Each needs its own runtime env-var contract (e.g. `PORT` injection works the same but `APP_ID` consumption differs by language idiom).

Effort: ~2 weeks for the first two; rest as templates are added.

### Phase 6 — polish (deferred, scoped)

| Item | Where it lands |
|---|---|
| Clickable Cloud Build log URL on build failure | `PublishModal.tsx` history strip — pass `logUrl` through `DeployStep.detail` rendering |
| Rollback to previous revision | New `DeploysSection.tsx` action calling Cloud Run `services.revisions` rollback |
| Edit env vars without re-deploy source | Cloud Run `services.patch` with new `envVars`; new IDE Settings panel |
| Custom domain status polling | Already exists via `getCustomDomainStatus`; needs UI states (pending/active/error) in `DeploysSection.tsx` |
| Quota usage indicator | Show `activeCount / quota` in Settings → Deploys; surface from `/v1/projects/deploys/summary` |
| Health-check gate before "success" | `deployService.ts` composite branch — HEAD on `serviceUrl/api/health` (or `/`) before `completeDeploy` |

Effort: ~2 weeks. None of these are blockers — Phase 3+4 ships without them, they make it pleasant.

---

## Original phasing (pre-pivot, preserved for context)

| Phase | Original scope |
|---|---|
| 0 | Cleanup of v1 worker-bundle path |
| 1 | `static-spa` strategy + plan gating + multi-tenant CF provisioning |
| 2 | `cf-ssr` (SvelteKit, Nuxt, Astro-SSR, Next-on-pages) |
| 3 | `workers-container` Node + Worker router KV + per-runtime Dockerfile templates |
| 4 | `composite` (fullstack monorepos) + Prisma D1 swap in `react-express-prisma-auth` |
| 5 | Multi-lang container runtimes |
| 6 | Polish |

Phase 0 must precede everything else.

---

## 13. Critical risks

| Risk | Severity | Mitigation |
|---|---|---|
| Workers Containers GA only 2026-04-13 — early-adopter bugs | **High** | Phase 3 is when this lands; if Containers is unstable, fall back to delaying that phase (Phases 1-2 still ship value). Monitor Cloudflare changelog + community reports. |
| Build time on Cloudflare's wrangler-containers service | Medium | Stream logs; cancel button; suggest `.dockerignore` for fat repos. |
| `next-on-pages` edge-runtime caveats (Node APIs the user uses) | High | Phase 2 ships with a clear "not all Next features work" warning. Most apps the agent writes are fine; advanced ones (middleware, ISR) need case-by-case. |
| Multi-tenant noisy neighbour on the shared Cloudflare account | Medium | Per-user quotas enforced server-side in `toquemedia-studio-api`: max-instances, R2 storage cap, D1 size cap. Cloudflare Workers limits apply per-script, so blast radius is naturally bounded. |
| D1 storage cap (10 GB/db) hit by an active app | Low | Document the cap. Per-tenant DB strategy means one user's growth doesn't affect others. 50k dbs per account is generous. |
| Cohort A users' v1 deploys break during dual-mode | High | Keep v1 endpoints behind `planVersion: 1` for 6 months; never silently mutate v1 records; explicit migration UI. |
| Agent-generated Dockerfile wrong for less-common languages | Medium | Phase 5 starts with Python + Go (well-known templates). Less common (Java/Ruby) ship with agent + validation loop. |
| GIP per-tenant cost ramps unexpectedly | Medium | Identity Platform pricing is per-MAU + per-method. Free tier covers up to 50k MAU. Alert at 80% of free tier. |
| Custom domain CNAME race with Cloudflare hostname API | Low | 60s eventual consistency tolerated; surface status in DeploysSection. |
| Artifact storage growth across all users | Medium | Server-side cleanup: keep last 3 image refs per app; older purged on schedule. |
| Adapter install (cf-ssr) breaks user build | Medium | `provision_deploy` git-stashes before changes; restores on failure. |

---

## 14. Files to create / edit (snapshot for resume)

**Frontend (`src/`):**
- `services/deploy/runtimeDetector.ts` — new
- `services/deploy/deployPlan.ts` — new (types + persist/load)
- `services/deploy/strategies/staticSpa.ts` — new
- `services/deploy/strategies/cfSsr.ts` — new
- `services/deploy/strategies/workersContainer.ts` — new
- `services/deploy/strategies/composite.ts` — new
- `services/deployService.ts` — refactor: dispatcher by `plan.kind`
- `services/agent/commands/deployCommand.ts` — new `/provision-deploy` slash
- `services/agent/toolExecutor.ts` — register `provision_deploy` tool
- `components/dialogs/PublishModal.tsx` — plan summary + new progress states
- `components/views/settings/DeploysSection.tsx` — service URLs by kind + rollback button
- `stores/deployStore.ts` — new states: `building`, `pushing`, `provisioning`

**Rust (`src-tauri/src/`):**
- `commands/filesystem.rs` — refactor `collect_deploy_bundle` → `collect_deploy_artifacts` (plan-aware)
- `resources/dockerfiles/{node,python,go,rust,ruby,java}.dockerfile` — templates
- `resources/wrangler-templates/{static-spa,cf-ssr,workers-container,composite}.toml` — wrangler.toml seeds

**Backend (`toquemedia-studio-api/`, separate repo):**
- `src/deploy/cloudflare/containers.ts` — wrangler containers SDK wrapper
- `src/deploy/cloudflare/r2.ts` — chunked R2 upload
- `src/deploy/cloudflare/d1.ts` — per-app D1 provisioning
- `src/deploy/cloudflare/kv.ts` — Worker route registration
- `src/deploy/gip-provisioning.ts` — per-app GIP tenant creation (replaces per-user GCP project flow)
- `src/auth/tenant.ts` — new endpoint for `provision_auth`
- Worker `src/router.ts` — generated per-deploy router (replaces v1's per-app Hono)

---

## 15. Definition of done (Phase 1)

- Templates `react-ts-vite`, `vue-ts-vite`, `svelte-ts-vite`, `astro` (static), `angular-ts` deploy from scratch without code changes by the user.
- `.toquemedia-deploy.json` is generated by inference on first publish.
- Free plan sees "Upgrade to deploy" CTA, not the publish flow.
- Existing v1 deploys keep working unchanged (`planVersion: 1` path).
- Per-app GIP tenant created in shared GCP project (no new per-user GCP projects).
- E2E: scaffold → write code → publish → fetch `<slug>.toquemedia.net` → assert HTML 200 + GIP auth working.

---

## 16. What this plan does **not** cover

- **Modo Terminal deploy.** By design. Users in Modo Terminal manage their own deploy out-of-band.
- **Bring-your-own Cloudflare account.** All deploys land in the TM Code account; cost attribution is by user via naming + tags.
- **Bring-your-own GCP project.** All tenants land in the TM Code project. Cohort A migration is one-way (data copy, then point at shared).
- **Frameworks not on the templates list.** If the agent writes something exotic (Spring Boot, Rails, .NET), the deploy detector falls back to delegating to the agent. Coverage is best-effort.
- **Cloudflare-internal failures.** When Containers or D1 has an outage, the deploy fails. No multi-cloud fallback.
