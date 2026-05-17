# CLAUDE.md

**Ler sempre o código a cada pergunta/dúvida/questionamento do user sobre o projecto.** Nunca responder com base em memória, suposição ou descrição de arquitectura — abrir os ficheiros relevantes, confirmar o estado actual, e só depois responder. Se houver discrepância entre o que se "lembra" e o que está no código, o código é a fonte de verdade.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TM Code** (internal name: `toquemedia-studio`) — an **AI Agent-First desktop IDE** built with **Tauri 2** (Rust backend) + **React 19** (TypeScript frontend).

Unlike Cursor/VS Code (editor-first, AI in sidebar), TM Code is **chat-first**: the developer starts in a conversational interface where the AI agent writes code, shows diffs inline, displays progress, and opens a live preview — all without leaving the chat. The Monaco editor is available as a secondary mode for manual editing.

**UX flow:** Open project → Chat (default) → Agent works (diffs + preview visible) → Switch to Editor mode if needed → Back to Chat.

> **Naming:** UI-visible text uses "TM Code". Internal identifiers (config dirs, Cargo.toml, tauri.conf.json) remain `toquemedia-studio` to avoid breaking existing user data.

## Common Commands

```bash
# Development
yarn install              # Install dependencies (uses Yarn 1.22.22, NOT npm)
npm run tauri dev         # Run full app in development mode (Vite + Tauri)
npm run dev               # Frontend-only dev server (port 1420)

# Build
npm run build             # TypeScript check + Vite build
npm run tauri build       # Full production build

# Testing
npm test                  # Jest unit tests
npm test -- --testPathPattern="path/to/test"  # Run single test file
npm run test:watch        # Jest watch mode
npm run test:coverage     # Jest with coverage
npm run benchmark         # Performance benchmarks
```

## Architecture

```
Frontend (React/TS)  ──Tauri IPC──>  Backend (Rust)  ──>  OS/Filesystem
```

### Frontend → Backend Communication
Frontend calls Rust functions via Tauri's `invoke()`. All backend commands are registered in `src-tauri/src/lib.rs`. Service files in `src/services/` wrap these invocations.

### Key Layers

- **Components** (`src/components/`): React UI organized by domain:
  - `CodeEditorNew.tsx` — main IDE layout orchestrator (activity bar + sidebar + editor + chat + terminal)
  - `WelcomeScreen.tsx` — landing/onboarding page
  - `chat/` — chat panel, message bubbles, agent status, diff preview, tool call display, slash command menu, reasoning blocks, plan approval
  - `editor/` — split editor layout with draggable reorderable tabs, editor workspace, context menu, Xcode-style navigation
  - `views/` — main view containers (ChatView, EditorView, PreviewView, SettingsView), generation status, source control, containers panel
  - `prompt/` — prompt textarea, actions, and `usePromptBar` hook
  - `http-client/` — Postman-like HTTP testing panel (request builder, key-value editor, JSON body editor, response viewer)
  - `ui/` — 50+ reusable components: title bar, status bar, activity bar, Monaco editors, file tree, search panel, terminal (xterm.js v6), command palette, quick open, breadcrumbs
  - `dialogs/` — new/open project, preferences, requirements check
  - `welcome/` — welcome screen, sidebar, hero, clone dialog
  - `debugger/` — DAP debugger UI (breakpoints, call stack, variables, console)
  - `auth/` — Firebase login screen

- **Stores** (`src/stores/`): Zustand state (19 stores):
  - Core: `projectStore.ts`, `editorStore.ts`, `settingsStore.ts`, `fileTreeStore.ts`, `fileTreeWorkerStore.ts`
  - Chat/Agent: `chatStore.ts`, `agentStore.ts`, `skillStore.ts`, `mcpStore.ts`, `checkpointStore.ts`, `permissionStore.ts`
  - Layout: `layoutStore.ts`, `terminalStore.ts`, `toastStore.ts`, `problemsStore.ts`
  - Features: `containerStore.ts`, `authStore.ts`, `aiCompletionStore.ts`, `httpClientStore.ts`

- **Services** (`src/services/`): Tauri command wrappers and business logic:
  - File/Project: `fileService.ts`, `fileTreeService.ts`, `projectService.ts`, `templateService.ts`, `postScaffoldPipeline.ts`
  - Editor: `formatterService.ts` (Prettier), `typescriptLspService.ts`, `searchService.ts`, `quickOpenService.ts`
  - Runtime: `debuggerService.ts`, `terminalService.ts`, `devServerManager.ts`, `containerService.ts`
  - Agent (`agent/`): `agentService.ts` (orchestration loop), `agentRunner.ts`, `toolExecutor.ts` (permissions + .env protection), `contextBuilder.ts`, `streamParser.ts` (SSE + reasoning blocks), `diffService.ts`, `sessionService.ts`, `checkpointService.ts`, `skillService.ts`, `slashCommandRegistry.ts`, `staticPreviewBuilder.ts`
  - Agent commands (`agent/commands/`): `initCommand.ts` (`/init`), `planCommand.ts` (`/plan`), `paymentsCommand.ts` (`/payments`)
  - AI: `aiCompletionService.ts` (Ollama FIM autocomplete)
  - MCP: `mcp/mcpService.ts`, `mcp/remoteTransport.ts`
  - Auth: `auth/firebaseAuth.ts`, `auth/emulatorConfig.ts`
  - Utilities: `windowService.ts`, `fileWatcherService.ts`, `unsavedChangesService.ts`, `environmentCheck.ts`, `recoveryService.ts`, `gitService.ts`

- **Rust Commands** (`src-tauri/src/commands/`): `project.rs`, `filesystem.rs`, `file_tree.rs`, `terminal.rs`, `search.rs`, `debugger.rs`, `checkpoint.rs`, `container.rs`, `devcontainer.rs`, `mcp.rs`, `git.rs`, `ai_completion.rs`, `http_client.rs`. Module exports in `mod.rs`.

### Rust State Management (`lib.rs`)
Tauri manages shared state via `app.manage()`:
- `HttpClientState` — reqwest client with 4s timeout
- `TerminalState` — command history + process map
- `ContainerState` — container map + active container
- `DebuggerState`, `McpState`, `FimState`
- OAuth domain whitelist for CSP

### Data Persistence
- Project metadata: `~/.config/toquemedia-studio/projects/{project-id}/meta.json`
- Global settings: `~/.config/toquemedia-studio/settings.json`
- Chat sessions: `~/.toquemedia-studio/sessions/{project-hash}/session_*.json`
- Project ID file: `.toquemedia-id` in project root

### Dev Server Architecture
- **Single-slot model**: one dev server per project. `layoutStore.devServer` holds `{ pid, projectKind, frontendUrl, backendUrl, status }`. Managed by `devServerManager`.
- **Project kinds**: `frontend` (UI only → iframe preview), `backend` (API only → HTTP Client panel fills main area), `fullstack` (both — iframe with HTTP Client in a resizable bottom drawer, toggle Cmd/Ctrl+Shift+H).
- **Natural ports** (May 2026 refactor): the framework picks the port (Vite=5173, Next=3000, Express=whatever the script binds). The IDE detects URLs from log output and classifies them by HTTP **content-type** (HTML → `frontendUrl`; JSON/other → `backendUrl`). No reserved ports, no preemptive `kill_port` calls. The previous port-authoritative classifier (`:7773` → frontend, `:7777` → backend) was retired because it ignored URL fallbacks (Vite 5173 → 5174 on conflict) and forced prescription downstream.
- **Host injection (Windows IPv6 workaround)**: for known frontend dev servers (`vite`, `next dev`, `nuxt dev`, `astro dev`, `svelte-kit dev`, `ng serve`, plus `npm/yarn/pnpm/bun run …`), the IDE injects `--host 0.0.0.0` so servers bind on both IPv4 and IPv6. Wrappers (`concurrently`, `npm-run-all`, `turbo`, `pnpm -r`, workspaces fanout) get nothing injected — host must be wired in sub-scripts.
- **URL classification rules**:
  - `frontend` / `backend` single kinds: first detected URL wins, port-agnostic.
  - `fullstack`: content-type drives — HTML → `frontendUrl` (and mirrored to `backendUrl` if monolithic, i.e. no real backend yet); JSON/other → `backendUrl`. Mirrors are transient — a subsequent real JSON URL overwrites them.
- **`frontend_port_hint` (rare override)**: `start_dev_server` accepts an optional `frontend_port_hint`. Use only when fullstack content-type is ambiguous (e.g. Express serving HTML fallback alongside Vite). When set, a probed URL on the hinted port is forced to frontend regardless of content-type.
- **Stop semantics**: `stop()` kills the process tree first; if any of the *actually-detected* URLs is left bound, `kill_port` is called on those specific ports as a Windows-side safety net (cmd.exe → npm → node descendants sometimes survive `taskkill /T`).
- **Generated projects**: scaffolds use the framework's defaults (no port prescription). Backend uses `app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', ...)`. CORS is permissive in dev (`origin: true`) or env-driven (`process.env.CORS_ORIGIN`). For Vite, `server.proxy` forwards `/api` to the backend so the browser sees same-origin requests and CORS doesn't apply for the auth flow. See `auth-proxy-gip` skill for the full recipe.

## Tech Stack

- **Frontend**: React 19.2, TypeScript ~5.9, Chakra UI v3, Monaco Editor 0.55, Zustand 5, xterm.js 6, Framer Motion 12, TanStack Query 5, React Markdown, Firebase 12
- **Backend**: Rust (edition 2021), Tauri 2 (macOS private API), tokio, serde, reqwest 0.12
- **Build**: Vite 8, Jest 30 + ts-jest for testing
- **Package Manager**: Yarn 1.22.22 (Node >= 20.19.0)

## Plans, models, and routing

TM Code uses **two coder models** plus one multimodal handler. Per-plan model is admin-managed in `~/dev/web/toquemedia-studio` (Settings page writes to Firestore `subscription_plans/{planId}.ideModel`); the IDE never picks a model itself.

| Plan | Token cap/cycle | Coder |
|---|---|---|
| `explorer` (free) | 1.5M | DeepSeek V4-Flash (DashScope) |
| `vibe` | 5.88M | GLM-5.1 (DashScope) |
| `pro` | 11.76M | GLM-5.1 (DashScope) |
| `max` | 72.55M | GLM-5.1 (DashScope) |

**Multimodal**: server-side preprocessing in `toquemedia-studio-api/src/multimodal.ts`. When a paid-plan request contains `image_url` blocks, the worker calls Qwen 3.6 Plus in parallel for each image, replaces the blocks with text descriptions, then forwards the now-text-only request to the user's plan model. Free tier blocks attachments at the UI level (`useAttachments.ts:81`). The frontend never swaps profiles for image messages — `getProfileForPlan(plan)` is the single profile selector.

**Slash commands** (`src/services/agent/commands/`):
- `/plan` — same coder model, `X-Request-Type: plan` header forces `enable_thinking=true` for the turn.
- `/debug` — same coder model, `X-Request-Type: debug` header forces reasoning ON. Hypothesis-driven prompt.
- Code mode (default chat) — reasoning OFF by default, user-toggleable on paid plans (`thinkingSupported = billingPlan !== 'explorer'`).

**Frontend rule (do not break)**: `getProfileForPlan(plan)` in `src/services/agent/modelProfiles.ts` returns sampling-shape defaults only — never trust `profile.id` as the model the upstream will see. The backend (`toquemedia-studio-api/src/proxy.ts`) is the source of truth for model resolution; clamps for upstream-specific quirks live there.

**Pricing analytics**: `BLENDED_TOKEN_PRICE_USD_PER_M = $1.785` (70/30 input/output mix), `PLAN_MARGIN_RATIO = 0.35`. Subscription prices are Firestore-driven; the constants in `src/types.ts` are local fallbacks only.

## Project Templates

Templates live in **two synchronized places** — both must agree:

1. **Metadata list (canonical)** — `src/services/templateService.ts` (`TEMPLATES` array, ~line 50). Each entry has `id`, `category` (frontend/backend/fullstack), `framework`, `installCommand`, `devCommand`, `tags`, optional `workspaces`. This is what the UI reads (`getAll`, `getByCategory`, `matchPrompt`).
2. **File trees (scaffolded content)** — `src-tauri/resources/templates/<id>/`. Bundled into the Tauri app and copied by the `scaffold_template` Rust command. After scaffold, `.toquemedia-template` (a `TemplateManifest`) is written to the project root so the agent can detect which template was used.

If you add a template, you must add **both** the entry in `templateService.ts` and a directory under `src-tauri/resources/templates/<id>/`. IDs in the metadata that have no matching directory will fail at scaffold time.

| Category | IDs |
|---|---|
| Frontend | `react-ts-vite`, `nextjs-ts`, `nuxt-ts`, `vue-ts-vite`, `svelte-ts-vite`, `astro`, `angular-ts` |
| Fullstack | `react-express-ts`, `react-express-prisma-auth` |
| Backend | `express-ts`, `fastify-ts`, `nestjs-ts` |

### `react-express-prisma-auth` (May 2026) — auth-pre-wired

Use when the prompt mentions login, signup, auth, users, or `#auth-google`. The template is the structural fix for the BugHunterKimi class of bugs (8 distinct failures across one auth-flow scaffold). Pre-wired against:

- **dotenv-after-imports**: `tsx watch --env-file=../.env` in the server dev script. No `dotenv.config()` at module top-level.
- **Vite proxy missing**: `vite.config.ts` ships with `server.proxy['/api']` already pointing at `:3001`.
- **Prisma P2021** (table doesn't exist): `predev` hook runs `scripts/db-setup.mjs` which idempotently runs `prisma migrate dev --name init` (or `migrate deploy` if migrations exist). DATABASE_URL is forced to an absolute file:// URL so cwd-relative bugs can't surface.
- **`tenantId` dropped from Identity Toolkit**: required + present on every signInWith{Idp,Password} / signUp call in `server/src/routes/auth.ts`. ITK 4xx → 401 (not 502).
- **Backend reads `VITE_*`**: routes read `GIP_FIREBASE_API_KEY` / `GIP_TENANT_ID` / `GCP_PROJECT_ID` mirrors (with VITE_* as fallback only).
- **Fail-fast guard**: `server/src/index.ts` exits with a useful message when GIP env is missing rather than letting requests fail with cryptic ITK errors.
- **Offline test**: `tests/templates/test-react-express-prisma-auth.sh` runs the full scaffold → install → migrate → curl flow against a local ITK mock (`tests/templates/itk-mock.mjs`) via `ITK_BASE_URL_OVERRIDE`. Production never sets that override.

**Dotfile bundling**: source files use `_gitignore` and `_env.example` (underscore prefix) because Tauri's resource bundler glob excludes dotfiles. The Rust `copy_template_dir` in `src-tauri/src/commands/filesystem.rs` restores the dot at scaffold time via a whitelist. Add to the whitelist when introducing a new dotfile.

**Deploy gap (known, P0 follow-up)**: this template uses Express + Prisma + SQLite, which does NOT deploy via the Cloudflare pipeline (Workers + R2 + D1). It builds for local dev only — `collect_deploy_bundle` will fail because the backend isn't a Worker bundle. A sibling `react-hono-drizzle-d1-auth` template needs to be added to match the deploy target before the IDE can claim "1-prompt to ship". Until then, surface this trade-off when picking the template.

### Auth-route smoke test (REQUIRED after any /api/auth/* edit)

Whenever a phase touches `/api/auth/*`, before claiming done:

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:5173/api/auth/me
# expected: 401 application/json
```

Anything else is a regression — `404 text/html` means the Vite proxy isn't wired; `500` means the backend crashed (read_dev_server_logs). The full diagnosis tree is in `src/services/agent/commands/planCommand.ts` under "Auth-route smoke test".

## Deploy Pipeline

Deploy is **single-target Cloudflare** (R2 for assets + Workers for backend + D1 for DB). It is **not a generic deploy** that works for every template.

**Frontend entry points**:
- `Cmd/Ctrl+Shift+D` from `MinimalTitleBar.tsx` (always-mounted) opens the `PublishModal` via `layoutStore.setPublishModalOpen(true)`.
- `PreviewView.tsx` has a "Publish" button that opens the same modal.
- `views/settings/DeploysSection.tsx` shows the deployment summary + custom domain panel for the current project.

**Flow** (`src/services/deployService.ts`):
1. `collect_deploy_bundle` (Rust, `src-tauri/src/commands/filesystem.rs:348`) reads the project files into a `DeployBundle`.
2. Service walks 4 backend phase endpoints under `${workerUrl}/v1/projects/deploy/`: `init` → `upload` (chunked, parallel, 8 MB / 50 files / concurrency 3) → `worker` (only if `worker_file` exists) → `finalize`. The 4-way split exists to dodge Cloudflare's per-request CPU budget.
3. On failure after `init`, best-effort `cleanup` POST removes orphaned R2 files.
4. Public URL pattern: `<slug>.toquemedia.net`. Custom domains via `addCustomDomain`/`getCustomDomainStatus`/`removeCustomDomain` (Cloudflare hostname API).

**Bundle shape (`collect_deploy_bundle` expects)**:
- **Assets**: `<project>/dist/` (Vite-style flat output). Errors with build-script suggestion if missing.
- **Worker**: first match wins from `backend/dist/worker.js` → `dist/worker.js` → `worker.js` (Hono Worker bundle).
- **Database**: `backend/src/db/schema.ts` (Drizzle) signals `has_database=true`. Migration SQL preference: `backend/migrations/*.sql` (drizzle-kit output) → raw `schema.ts` fallback.
- **API routes**: presence of `backend/` dir signals `has_api_routes=true`. If `backend/` exists but no `worker.js` was found, the bundle errors with a "run npm run build in backend/" hint.

**Template ↔ deploy compatibility**:
- ✅ Out-of-the-box: `react-ts-vite`, `vue-ts-vite`, `svelte-ts-vite`, `astro` (all build to flat `dist/`). Backend can be added by the agent via `provision_auth` (writes the Hono+Drizzle boilerplate into `backend/`).
- ⚠️ Partial: `react-express-ts`, `react-express-prisma-auth` — Express scaffold isn't a Worker bundle; deploy would require swapping the backend to Hono and the DB to D1. `react-express-prisma-auth` is local-dev only by design today; sibling `react-hono-drizzle-d1-auth` template is the planned fix.
- ❌ Not deployable today: `nextjs-ts` (`.next/` output, needs `@cloudflare/next-on-pages`), `nuxt-ts` (`.output/`), `angular-ts` (nested `dist/<app>/`), `express-ts` / `fastify-ts` / `nestjs-ts` (Node servers, not Workers).

There is no framework-detection guard yet — deploys for non-compatible templates fail at `collect_deploy_bundle` with a "dist/ not found" error rather than a precise "Next.js not supported" message.

## Design System

Dark theme with pink/magenta brand accent (`src/theme/tokens.ts` is the single source of truth):
- Backgrounds: `#0a0a0a` (app/welcome), `#0f0f0f` (sidebar), `#1a1a1a` (overlay/cards)
- Primary text: `#e6edf3`, secondary: `#8b949e`, muted: `#7d8590`
- Brand accent: `#FE1063` (pink/magenta), gradient `#FE1063 → #C10A69`
- Secondary accents: purple `#a371f7`, green `#2ea043`, orange `#f77f00`
- Borders: `#262626` (default), `rgba(255, 255, 255, 0.08)` (glass)
- Glassmorphism effects with backdrop blur, pink glow shadows

## Conventions

- All frontend code in TypeScript (strict mode)
- Chakra UI v3 for UI components
- Zustand for state management (with persist middleware where needed)
- Service layer pattern: components → stores → services → Tauri invoke
- Lazy loading for heavy components (Monaco, Debugger, Checkpoint)
- Web Workers for expensive operations (file tree indexing)
- SSE streaming for agent responses with reasoning block detection
- **UI quality is not over-engineering.** Components should always be visually polished, using `tokens.ts` design tokens, proper spacing, transitions, and glassmorphism effects. "Avoid over-engineering" means no unnecessary abstractions or extra features — not skipping visual polish.
