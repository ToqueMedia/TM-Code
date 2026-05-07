# PLAN-DEPLOY-V2

**Status:** deferred to a future major version. The current Cloudflare-only deploy path is being **hidden** from the UI as of 2026-05-07 to avoid misleading users while the universal pipeline is built. The underlying code (PublishModal, deployStore, deployService, `collect_deploy_bundle` Rust command, DeploysSection) is preserved on-disk as the starting point for the v2 implementation — only the entry points (button, keyboard shortcut, settings nav) were removed.

This document captures the architecture, decisions, and trade-offs reached during planning so the work can resume cold.

---

## 1. Why v1 deploy was hidden

The current pipeline assumes a single shape: `<project>/dist/` (Vite-style assets) + optional `backend/dist/worker.js` (Hono Worker for Cloudflare Workers) + optional Drizzle schema for D1. That covers ~4 of the 11 templates the IDE scaffolds, and **none** of the long-running Node servers (`express-ts`, `fastify-ts`, `nestjs-ts`) the agent can produce. Showing a "Publish" button on a project that fundamentally cannot deploy was misleading. v2 must support **anything the agent can write**.

---

## 2. Goal

Any project the agent can scaffold or write — Vite SPA, Next/Nuxt/SvelteKit/Astro (static or SSR), Angular, Express/Fastify/NestJS, FastAPI, Gin, Axum, Rails, Spring, etc. — deploys with one click in the `PublishModal`, behind a single public URL `<slug>.toquemedia.net`. The user never sees "which provider".

## 3. Confirmed decisions

| # | Question | Decision |
|---|---|---|
| 1 | GCP topology | **Multi-tenant**: single shared GCP project. Per-user isolation via service naming (`tmcode-{userId}-{slug}`), Artifact Registry namespace, IAM labels for cost attribution, quotas enforced server-side in `toquemedia-studio-api`. |
| 2 | Plan gating | **Paid only**: `explorer` (free) cannot deploy. Backend `init` returns 403; frontend swaps "Publish" for an upgrade CTA. |
| 5 | Custom domain | **Frontend-only at user level**, but routed through Cloudflare for *all* deploy kinds (incl. API-only). Cloud Run URL is internal; Cloudflare Worker is always the public front-door. Cloud Run domain mappings are not used. |

API-only deploys still get `<slug>.toquemedia.net` and custom domain support — the Worker proxies everything to Cloud Run in `pass-through` mode. Same UX as any other public site.

### Open (assumed defaults to revisit when work resumes)

| # | Question | Default |
|---|---|---|
| 3 | Build location | Local Docker on user host (Container Code already requires Docker); fall back to Cloud Build only if multi-lang build fails. |
| 4 | Versioning / rollback | Keep last 3 Cloud Run revisions per service; one-click rollback in DeploysSection. |
| 6 | Dev parity for `/api` proxy | Yes — Worker route map mirrors the dev-mode Vite proxy exactly so behavior is identical local vs prod. |

---

## 4. Architecture

```
                       Cloudflare Worker (router, multi-tenant, KV-backed)
                       ┌──────────────────────────────────────────────┐
<slug>.toquemedia.net  │ /api/*    → fetch(cloudRunUrl)               │  → Cloud Run service
                       │ /__auth/* → GIP                              │  → GCP Identity Platform
                       │ /*        → R2 (assets) or Worker SSR        │  → Pages assets / Worker SSR
                       └──────────────────────────────────────────────┘
```

Key shift: the Worker becomes a **router**, not a runtime. The user's backend code never runs in Workers anymore — it runs in Cloud Run.

## 5. `DeployPlan` (central type)

```ts
type DeployPlan =
  | { kind: 'static-spa'; outputDir: string; spaFallback?: string }
  | { kind: 'cf-ssr'; adapter: 'sveltekit'|'nuxt'|'astro'|'next-on-pages'; assetsDir: string; workerEntry: string }
  | { kind: 'cloud-run'; runtime: Runtime; port: number; minInstances: 0|1; proxyMode: 'pass-through' }
  | { kind: 'composite'; frontend: StaticOrSsrPlan; backend: CloudRunPlan; apiPrefix: string }

type Runtime =
  | { lang: 'node'; version: '18'|'20'|'22' }
  | { lang: 'python'; version: '3.11'|'3.12' }
  | { lang: 'go'; version: '1.22' }
  | { lang: 'rust'; edition: '2021' }
  | { lang: 'ruby'|'java'|'php'|'dotnet'; version: string }
  | { lang: 'auto' }
```

Persisted in `.toquemedia-deploy.json` at project root (separate from `.toquemedia-template`, which records the scaffold). Allows manual override and survives rebuilds.

## 6. Worker route KV schema

```ts
type RouteEntry =
  | { kind: 'static'; assetsPrefix: string }
  | { kind: 'cf-ssr'; workerBindingName: string }
  | { kind: 'cloud-run'; cloudRunUrl: string; cacheable: boolean }
  | { kind: 'composite'; cloudRunUrl: string; apiPrefix: string; assetsPrefix: string }
```

API-only user → `cloud-run` entry (proxies all traffic). Fullstack user → `composite` entry (proxies `/api/*` to Cloud Run, serves rest from R2). Identical custom-domain flow regardless.

## 7. Runtime detection

`src/services/deploy/runtimeDetector.ts` — pure function over `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`/`build.gradle`. Inferences below; fallback delegates to the agent via an `inferDeployPlan` skill.

| Signal | Plan |
|---|---|
| `package.json` + `next` | `cf-ssr` adapter `next-on-pages` |
| `package.json` + `nuxt` | `cf-ssr` adapter `nuxt` |
| `package.json` + `@sveltejs/kit` | `cf-ssr` adapter `sveltekit` |
| `astro.config.*` + `output: 'server'` | `cf-ssr` adapter `astro` |
| `package.json` + Express/Fastify/Nest, no adapter | `cloud-run` Node |
| `package.json` Vite-only (no SSR) | `static-spa` |
| `requirements.txt` ∨ `pyproject.toml` | `cloud-run` Python |
| `go.mod` | `cloud-run` Go |
| `Cargo.toml` with `[[bin]]` | `cloud-run` Rust |
| Monorepo (`workspaces` or `client/server` dirs) | `composite` (recurse per subdir) |

## 8. New agent tool: `provision_deploy`

Mirrors the existing `provision_auth`. Idempotent. Behavior by plan kind:

- **static-spa**: validate that `npm run build` produces `outputDir`.
- **cf-ssr**: install Cloudflare adapter (`@sveltejs/adapter-cloudflare`, etc), edit framework config to use the Cloudflare preset, adjust `package.json` build script.
- **cloud-run**: generate `Dockerfile` from `src-tauri/resources/dockerfiles/<runtime>.dockerfile` template; for `runtime: 'auto'`, delegate to the agent. Add `.dockerignore` if absent.
- **composite**: recurse.

Writes `.toquemedia-deploy.json` at the end. Does not touch app code.

## 9. Build & push (frontend)

Reuses `containerService` (Docker is already a Container Code requirement):

```
1. Backend mints short-lived Artifact Registry credentials
2. IDE: docker build -t <registry>/<image>:<sha> .
3. IDE: docker login + docker push (logs streamed to PublishModal)
4. IDE: POST /v1/projects/deploy/cloudrun/deploy { imageUrl, runtime, port, minInstances }
```

Failure modes: build error (show stderr in modal, don't deploy), push 401/network (retry, distinguish token expiry from network), image >2 GB (suggest `.dockerignore` + multi-stage).

## 10. Backend changes (`toquemedia-studio-api`)

Existing 4 phase endpoints stay for `planVersion: 1` retro-compat. New endpoints:

```
POST /v1/projects/deploy/init
  body: { projectId, plan: DeployPlan }
  returns: { slug, authConfig, gcp?: {...}, cloudflare?: {...} }
  effect: rejects free plan; provisions GCP resources (idempotent: enable APIs, create AR repo, mint deployer SA token)

POST /v1/projects/deploy/cloudrun/deploy
  body: { projectId, slug, imageUrl, runtime, port, minInstances, envVars }
  returns: { serviceUrl, region }
  effect: gcloud run deploy + KV update (Worker route map → /api/* → serviceUrl)

POST /v1/projects/deploy/finalize
  effect: persist plan + cloudRunServiceUrl in Firestore deploy record
```

GCP plumbing inside `init`:
1. Reuse the per-user GCP project that `provision_auth` already creates (GIP is unchanged).
2. Idempotently enable: `run.googleapis.com`, `artifactregistry.googleapis.com`, `cloudbuild.googleapis.com` (future).
3. Create Artifact Registry repo `<projectId>-images` if absent.
4. Reuse / create deployer service account `tmcode-deployer@<gcp-project>.iam`.
5. Mint a 1h short-lived token for the IDE to push images.

## 11. Cleanup of v1 path (Phase 0 — pre-requisite)

To keep the codebase coherent before adding v2 strategies, the Hono-as-runtime path must go. **This is the work that v2 implementation will start with**, not what was done as part of this hide-the-button task.

**Frontend:**
- `deployService.ts` — `callPhase('worker', ...)` and `hasWorker` flag → removed in v2 path
- `DeployBundle.worker_file` interface → removed

**Rust (`src-tauri/src/commands/filesystem.rs`):**
- `DeployBundle.worker_file` field → removed
- Lines 393-435 (worker.js discovery + `has_backend && worker_file.is_none()` validation) → removed
- `walk_collect` stays; `worker.js` strip becomes unnecessary

**Skills / agent commands:**
- `provision_auth` tool → refactor: handles **only** GIP tenant + env vars (`VITE_FIREBASE_*`, `GIP_*`). Stops installing the Hono boilerplate at `backend/`. Backend can now be any language; `provision_auth` cannot assume Hono.
- `auth-proxy-gip` skill → keep (still valid for dev mode with Vite proxy `/api`)
- New `provision_deploy` tool covers what `provision_auth` previously did for Hono, but runtime-aware

**Backend (`toquemedia-studio-api`):**
- `/v1/projects/deploy/worker` → deprecate, then remove
- Worker bundle upload code → remove
- D1 binding logic → re-evaluate. **Recommendation: migrate the default DB to Cloud SQL Postgres** in the shared GCP project, with per-user schema isolation. Natural fit for Cloud Run, single cloud for backend infra. `provision_auth` server-side stops creating D1; creates Postgres schema instead.

**Templates:**
- `react-express-ts` → keep (already plain Express, no Worker). ✅
- `src-tauri/resources/auth-boilerplate/` (Hono) → audit: if used by any active scaffold, replace with a generic Express + GIP SDK boilerplate, or remove and let the agent write the backend from scratch using GIP env vars.

## 12. Phasing

| Phase | Scope | Effort | Cumulative coverage |
|---|---|---|---|
| **0** | Cleanup (v1 Worker path removal, `provision_auth` slim down) | 3-4 days | — |
| **1** | Detector + `static-spa` strategy + plan gating + DB migration | 1-2 weeks | 4/11 templates |
| **2** | `cf-ssr` (SvelteKit, Nuxt, Astro-SSR) | 2 weeks | 6/11 templates |
| **3** | `cloud-run` Node (Express/Fastify/NestJS) + Worker router KV + multi-tenant GCP setup | 4 weeks | 10/11 templates |
| **4** | `composite` (monorepo) | 1 week | 11/11 templates |
| **5** | Multi-lang Cloud Run (Python/Go/Rust/Ruby/Java) | 1 week | anything the agent writes |
| **6** | `next-on-pages` (Next.js — edge-runtime caveats) | 2 weeks | includes Next |

Phase 0 must precede everything else.

## 13. Critical risks

| Risk | Severity | Mitigation |
|---|---|---|
| Docker not available on host | High | Detect early in `RequirementsCheckDialog`; offer install via Container Code flow |
| Multi-tenant GCP noisy neighbor | High | Per-user max-instances cap enforced server-side; Cloud Monitoring alerts |
| Cold-start perceived as broken deploy | High | UX: "First request may take ~2s after deploy". Min-instances=1 available on paid tiers |
| Image build >5min for big projects | Medium | Stream logs; cancel button; suggest `.dockerignore` |
| Cost runaway on malicious project | High | Cloud Run quotas: max-instances=10 default, 256Mi mem, 1 vCPU. Free deploy disabled. |
| Adapter install breaks user build | Medium | `provision_deploy` auto-stashes git state before changes; restore on failure |
| KV write race between parallel deploys | Low | Versioned deploys; tolerate 60s eventual consistency |
| Artifact Registry storage cost growth | Medium | Server-side cleanup: keep last 3 images per project |
| Agent-generated Dockerfile wrong | Medium | Phase 5 starts with Python+Go (known templates); rest via agent + validation |
| Next.js next-on-pages incompat | High | Phase 6 separate; honest fallback "not supported, use Vercel" until proven |
| D1→Postgres migration for existing users | Medium | Detect `planVersion: 1`; offer one-click migration; keep D1 read-only during transition |
| Active Hono boilerplate users | Medium | Audit existing deploys; if >0, ship migration script (Hono → Express + GIP SDK) before sunset |
| API-only user confused by `<slug>.toquemedia.net` instead of Cloud Run URL | Low | DeploysSection labels "API URL" prominently; Cloud Run URL only in Advanced/debug |

## 14. Files to create / edit (snapshot for resume)

**Frontend (`src/`):**
- `services/deploy/runtimeDetector.ts` — new
- `services/deploy/deployPlan.ts` — new (types + persist/load)
- `services/deploy/strategies/staticSpa.ts` — new
- `services/deploy/strategies/cfSsr.ts` — new
- `services/deploy/strategies/cloudRun.ts` — new (depends on `containerService`)
- `services/deploy/strategies/composite.ts` — new
- `services/deployService.ts` — refactor: dispatcher by `plan.kind`
- `services/agent/commands/deployCommand.ts` — new `/provision-deploy` slash
- `services/agent/toolExecutor.ts` — register `provision_deploy` tool
- `components/dialogs/PublishModal.tsx` — plan summary + new progress states
- `components/views/settings/DeploysSection.tsx` — service URLs by kind
- `stores/deployStore.ts` — new states: `building`, `pushing`, `provisioning`

**Rust (`src-tauri/src/`):**
- `commands/filesystem.rs` — refactor `collect_deploy_bundle` → `collect_deploy_artifacts`
- `commands/deploy.rs` — new: `docker_build_and_push` (wraps `containerService`)
- `resources/dockerfiles/{node,python,go,rust,ruby,java}.dockerfile` — templates

**Backend (`toquemedia-studio-api/`, separate repo):**
- `src/deploy/cloudrun.ts` — gcloud SDK wrapper
- `src/deploy/router-kv.ts` — Worker route registration
- `src/deploy/gcp-provisioning.ts` — APIs enable + AR + SA
- Worker `src/router.ts` — replaces per-app Hono

## 15. Definition of done (Phase 1)

- Templates `react-ts-vite`, `vue-ts-vite`, `svelte-ts-vite`, `astro` static-mode deploy without code changes
- `angular-ts` deploys with correct flatten of `dist/<app>/`
- `.toquemedia-deploy.json` is generated by inference on first publish
- Existing v1 deploys keep working (`planVersion: 1` path)
- Free plan sees "Upgrade to deploy" CTA, not the publish flow
- E2E: scaffold → write code → publish → fetch URL → assert HTML 200

---

**Last updated:** 2026-05-07. Reopen this doc when ready to start Phase 0.
