# Changelog

All notable changes to TM Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.6] — 2026-05-23

**Your agent now works while it waits.** Background command execution lets the agent install dependencies, build, and compile without blocking — it writes your project files in parallel and checks results when ready. The welcome screen got a visual upgrade, the terminal mode is smarter about project compatibility, and the agent itself is leaner and more reliable.

### Added

- **Background command execution.** The agent can now run long commands (`npm install`, `npm run build`, `tsc --noEmit`) in the background without blocking your conversation. It starts the command, continues writing your project files in parallel, and checks the results when ready. Scaffolding a new project is roughly twice as fast — the agent writes all source files while dependencies install. Max 6 concurrent background commands, with automatic cleanup and timeout protection (up to 10 minutes per command). Status bar shows running, completed, and errored commands in both Chat and Terminal modes.

- **Project compatibility detection.** When you open a project, the agent now evaluates whether it's fully compatible with the Chat-mode live preview and deploy pipeline. Non-JS projects (Go, Python, Rust), frameworks without deploy support (Next.js, Nuxt, Angular), backend-only projects (Express, Fastify, NestJS), and projects missing a dev script all get a clear, actionable compatibility note — with options to adapt the project or switch to Terminal mode. Compatible projects (React+Vite, Vue+Vite, Svelte+Vite, Astro) see nothing — zero noise when everything works.

- **Standalone editor windows.** Double-click a file in your OS file manager and it opens in a standalone TM Code editor window — no project sidebar, no chat, just the file. Works on macOS ("Open With"), Windows ("Open with"), and Linux. Supports `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.md`, `.css`, `.html`, `.py`, `.go`, `.rs`, `.toml`, `.yaml`, and more.

- **Terminal plan approval cards.** The `/plan` command now renders a full approval card directly in Terminal mode — diff preview, file list, and approve/reject buttons — instead of falling back to a plain text prompt.

### Changed

- **Welcome screen redesign.** The welcome hero uses motion-driven animations, cleaner layout, and better visual hierarchy. The sidebar was simplified — action buttons moved into the hero as two large mode cards (Chat and Terminal).

- **Ask-user-question always has a free-text option.** The `ask_user_question` tool now always shows an "Other" option with a free-text input field, regardless of whether the model requested it. The `allowOther` field was removed from the tool schema — the UI always renders it. This eliminates the common scenario where the model's predefined options didn't cover the user's answer.

- **Terminal mode status bar.** The bottom status bar in Terminal mode now shows background command counts (running, completed, errored) alongside auto-approve, queue, skills, MCP, and dev server status.

- **Agent internals — SOLID refactor.** The tool executor was refactored from a single 4,400-line file into focused domain modules (context, interaction, memory, provision, task). 80 regression tests ensure the refactor introduced no behaviour changes. The agent is now easier to maintain and extend.

### Fixed

- **Agent blocks on `npm install` during scaffolding.** The agent would wait 15–60 seconds for `npm install` to finish before writing any project files. Now it installs in the background and writes files in parallel, cutting total scaffolding time roughly in half.

- **No warning when project is incompatible with preview.** Opening a Go, Python, or Rust project in Chat mode would silently fail to show a preview — the agent wouldn't explain why. Now the agent detects the project type and explains the limitations, with concrete options to proceed.

- **Closed-loop contradiction for background commands.** The agent was told to "STOP and fix" after every command exit, which contradicted the background install pattern. Blocking commands still require immediate attention; background commands now have explicit permission to continue working while the command runs.

- **Background command race condition.** Commands that exited before the store entry was created (e.g. very fast `echo` or `ls`) would get stuck as "running" forever. The store entry is now created before the event buffer is flushed, so fast exits are correctly captured.

- **Background command results lost after GC.** Completed commands were garbage-collected immediately, making their output unavailable for diagnosis. The GC now keeps the 5 most recent results regardless of status.

- **Errors hidden in background command status.** The status bar showed "cmds: 2 done" even when one had errored. Now it shows "cmds: 1 done, 1 errored" — errors are never silently absorbed.

## [0.6.2] — 2026-05-16

Patch release focused on a `/plan` silent-failure bug, multi-instance support, file-open hygiene, and proactive auth refresh.

### Fixed

- **`/plan` silent failure when reading long skills.** The architect could read `auth-proxy` (~37 KB) and then chain `read_large_result` calls that each tripped the 30 KB tool-output truncate threshold — every page-read created a NESTED `large_result_N` reference and the model chased pagination of pagination until output budget collapsed before `write_file` landed. The session ended cleanly (status=idle) with the system message "Plan generation did not finish — PLAN.md was not written" and no error. Now `read_large_result` bypasses truncation (the slice is already model-bounded), the per-page `limit` is capped at 25 K instead of 30 K so slice + continuation suffix never re-triggers truncate, and the schema description hints at smaller targeted pages.
- **Backend Firestore 403 noise + plan misclassification.** `getUserPlan` in the worker didn't accept the `env` parameter, so its internal `getUserData` call fell back to user-idToken auth on Firestore. With the v2 deny-all Security Rules, every call logged `[firestore] getUserData failed (403) ... — defaulting to explorer` and used explorer rate limits regardless of the user's real plan. Three callsites threaded fixed (`/v1/commit-message`, `/v1/web-fetch`, `/v1/summarize`). Chat completions was already correct.
- **"Open With → TM Code" on a single file mounted the parent folder as a project.** Opening a stray `.md` from Finder/Explorer would add `/Users/<you>/Documents` (or wherever the file lived) to the recent projects list — clutter the user never asked for. The opener now probes each path with `is_directory`; if every queued path is a file, the file opens in the editor without `openProject` running. Mirrors the XCode pattern.
- **Stale ID token caused intermittent 401s after laptop wake.** Firebase ID tokens expire after 1 h (Google-imposed, not configurable); the Web SDK auto-refreshes ~5 min before expiry but the proactive timer can miss after long suspensions. `FirebaseAuthService.getIdToken()` now decodes the cached JWT and force-refreshes when `exp` is within 60 s of `Date.now()`. The `web_fetch` tool also retries with a force-refreshed token on a 401 — same pattern the chat completions path already uses.
- **Context-window pill stuck at 0% when switching sessions.** `currentPromptTokens` lived as global chatStore state, not per-session. Every session-switch within an app run kept whatever the previous session left (or 0 % for a fresh app launch with no completed turn yet), so the pill misrepresented context pressure on any session that had accumulated history. `setActiveSession` now hydrates the pill from the active session's last known token counts; `addTokenUsage` persists them on every turn. Legacy sessions saved before this fix fall back to a char-based estimate from message history until the next turn lands a real usage header.
- **Activity indicator showed inflated input tokens (e.g. "↑ 904 K" on a 256 K-window model).** `totalTokensUsed.input` was being SUMMED across every iteration of the agent loop, but each iteration re-sends the full conversation history — so an 18-iteration turn with a ~50 K average history multiplied into ~900 K of reported input even though no single on-wire prompt exceeded 50 K. Switched to `Math.max(prev, newInput)`: the indicator now reports the peak wire-size during the request, bounded by the context window and consistent with the context-pressure pill. The 0-guard from the existing anti-overwrite logic carries over.
- **Wall-clock timer kept counting while the agent was paused waiting for the user.** Tool-permission dialogs already paused the timer, but the `request_credentials` form and inline diff approvals did not — a turn would surface as "11m 25 s applying changes…" when most of those minutes were the user reading a credentials prompt or a diff. `useAgentElapsed` now freezes on any of the three wait states (permission / credentials / diff). The frozen value resumes from the same instant once the user replies.
- **`provision_auth` failure cascaded into broken-by-design auth scaffolds.** When `/v1/auth/provision-gip` returned an error (e.g. the production `INVALID_PROJECT_ID` from observability requestId `9fca997ada70304b`), the IDE returned the failure to the model as a short, soft string. The model rationalised around it — "vou avançar e implementar o auth-proxy manualmente" — and then called `request_credentials` for `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_GOOGLE_CLIENT_ID`. Those credentials are PLATFORM-MANAGED; the developer cannot type them. The form rendered, the developer hit a dead-end, the scaffold was non-functional. Three guard-rails added in lock-step:
  - `provision_auth` failures now return a structured HARD-STOP message that names the wrong recovery paths verbatim and prescribes the correct one (report to developer, do not scaffold).
  - `request_credentials` rejects platform-managed field IDs (`VITE_TM_*`, `TM_*`, `VITE_FIREBASE_*`, `VITE_GIP_*`, `VITE_GOOGLE_CLIENT_ID`, `GIP_*`, `GCP_PROJECT_ID`, `APP_ID`, `FIREBASE_*`, `DATABASE_URL`, etc.) with a blocked message that points the model back at `provision_auth`. The prose-only directive in the tool description was empirically insufficient — this is now mechanical.
  - Backend `gipAuth.ts` adds an ops-actionable hint to `INVALID_PROJECT_ID` errors that names the four likely causes (missing `GIP_PROJECT_ID` secret, Identity Platform API not enabled, multi-tenancy not upgraded, service-account role gap) so the next operator debugging this in observability has a path forward instead of just "INVALID_ARGUMENT: INVALID_PROJECT_ID".
- **Mid-stream upstream drop surfaced as `outcome: "exception"` with the agent freezing.** When the upstream provider (OpenRouter/Xiaomi/DashScope/etc.) dropped a streaming response part-way through, the raw response body bubbled the `"Network connection lost."` from V8's fetch into the Worker runtime, the invocation reported as `outcome: "exception"`, and the IDE's stream parser treated the truncated stream as a clean end-of-turn — the agent froze with no error and no recovery path. Observed in BugHunter session `sess_1778939230235_o3x3ar` (2026-05-16) during `/plan` research with GLM-5.1, distinct from the model-side give-up bug fixed earlier in this release. Two-part fix:
  - **Backend (`proxy.ts wrapStreamWithErrorCapture`)**: the SSE body is now piped through a TransformStream that catches mid-stream errors, emits a typed SSE event (`{ error: { type: 'upstream_stream_interrupted', message, provider, model } }` + `data: [DONE]`), and closes the writer cleanly. Worker outcome stays `"ok"` (Observability stays signal-rich for real exceptions); the IDE receives a structured event it can act on. Applied to both TMS chat path and BYOK chat path.
  - **IDE (`streamParser.ts`)**: detects the typed error event at chunk-process time, closes any open content blocks, and emits a parser `error` event with a user-readable message ("The model's response was interrupted mid-stream … Retry the request."). The agent's existing `onError` callback takes over from there — no more silent freeze on stream drop.

### Added

- **Multiple instances.** "File → New Window" (`Cmd/Ctrl+Alt+N`) launches another TM Code process. Each instance is an independent OS process with its own backend state, Zustand stores, and MCP children; Firebase auth persists in the per-user data dir so all instances stay logged in to the same account. Token-budget gauges reflect server-side state via Firestore listeners, so a quota change in one window appears in the other automatically. Memory cost: ~250–400 MB per extra instance — same trade-off as VS Code's multi-window model.
- **`/plan` research budget.** The architect prompt now caps web research at 3 calls (`web_search` + `web_fetch` combined). Remaining unknowns go into `§14 Open Questions` instead of more fetches. This will relax in v0.7.0 when the `task` sub-agent ships and broad research moves off the parent context entirely.

### Documentation

- New: `docs/PLAN-SUBAGENTS-V0.7.0.md` — design doc for the v0.7.0 `task` tool + built-in `Explore` / `Research` sub-agents. ~90% port of `claude-vaz/tools/AgentTool` with explicit Chat-Mode + Terminal-Mode support.
- Removed: `docs/PLAN-PREVIEW-BROWSER-PARITY.md` (shipped in v0.6.1), `docs/PLAN-NATIVE-PREVIEW.md` (superseded by Preview Browser Parity).

### Deployment notes

The Firestore 403 fix is server-side. Tagging this release ships the IDE but **does not deploy the worker** — run `wrangler deploy --env production` in `toquemedia-studio-api` to land the backend half. Until then, the IDE is on 0.6.2 against a 0.6.1-era worker; the user-facing impact is only the noisy 403 logs in observability and the rate-limit misclassification on `/v1/web-fetch` and `/v1/commit-message`.

## [0.6.0] — 2026-05-07

**BYOK lands.** Bring your own API keys for the providers you already pay for and route requests through them directly — your tokens, your bill, the same chat-first IDE.

When BYOK is active, TM Code does not consume your plan's monthly tokens. Your subscription continues to gate the IDE features you have access to (sandbox, MCP, checkpoints, skills, deploy) — only the model calls switch carriers.

A new "BYOK-only" plan tier ($5/month — sandbox + MCP + checkpoints + skills + HTTP Client, no deploy, no model tokens) ships once ops seeds the corresponding `subscription_plans/byok-only` doc in Firestore. Until then, BYOK is available on the existing Explorer / Vibe / Pro / Max plans (gated per `subscription_plans/{plan}.byokAllowed`).

### Added

#### BYOK — providers and catalog

- **Six cloud providers** out of the box, each with curated model lists, capability metadata (vision / tools / reasoning), and per-million-token pricing for in-app cost display:
  - **Anthropic** — Claude Opus 4.7 (1M context), Sonnet 4.6, Haiku 4.5
  - **OpenAI** — GPT-5.5, GPT-5.5 Pro
  - **OpenRouter** — multi-provider gateway with one key (Claude / GPT / DeepSeek and 200+ more)
  - **Google Gemini** — 2.5 Pro, 2.5 Flash via Google's OpenAI-compatibility endpoint
  - **DeepSeek** — V4-Pro, V4-Flash
  - **xAI Grok** — 4.3, 4.1 Fast
- **Anthropic SSE bidirectional adapter** — Claude models route directly via the Anthropic API (no OpenRouter detour), with system extraction, tool conversion, thinking-budget mapping, and event stream translation. Direction-1 of the existing `anthropicAdapter.ts` adapters wired into the BYOK path; pending end-to-end validation against a live Anthropic stream.
- **Native multimodal** — Claude, GPT-5.5, Gemini, and Grok 4.3 receive image attachments in their native shape (Anthropic supports both base64 and URL sources).
- **Multimodal fallback for vision-less providers** — paid-plan users on DeepSeek and similar non-vision models get TM Vision preprocessing (Qwen 3.6 Plus) so screenshots, error dialogs, and UI mocks still flow through.

#### BYOK — Settings and chat UX

- **API Keys section** in Settings with a master "Use BYOK" toggle, per-provider cards (key input, optional org-gateway base URL, model picker with capability badges, "Test" button, "Set active"), and a "Custom OpenAI-compatible" row for endpoints not in the catalog.
- **Per-provider key validation** — sends a 5-token mini-completion to confirm the key works before saving, rate-limited to prevent abuse.
- **Model indicator pill** in the chat header replaces the credits indicator while BYOK is active, surfacing the actual provider/model the server confirmed handled the request.
- **Paperclip capability gate** — image upload is shown or hidden based on the active model's vision support, with a "via TM Vision" hint when fallback preprocessing applies on paid plans.
- **Per-session BYOK snapshot** — switching providers in Settings only affects new sessions; ongoing conversations keep the provider/model they started with.
- Bilingual i18n (PT / EN) for all BYOK strings.

#### BYOK — security and infrastructure

- **OS keychain storage** — keys live in the macOS Security framework, Windows Credential Manager, or Linux libsecret. Keys never persist in app state, localStorage, or session files; they're fetched just-in-time from the keychain when a chat request is sent.
- **Per-request transit only** — keys travel as request headers over TLS, never stored or logged on the proxy. Logging audit verified end-to-end: no log path references the BYOK key header or its handler-local copy.
- **Server-side feature flag** — `features/byokEnabled` in Firestore (cached 30s in KV) gates BYOK rollout independently of releases.
- **Plan-level eligibility** — `subscription_plans/{plan}.byokAllowed` decides who can use BYOK on each plan tier.
- **Authoritative `X-BYOK-Active` response header** — the server confirms whether a request was actually routed via BYOK; the IDE's UI pill reads from this rather than trusting local toggle state.

#### Backend — proxy and billing

- New `/v1/byok/providers` endpoint serves the curated catalog (Firestore-backed with hardcoded fallbacks for bootstrap) to the IDE.
- New `/v1/byok/validate` endpoint runs key validation per-user with a 3/min rate limit.
- BYOK requests skip cost-budget checks and Firestore token commits — billing event still emitted with `byok: true` so the IDE knows TMS budget fields aren't authoritative.
- Provider-specific request normalization is bypassed on the BYOK path; thinking-shape is normalized once per the model's declared shape (Anthropic / OpenAI reasoning_effort / Qwen enable_thinking / Gemini thinking_budget).

#### BYOK — second-wave polish

- **BYOK indicator now visible in CMD mode.** The same model pill that swaps in for the credit indicator in chat now surfaces in the CMD title bar too — so a BYOK user always knows which key is serving requests, regardless of which surface they're on.
- **Per-turn footer in CMD mode** — every assistant reply ends with a compact `✓ 2.3s · ↑12k · ↓4k` line showing duration and tokens consumed for that turn. Captured at finalize time from the per-request token counter.
- **`/plan`, `/debug` and `/review` force reasoning ON under BYOK.** The `X-Request-Type` header forces reasoning server-side for plan-managed requests, but BYOK requests are passthrough — without forcing the body shape too, those commands collapsed to generic chat. The frontend now sets the thinking flag on the body when the request type demands it, regardless of carrier.
- **Billing overage banner adapts to BYOK** in both modes. "Plan budget exhausted — using your BYOK key" replaces the misleading "agent may be throttled" — your own key isn't constrained by the platform's monthly budget.

### Changed

- **CMD agent no longer starts dev servers.** `npm run dev` and `start_dev_server` are off the table in CMD mode — long-running background processes are awkward to terminate cleanly from a terminal session and frequently leave orphaned ports. Verification now happens via `tsc --noEmit`, `eslint`, `npm run build` or unit tests — one-shot commands that exit on their own. When the user wants to see the app running, the agent asks them to start the dev command themselves.
- **CMD mode font sizes harmonised** — welcome screen, task list and message body all render at 13px now (previously a 9–14px range, with the task list visibly smaller than chat content).
- **UI baseline guidance added to the agent's system prompt.** Six positive rules cover empty states (must guide with a named CTA, not just an icon), control groups (render whole, even when zero), heading hierarchy (matches density), decoration (anchored to a labeled element), primary actions (signposted) and design tokens (preferred over ad-hoc hex codes). Sits in the recency block of the prompt with a 1-liner echo in the final Reminder, mirroring the existing identity-reminder pattern. Catches the "auto-generated UI that breaks on empty data" failure mode without depending on the `frontend-design` skill being invoked.
- **Deploy v1 hidden from the UI** while the universal v2 pipeline is in development. Entry points removed (keyboard shortcut, toolbar button, settings nav); underlying code, the Rust `collect_deploy_bundle` command, and backend endpoints preserved for incremental migration. v1 only worked for Vite-shape templates; v2 will provide universal deploy. Architecture and phased plan documented in `docs/PLAN-DEPLOY-V2.md`.

### Fixed

- **BYOK thinking toggle now actually has effect.** The frontend was unconditionally sending the plan-profile parameter shape (`enable_thinking` on Qwen, `reasoning.enabled` on OpenRouter) — Anthropic, OpenAI and Gemini upstreams ignored both silently, so toggling thinking off had no effect for those providers. The session snapshot now freezes the BYOK model's `thinkingShape`, and the request body uses the upstream's native shape: `thinking.type` for Anthropic, `reasoning_effort` for OpenAI, `thinking_budget` for Gemini, `enable_thinking` for Qwen.
- **Queued messages appear in the CMD transcript instantly when dispatched.** The CMD agent path was resolving `@mentions` and reading the home directory before adding the user bubble, leaving a 100ms–1s gap where the queued pill had cleared but the message hadn't surfaced yet. The bubble is now rendered synchronously before any await.
- **Billing overage banner is visible in all chat-mode states** — loading, empty, with messages. Previously it lived inside the messages-only branch, so a user who opened a fresh session over budget saw nothing. Now sits at the top of the chat view alongside the scaffold banner.
- **Agent errors are surfaced in chat mode.** 402 (no credits), 429 (rate limit / budget exhausted), 5xx and AUTH_EXPIRED responses were stored in `agentStore.error` but never rendered — only CMD mode showed them in the status line. A new red banner surfaces the message at the top of the chat view, auto-clearing when the next turn starts.

### Removed

- Unused clipboard icon from the CMD header.

### Known limitations

- **Local providers** (Ollama, LM Studio, llama.cpp) — the catalog reserves the namespace but routing through Tauri's Rust HTTP layer is deferred to v1.1. Until then, local providers in Settings won't accept chat traffic.
- **Admin UI** for editing the BYOK provider catalog lives in the toquemedia-studio web admin (deferred). The IDE ships with hardcoded fallbacks covering all six cloud providers + a custom OpenAI-compat row; the Worker prefers Firestore over the fallbacks once seeded.
- **BYOK-only plan** ($5/month) — referenced in this release but requires the `subscription_plans/byok-only` Firestore doc to be created by ops before users can subscribe.
- **Multi-device key drift** — keys live in each machine's local OS keychain; configuring BYOK on one device doesn't propagate the key to another. The toggle state and active provider/model selection are per-device too.
- DeepSeek V4-Pro is currently running a limited-time 75% input discount until 2026-05-31 — pricing displayed in the IDE reflects the post-promo standard rate to avoid jumps.
- Gemini 2.5 Pro and Grok 4.3 use tiered pricing that doubles above 200K-token prompts; the cost display uses the base tier so long-context sessions under-report by up to 50%.

[0.6.0]: https://github.com/ToqueMedia/TM-Code/releases/tag/v0.6.0

## [0.5.0] — 2026-05-03

**Hello, world.** This is the inaugural public release of TM Code — the Agent-First IDE by Toque Media.

TM Code reimagines the IDE around conversation. The AI agent is the primary surface: it writes code, runs commands, edits files, and opens a live preview while you stay in the chat. The Monaco editor is one keystroke away when you want to take the wheel.

### Highlights

- **Chat-first UX** where the agent drives and you review.
- **Live preview** of dev servers alongside the conversation.
- **Inline diffs** — accept or reject changes block by block.
- **Multi-model routing** with thinking toggle on supported models.
- **MCP, skills, slash commands, checkpoints, and sandbox** out of the box.
- **macOS, Windows, and Linux** with native polish on each platform.

### Added

#### Core experience

- Chat panel as the main view, with streaming agent responses, reasoning blocks, and inline tool-call cards.
- Live preview pane for frontend, backend, and fullstack projects with content-type-based URL detection.
- Monaco editor as a secondary mode with split panes, draggable reorderable tabs, breadcrumbs, and Prettier formatting on save.
- Integrated xterm.js v6 terminal with full PTY support and command history.
- Source control panel — staged/unstaged diffs, commit, push, pull.
- DAP-based debugger with breakpoints, call stack, variables, and console.
- Postman-style HTTP Client for backend projects, with key-value editor and JSON body support.
- Quick Open, Command Palette, and project-wide Search.
- File tree with Web Worker-backed indexing and `.gitignore` awareness.

#### Agent

- Plan-based model routing — DeepSeek V4-Flash for the free tier and GLM-5.1 for paid plans.
- Multimodal image handling via Qwen 3.6 Plus preprocessing on paid plans.
- Slash commands: `/init`, `/plan`, `/debug`, `/e2e`, `/payments`.
- Skills system invokable through `#hashtag` to load specialised prompts and tooling.
- MCP (Model Context Protocol) client with stdio and remote transports.
- Checkpoints with automatic snapshots before risky operations and one-click rollback.
- Granular permissions for shell commands, file writes, and network access.
- Optional sandbox mode for project execution isolation.
- Plan approval — preview multi-step plans before the agent commits to them.
- Reasoning toggle for supported models, with backend handshake to confirm the model's actual thinking mode.

#### Project lifecycle

- Built-in templates for React (Vite), Next.js, Vue, Svelte, Astro, Angular, Express, Fastify, NestJS, and a React + Express fullstack scaffold.
- Dev server manager with automatic project-kind detection (frontend, backend, fullstack), natural port handling, and Windows IPv6 host injection for known frameworks.
- Optional Docker / Colima container isolation per project.
- On-demand native browser session for end-to-end agent flows that outgrow iframes.

#### Platform

- macOS (Apple Silicon and Intel), Windows 10/11, and Linux (Debian/RPM) builds.
- Auto-updates via GitHub Releases.
- Native window vibrancy on macOS and Windows.
- Native OS notifications through the system notification centre.
- File associations — open projects by double-clicking from Finder or Explorer.
- Splash screen with native drag-and-drop.
- Respect for the OS-level reduced-motion accessibility preference.

#### Plans and billing

- Explorer (free) — DeepSeek V4-Flash with a 1.5M token monthly cycle.
- Vibe, Pro, and Max — GLM-5.1 with scaling token budgets and TMS overage support.
- Token-envelope billing with 5-hour and 7-day rate-limit windows.

#### Internationalisation

- UI available in English and Portuguese.
- Agent response language configurable independently of the UI language.

### Known limitations

- BYOK (Bring Your Own Key) is planned for a future release; this version routes all model calls through the TM Code proxy. _Resolved in 0.6.0._
- Linux keychain integration depends on a running `libsecret` provider.

[0.5.0]: https://github.com/ToqueMedia/TM-Code/releases/tag/v0.5.0
