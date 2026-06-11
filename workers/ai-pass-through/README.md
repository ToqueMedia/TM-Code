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

It does not choose provider/model by user, request body, or route. The only request-driven switch is `X-TM-Speed: true` → `speedModel` (when published and the user's plan is eligible; see below). It has no provider routes, retries, billing parser, stream parser, SSE wrapper, provider adapter, or AI SDK.

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
headers are stripped). Eligibility is enforced server-side: the Worker reads
`users/{uid}.userPlan` via Firestore REST with the caller's own ID token (cached
60s per user) and only applies speed for `pro`/`max`. Any other case — speedModel
not published, plan not eligible, lookup failure — degrades to `model` instead of
failing, and the response carries `X-TM-Speed-Applied: true|false` so the IDE only
applies the 3x billing multiplier when speed was actually served.

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
