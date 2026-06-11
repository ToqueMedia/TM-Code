# AI Pass-through Worker

Dedicated AI data-plane Worker for TM Code.

## Contract

TM Code calls one endpoint only:

```bash
POST /v1/chat/completions
```

The Worker:

- validates `Authorization: Bearer <Firebase ID token or TM session token>`;
- reads the published active AI config from `ACTIVE_AI_CONFIG` KV key `active`;
- falls back to `ACTIVE_AI_CONFIG_JSON` for local development and tests;
- injects/replaces only `body.model` with the active config model;
- injects the active provider API key from the env var named by `apiKeyEnv`;
- forwards the request to the configured provider endpoint;
- returns the upstream status, safe headers, and `upstream.body` directly.

It does not choose provider/model by user, request body, or route. The only request-driven switch is `X-TM-Speed: true` → `speedModel` (when published and the user's plan is eligible; see below). It has no provider routes, retries, SSE wrapper, provider adapter, or AI SDK. The single sanctioned exception to "no stream parsing" is `usage.ts` (see Billing below): an identity transform that OBSERVES the final `usage` chunk — bytes out are byte-identical to bytes in, guarded by tests.

## Billing (single source of truth)

The Worker is the ONLY place token consumption is accounted (2026-06). The IDE
never estimates, corrects, or persists usage — it just displays what the server
reports (`/v1/me` + the headers below).

Per request:

1. **Pre-flight** — one cached (60s/user) Firestore read of `users/{uid}`
   (`userPlan` + `tokenBudget.*`). The same state feeds the cost-budget gate
   AND TM Speed eligibility (no extra round-trips).
2. **Usage capture** — `stream_options.include_usage: true` is injected into
   streaming bodies so the provider returns the real `usage` object in the
   final chunk; `usage.ts` observes it without touching the bytes. Fallback
   when a provider omits usage: a coarse byte estimate.
3. **Commit** — after the stream ends, `ctx.waitUntil` fires an atomic
   Firestore increment of `tokenBudget.tokensConsumed` (and decrements
   `tokenBudget.extraUsageBalance` with a floor at 0 in overage). The TM Speed
   3x multiplier is applied HERE, server-side, only when speed was served.
4. **Headers** — every response carries the pre-flight state for the IDE:
   `X-Plan`, `X-Budget-Status`, `X-Budget-Pct`, `X-Tokens-Consumed`,
   `X-Extra-Tokens`, `X-Cycle-End`.

Rollout is governed by `BUDGET_ENFORCEMENT` (wrangler.toml `[vars]`):

| Mode      | Gate                | Accounting + headers |
|-----------|---------------------|----------------------|
| `off`     | none                | none (kill-switch)   |
| `shadow`  | never blocks        | yes (default)        |
| `enforce` | `rejected` → 402 `tm_budget_exhausted` | yes |

Firestore auth: billing against REAL Firestore **requires** the service
account (`FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`) since the Security
Rules lock-down (2026-06-11): client tokens are denied on `tokenBudget.*`
writes (rules) and on REST reads (App Check enforcement). Without the SA the
worker **disables billing cleanly** (one loud warn, no per-request 403 spam).
The user-token path remains usable only for unit tests (`AUTH_MODE:
test_static`) and the emulator (`firebase_emulator` / `FIRESTORE_REST_BASE`).

For **local dev with billing active**, add the SA to `.dev.vars`:

```bash
# workers/ai-pass-through/.dev.vars
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxx@maiplayer-ac56d.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Plan budgets default to the control-plane constants and can be overridden with
`PLAN_BUDGETS_JSON` (e.g. `{"pro": 20910000}`). The speed multiplier can be
tuned with `TM_SPEED_BILLING_MULTIPLIER` (default 3).

## Active Config

The Control Plane/Admin publishes this JSON to KV:

```json
{
  "provider": "mimo",
  "model": "mimo-v2.5-pro",
  "speedModel": "mimo-v2.5-pro-ultraspeed",
  "baseUrl": "https://api.xiaomimimo.com/v1",
  "chatCompletionsPath": "/chat/completions",
  "authHeader": "api-key",
  "authScheme": "none",
  "apiKeyEnv": "MIMO_API_KEY",
  "enabled": true,
  "updatedAt": "2026-06-09T00:00:00Z"
}
```

`speedModel` is optional and powers TM Speed (`/speed` in the IDE): when a request
arrives with `X-TM-Speed: true`, the Worker injects `speedModel` instead of `model`.
The header is consumed here and never forwarded upstream (all `x-tm-*` request
headers are stripped). Eligibility is enforced server-side from the SAME cached
user state the billing pre-flight reads (`users/{uid}.userPlan`, 60s/user) and
only applies for `pro`/`max`. Any other case — speedModel not published, plan not
eligible, lookup failure — degrades to `model` instead of failing. The response
carries `X-TM-Speed-Applied: true|false` for the IDE's visual indicator; the 3x
billing multiplier is applied server-side in the usage commit (see Billing).

Bearer provider example:

```json
{
  "provider": "minimax",
  "model": "MiniMax-M3",
  "baseUrl": "https://api.minimax.io/v1",
  "chatCompletionsPath": "/chat/completions",
  "authHeader": "Authorization",
  "authScheme": "Bearer",
  "apiKeyEnv": "MINIMAX_API_KEY",
  "enabled": true,
  "updatedAt": "2026-06-09T00:00:00Z"
}
```

## Secrets

Set the provider key as a Worker secret whose name matches `apiKeyEnv`.

```bash
wrangler secret put MIMO_API_KEY
wrangler secret put MINIMAX_API_KEY
```

For Bearer providers, both `sk-test` and `Bearer sk-test` are accepted as secret input; the Worker sends exactly `Authorization: Bearer sk-test`.

## Local Run

```bash
cd workers/ai-pass-through
yarn dev
```

For local config, provider keys live in `workers/ai-pass-through/.dev.vars`.
Seed the local KV with the active config before the first request:

```bash
cd workers/ai-pass-through
cat > /tmp/active-ai-config.json <<'JSON'
{
  "provider": "mimo",
  "model": "mimo-v2.5-pro",
  "baseUrl": "https://api.xiaomimimo.com/v1",
  "chatCompletionsPath": "/chat/completions",
  "authHeader": "api-key",
  "authScheme": "none",
  "apiKeyEnv": "MIMO_API_KEY",
  "enabled": true,
  "updatedAt": "2026-06-10T00:00:00.000Z",
  "updatedBy": "local-dev"
}
JSON
wrangler kv key put active --path /tmp/active-ai-config.json --binding ACTIVE_AI_CONFIG --local --config wrangler.toml
```

## TM Code

Set:

```bash
VITE_AI_WORKER_URL=https://<ai-pass-through-worker-host>
```

`VITE_WORKER_URL` remains for the existing control/admin/auth/deploy/BYOK endpoints.

The OpenAI SDK in TM Code may send `model: "tm-active-model"` because the SDK requires a model field. The Worker always replaces it with the active Control Plane model.

## Curl

```bash
curl -i "$VITE_AI_WORKER_URL/v1/chat/completions" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi"}],"stream":false}'
```

Streaming:

```bash
curl -N "$VITE_AI_WORKER_URL/v1/chat/completions" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Count to three"}],"stream":true}'
```

## Tests

```bash
cd workers/ai-pass-through
yarn test
yarn typecheck
```
