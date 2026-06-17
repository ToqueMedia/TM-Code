# TM Code — Canonical Architecture

> **Authoritative system map.** This is the single source of truth for *who owns what* across the
> four TM Code components. Any code or AI agent working in **any** of the repos below should read
> this before reasoning about **models, billing, or streaming**. When this document and a repo's
> CLAUDE.md disagree, this document wins — fix the CLAUDE.md.
>
> Last reconciled: 2026-06-17.

## The four components

| # | Component | Repo | Runtime |
|---|-----------|------|---------|
| 1 | **IDE** | `~/dev/deskotp/exodus-ide` | Tauri 2 + React 18 desktop app |
| 2 | **Data-Plane** (AI pass-through) | `~/dev/deskotp/exodus-ide/workers/ai-pass-through` | Cloudflare Worker |
| 3 | **Control-Plane** | `~/dev/deskotp/toquemedia-studio-api` | Cloudflare Worker |
| 4 | **Web** | `~/dev/web/toquemedia-studio` | Web app / site |

The IDE reaches the Data-Plane over **native browser `fetch` (streaming SSE, CORS)** and the
Control-Plane over **`tauriFetch` (Rust reqwest proxy, CORS-free, non-streaming)**. The two are
resolved by `resolveAIWorkerUrl()` and `resolveWorkerUrl()` respectively (`src/utils/devUrls.ts`).

---

## 1. IDE (`exodus-ide`)

The chat-first desktop client. Runs the agent loop **client-side** (`src/services/agent/`),
renders chat/terminal/editor, and persists per-project sessions/permissions/tasks to disk.

**Does NOT** choose or configure models, do billing accounting, or own provider keys.

- **Model identity** comes from the Data-Plane response header `X-TM-Model`; **context window**
  from `X-Model-Context-Window`. The IDE keeps a small local *capability fallback* table
  (`src/services/agent/modelProfiles.ts`) indexed by model name, used **only** to fill what those
  headers don't carry: `supportsAttachments` (native vision), `supportsThinking`/`thinkingMode`,
  `maxOutputTokens`, `supportsSearch`, and a pre-handshake context-window fallback. Unknown model
  → `getProfileForPlan()` default. **It does not send sampling or thinking params** —
  `agentService.buildThinkingConfig()` returns `undefined`; the Data-Plane injects those.
- **Billing** is *read* from Control-Plane `/v1/me` into `billingStore` for **display only**.

## 2. Data-Plane — AI pass-through (`workers/ai-pass-through`)

The AI plane. Single route: `POST /v1/chat/completions` (everything else → `tm_not_found` 404).
**Provider-agnostic and config-driven** — it hardcodes **no** model names.

Owns:
- **Runtime model routing.** Reads the active config from KV (`ACTIVE_AI_CONFIG` namespace, key
  `active`; local fallback env `ACTIVE_AI_CONFIG_JSON`). Overrides the request `model` with
  `config.model` (or `config.speedModel` on `X-TM-Speed`), injects the provider key, and merges
  `config.extraBody` (e.g. `thinking:{type}` for z.AI, `enable_thinking` for DashScope,
  `reasoning_effort`, `enable_search`) into the request body. Emits `X-TM-Model`,
  `X-Model-Context-Window`, `X-TM-Provider`, `X-TM-Config-Key`.
- **Streaming** (SSE) to the IDE.
- **Billing metering** — per-request token *accounting*: atomic Firestore increments of
  `tokenBudget.tokensConsumed` / `overageConsumed` / `lifetimeTokensConsumed`, plus enforcement
  (`billing.ts`). **Single source of truth for consumption.** Never reintroduce client-side
  counting. (Cycle *lifecycle* — reset/carry-over/anchoring — is the Control-Plane's; see below.)
- **Sidecars** — `X-Request-Type` → KV `sidecar:*` configs (vision / web_search / utility / fim).

> **Adding / removing a model = a KV-data edit, not a code change.** Publish/edit the `active`
> config JSON (`{provider, model, baseUrl, chatCompletionsPath, authHeader, authScheme, apiKeyEnv,
> enabled, contextWindow, extraBody}`) and ensure the provider API-key secret exists
> (`wrangler secret put`). The worker source never needs touching. Locally, set
> `ACTIVE_AI_CONFIG_JSON` in `.dev.vars`.

## 3. Control-Plane (`toquemedia-studio-api`)

Everything that is **not** the AI request path:
- Auth (Firebase JWT verify), **App Check** minting (`/v1/appcheck-token`).
- Deploys / build orchestration, per-project DB & files (R2 / D1 / Turso), device registration.
- **Admin model *catalog*** — `/v1/admin/models` (the selectable list shown in the IDE admin),
  `/v1/admin/ai/active-config` (publishes the Data-Plane KV `active` config), sidecars, verify.
- BYOK validation (`/v1/byok/*`).
- **Billing — read + cycle lifecycle.** `/v1/me` (via `summarizeBilling`) returns state for the
  IDE/Web to display. The same read path (`getUserData`, `firestore.ts`) **also writes**: when it
  detects an expired cycle (`cycleExpired`) it lazily PATCHes a fresh `tokenBudget`
  (cycle reset + `billingAnchorDay` + carry-over of unpaid overshoot + plan-change budget). It uses
  per-field `updateMask` (never whole-map replace) so it never clobbers the Data-Plane's metering
  fields.

**Does NOT** (by design) do: per-request token **metering** (Data-Plane), streaming, or **runtime**
model routing. So billing is *split*: Data-Plane meters consumption; Control-Plane manages the
cycle and serves the read. The Control-Plane's own `commitTokenConsumption` is the runtime-dead
metering leftover (see below).

> **Nuance (clarified 2026-06-17).** "Control-plane should not handle models" means **runtime
> routing + streaming** (Data-Plane). The admin model **catalog CRUD** legitimately stays in the
> Control-Plane — it's the source of `/v1/admin/models`. Two GLM-5.2 entries (one per provider,
> z.AI + DashScope) would be added there, each with its own `activeConfig`.
>
> The metering functions `checkCostBudget` and `commitTokenConsumption` in the Control-Plane
> `billing.ts` are **runtime-dead** (no callers; superseded by the Data-Plane). They are slated for
> removal but were left in place because the repo was mid-refactor (branch
> `chore/deploy-v2-phase0-remove-worker`) with uncommitted work on them. `summarizeBilling` / `/v1/me`
> remain **live**.

## 4. Web (`toquemedia-studio`)

The public web app / marketing & account site. (Billing CFs / plan stamping interplay documented
in the IDE's billing memories.)

---

## Cross-cutting rules

- **`curl` against the Data-Plane proves nothing about the browser path** (CORS + SSE differ).
  Login/billing can work while AI silently fails, and vice-versa.
- **Billing is split:** Data-Plane is the single source of truth for *metering* (per-request
  consumption); Control-Plane owns the *cycle lifecycle* (reset/carry-over/anchoring, written
  lazily on the `/v1/me` read path) and serves the read for IDE/Web display. Both patch the same
  Firestore `tokenBudget` map but **different fields**, via per-field `updateMask`.
- **Model add/remove never edits worker code** — it's KV config (Data-Plane) + catalog
  (Control-Plane admin).

## Adding / removing a managed model — end-to-end checklist

The recurring confusion: a model lives in **more than one place**. To add a managed model
(e.g. GLM-5.2 from two providers) so it both *appears* in the admin and *works*:

1. **Catalog (Control-Plane, `controlPlaneModels.ts`)** — add a `ControlPlaneModel` entry per
   provider (`{id, name, providerLabel, category:'coder', activeConfig:{provider, model, baseUrl,
   chatCompletionsPath, authHeader, authScheme, apiKeyEnv, enabled, contextWindow, extraBody}}`).
   This is what `/v1/admin/models` returns → the IDE admin dropdown. **Two entries with the same
   `name` but different `providerLabel`** render as "GLM-5.2 (Alibaba US)" / "GLM-5.2 (z.AI)".
   - Update the catalog-count assertion in `src/__tests__/admin.test.ts` (`body.models.length`).
2. **Provider secret (Data-Plane)** — the `apiKeyEnv` (e.g. `ZAI_API_KEY`) must exist as a worker
   secret (`wrangler secret put` in prod; `.dev.vars` locally). Without it the entry still *appears*
   but fails when selected.
3. **IDE capability profile (`modelProfiles.ts`)** — needed **only if** the model's capabilities
   (vision / thinking / maxOutput) differ from the plan fallback. Key it by the name the
   Data-Plane reports in `X-TM-Model`. (Until the header-driven refactor below, this is the one
   IDE touch-point.)
4. **Publish & verify** — selecting the model in the admin calls `/v1/admin/ai/active-config`,
   which writes the KV `active` config the Data-Plane reads. `thinking`/`reasoning_effort`/
   `enable_thinking` go in `activeConfig.extraBody` (the IDE never sends them).

**Local test → prod (the real workflow):** run the Control-Plane (`yarn dev` →
`wrangler dev --persist-to ../exodus-ide/.wrangler/shared-state`, port 8787) — it shares KV state
with the local Data-Plane (`yarn dev:ai-worker`, 8788). The IDE in `yarn tauri dev` reads the local
catalog. When verified, **deploy the Control-Plane** (`yarn deploy` → `wrangler deploy --env
production`) so production IDEs see the new catalog, and set any new provider secret in prod.

## Known improvement — header-driven IDE (deferred)

Today the IDE needs a `modelProfiles.ts` entry for a model **only** because the Data-Plane does not
emit model *capabilities*, just name + context window. If the Data-Plane also emitted
`X-Model-Supports-Vision`, `X-Model-Supports-Thinking`, and `X-Model-Max-Output-Tokens`, the IDE
capability table would collapse to a single default and **adding/removing a model would never touch
the IDE**. Until then, a new managed model needs a `modelProfiles.ts` entry **iff** its capabilities
differ from the plan fallback.
