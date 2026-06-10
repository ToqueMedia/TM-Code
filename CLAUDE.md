# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TM Code — a chat-first desktop IDE (Tauri 2 + React 18 + TypeScript + Zustand + Chakra UI) where an AI agent is the primary interface. The frontend lives in `src/`, the Rust shell in `src-tauri/`, and an in-repo Cloudflare Worker in `workers/ai-pass-through/`.

## Commands

```bash
yarn dev                      # Vite dev server (frontend only)
yarn tauri dev                # full app in dev mode
yarn test                     # Jest (ts-jest, jsdom)
yarn test src/stores/__tests__/chatStore.test.ts        # single test file
yarn test -t "name pattern"   # single test by name
yarn test:ai-worker           # worker tests (vitest, in workers/ai-pass-through)
yarn build                    # tsc + vite build (type-checks; use to validate TS)
yarn tauri:build:mac-arm64    # release build M1 (scripts/build.mjs → .dmg; artifacts copied to ~/Desktop/builds-desktop/v<version>/)
yarn tauri:build:win-x64      # release build Windows
yarn dev:ai-worker            # run the AI worker locally (wrangler, port 8788)
```

There is no lint script; `tsc` (via `yarn build`) is the correctness gate. Releases are cut by tagging — CI (`.github/workflows/release.yml`) builds and uploads; never push a tag without an explicitly requested release.

## Architecture

### Two backends, two transports (critical to understand)

The app talks to **two separate Cloudflare Workers** over **two different transports**:

1. **Control-plane** — `https://api-agents.toquemedia.net` (separate repo `~/dev/deskotp/toquemedia-studio-api`). Auth, App Check minting (`/v1/appcheck-token`), billing (`/v1/me`), deploys, per-project DB/files, admin. Called via **`tauriFetch`** (`src/services/tauriFetch.ts`) which proxies through the Rust `http_client_request` command (reqwest) — CORS-free, non-streaming only. Resolved by `resolveWorkerUrl()`.
2. **AI data-plane** — `https://ai-pass-through-worker.geral-871.workers.dev` (source in `workers/ai-pass-through/`). Single route: `POST /v1/chat/completions`; everything else returns `tm_not_found` 404. Called via the **OpenAI SDK with native browser `fetch`** (streaming SSE) from the webview origin `http://localhost:14300` — subject to CORS. Resolved by `resolveAIWorkerUrl()`. The worker validates the Firebase JWT, injects the active provider key/model from KV, and proxies upstream.

Consequence: `curl` tests prove nothing about the browser path, and login/billing can work while AI silently fails (or vice-versa).

### URL resolution and env-leak guard

`src/utils/viteEnv.ts` centralizes all `import.meta.env` reads (Jest can't parse `import.meta`; tests mock this module via `src/utils/__mocks__/viteEnv.ts` — never read `import.meta.env` directly in code that tests import). `src/utils/devUrls.ts` resolves URLs; in production builds it ignores leaked localhost/`192.168.64.1` env values and falls back to production URLs. `scripts/build.mjs` force-sets `VITE_USE_EMULATORS=false` and `VITE_WORKER_URL` for release builds. The local `.env` is gitignored and contains duplicate keys (last-wins) — local overrides at the bottom.

### Auth flow

`src/services/auth/firebaseAuth.ts` is the hub (singleton `FirebaseAuthService`). Firebase Auth has **App Check enforcement ON**: before sign-in the app must mint an App Check token via control-plane `POST /v1/appcheck-token` (auth-less, IP rate-limited) through a `CustomProvider`. Firebase project: `maiplayer-ac56d`. The Firebase ID token is then used as Bearer for both workers (it is the OpenAI SDK `apiKey`). Billing state comes from `/v1/me` (event-driven: launch, window focus, post-purchase — never polled) into `src/stores/billingStore.ts`; token consumption is persisted to Firestore after each agent run.

### Agent loop

`src/services/agent/agentService.ts` orchestrates: gets ID token → `createAgentClient` (`sdkClient.ts`, normalizes baseURL to end in `/v1`) → `QueryEngine` (`queryEngine.ts`) runs the streaming tool-call loop with `refreshClient` for token expiry. Tool execution goes through `toolExecutor.ts` gated by `permissionStore` (per-project grants persisted in `permissions.json`). System prompt assembly lives in `contextBuilder/`. Slash commands for terminal mode live in `cmdModeCommands.ts`. Conversation compaction in `compact/`, agent memory in `memory*.ts`.

### State

Zustand stores in `src/stores/` — one store per domain (`chatStore` sessions/messages/streaming, `agentStore` status/tasks, `billingStore` plan/tokens, `permissionStore`, `terminalPanelStore` PTY instances, etc.). Components subscribe with selectors; services mutate via `useXStore.getState()`. Sessions, drafts, permissions, and tasks are persisted per-project on disk via services, not in the stores.

### UI modes

`MainLayout.tsx` switches between Welcome, Chat mode (`components/chat/`), and Terminal/CMD mode (`components/cmd-mode/`, entry `TerminalView.tsx`). Both chat surfaces render the same `chatStore` data. The embedded PTY terminal panel (xterm.js) is separate from CMD mode. Editor is Monaco (`components/editor/`).

### Rust side

`src-tauri/src/commands/` — one module per domain (terminal/PTY, filesystem, git, search, deploy, MCP, sandbox...), registered in `lib.rs`. Frontend invokes via `@tauri-apps/api` `invoke` (wrapped by `src/utils/invokeMetrics`). DevTools is enabled even in release builds (right-click → Inspect) — use it to debug production issues.

## Conventions

- i18n: user-facing strings go through `useTranslation()` / `t('key')` (`src/i18n/translations.ts`). UI copy is bilingual; much of the codebase's comments and commit messages are in Portuguese.
- Theme: use `tokens` from `src/theme/tokens.ts` (terminal colors, mono font) rather than hard-coded values.
- Tests live in `__tests__/` folders next to the code. Worker tests use vitest and run separately (`yarn test:ai-worker`).
- Files routinely carry long "why" comments documenting race conditions and past bugs — preserve and follow that style; many effects/guards exist for non-obvious reasons explained inline.
