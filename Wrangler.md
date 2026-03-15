Phase 6 Implementation Complete
                                                                                                                                                                                                                                                                               
  Worker Project (/Users/ithustle/dev/deskotp/toquemedia-studio-api/)                                                                                                                                                                                                        

  ┌──────────────────┬─────────────────────────────────────────────────────────────────┐
  │       File       │                             Purpose                             │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ src/index.ts     │ Entry point — CORS, health check, /v1/chat/completions endpoint │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ src/auth.ts      │ Firebase JWT verification via jose library                      │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ src/firestore.ts │ Firestore REST API — reads user plan (free/pro/team)            │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ src/rateLimit.ts │ Per-minute + per-day rate limiting via Cloudflare KV            │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ src/proxy.ts     │ Routes requests to correct provider based on model name         │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ src/types.ts     │ Shared TypeScript interfaces                                    │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ wrangler.toml    │ Cloudflare Worker config (KV binding, vars)                     │
  ├──────────────────┼─────────────────────────────────────────────────────────────────┤
  │ .dev.vars        │ Local dev secrets (not committed)                               │
  └──────────────────┴─────────────────────────────────────────────────────────────────┘

  IDE Changes (exodus-ide/)

  ┌─────────────────────────────────────┬──────────┬─────────────────────────────────────────────────────────────────────────┐
  │                File                 │  Action  │                              What changed                               │
  ├─────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────┤
  │ src/services/auth/firebaseAuth.ts   │ Created  │ Firebase Web SDK init, signIn, signUp, signOut, getIdToken              │
  ├─────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────┤
  │ src/stores/authStore.ts             │ Created  │ Zustand store: user, isAuthenticated, isLoading, persist                │
  ├─────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────┤
  │ src/components/auth/LoginScreen.tsx │ Created  │ Login/signup form, dark theme, error handling                           │
  ├─────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────┤
  │ src/App.tsx                         │ Modified │ Auth flow: loading → login → welcome/main                               │
  ├─────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────┤
  │ src/services/agent/agentService.ts  │ Modified │ Dual-mode: USE_PROXY → Firebase token via Worker; else → direct API key │
  ├─────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────┤
  │ src/components/PromptBar.tsx        │ Modified │ Skips API key dialog in proxy mode                                      │
  ├─────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────┤
  │ package.json                        │ Modified │ Added firebase dependency                                               │
  └─────────────────────────────────────┴──────────┴─────────────────────────────────────────────────────────────────────────┘

  How to configure mode

  Set in .env or .env.local:
  # Production (proxy mode)
  VITE_USE_PROXY=true
  VITE_PROXY_URL=https://toquemedia-studio-api.YOUR-SUBDOMAIN.workers.dev

  # Dev (direct mode — default)
  VITE_USE_PROXY=false

  To deploy the Worker

  cd /Users/ithustle/dev/deskotp/toquemedia-studio-api
  npx wrangler kv namespace create RATE_LIMIT  # copy id to wrangler.toml
  npx wrangler secret put FIREBASE_PROJECT_ID
  npx wrangler secret put MOONSHOT_API_KEY
  npx wrangler secret put OPENAI_API_KEY
  npx wrangler secret put DEEPSEEK_API_KEY
  npx wrangler secret put GEMINI_API_KEY
  npx wrangler deploy
