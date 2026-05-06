# Changelog

All notable changes to TM Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes._

## [0.6.0] — 2026-05-05

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
