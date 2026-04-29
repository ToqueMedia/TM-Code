# QWEN.md — TM Code (toquemedia-studio)

## Related Projects

| Project | Path | Description |
|---------|------|-------------|
| **TM Code (this repo)** | `~/dev/deskotp/exodus-ide` | Desktop IDE frontend + Tauri Rust backend |
| **Backend API** | `~/dev/deskotp/toquemedia-studio-api` | Cloudflare Worker API proxy with billing, rate limiting, and AI provider integration |
| **Claude Code Source** | `~/dev/claude-vaz` | Claude Code Desktop source code (reference for message queue and feature architecture) |

## Message Queue Architecture

The message queue system mirrors **Claude Code's architecture** — ALL user messages go through a unified local command queue first, and the queue processor decides when to dequeue based on agent state.

### How It Works

```
User types message → ALWAYS enqueue() → Queue processor checks: agent idle?
  → YES: dequeue immediately → executeInput → runAgentLoop
  → NO: wait for turn to complete → mid-turn drain injects message → agent continues
```

### Mid-Turn Drain (Mid-Turn Injection)

Ported from Claude Code (`query.ts:1556`). After each turn where the model called tools, queued prompt messages are **appended as a text block to the SAME user message that carries tool results**. This avoids consecutive user messages (Anthropic requires strict alternation) and gives the model the new input alongside the tool results:

1. **Dequeue all** prompt-mode, non-slash commands via `dequeueAllMatching()`
2. **Coalesce** into a single user message via `joinPromptValues()`
3. **Add to chat store** so the message appears in the UI as a user bubble
4. **Append as text block** to `toolResultBlocks`: `[USER_MESSAGE]\n${text}\n[/USER_MESSAGE]`
5. **Push merged user message**: `{ role: 'user', content: toolResultBlocks }` (tool results + queued text)
6. **Continue** the loop — the model receives tool results + new input in one message

**Key constraints:**
- Only fires when `turnResult.toolCalls.length > 0 && finishReason === 'tool_use'` — if the model replied with pure text, it already decided to stop
- Queued text is appended to the tool_results user message, NOT as a separate user message — this prevents Anthropic's consecutive-user-message rejection
- If no tool results AND no queued messages, the loop naturally exits

```
Turn 1: API call → model responds with tool_use → tools execute
  → toolResultBlocks = [tool_result: write_file, ...]
  → mid-turn drain: user queued msg found
  → toolResultBlocks.push({type: 'text', text: '[USER_MESSAGE]\nalso add tests\n[/USER_MESSAGE]'})
  → messages.push({role: 'user', content: toolResultBlocks})  ← ONE user message
Turn 2: API call sees tool results + "also add tests" → model responds
```

### Key Components

| Component | File | Role |
|-----------|------|------|
| **Command Queue** | `src/services/agent/messageQueue.ts` | Unified module-level store with priority ordering (`now` > `next` > `later`) |
| **Queue Processor** | `src/services/agent/queueProcessor.ts` | Decides what to drain: slash/bash one-at-a-time, prompt-mode batched |
| **Queue Hook** | `src/hooks/useQueueProcessor.ts` | React hook subscribing to QueryGuard + queue snapshot |
| **Query Guard** | `src/services/agent/queryGuard.ts` | Sync state machine: `idle` → `dispatching` → `running` → `idle` |
| **Prompt Bar** | `src/components/prompt/usePromptBar.ts` | Entry point — `handleSend` enqueues ALL messages (slash commands execute directly) |

### Priority System

- **`now`** — Interrupt signals (abort current turn)
- **`next`** — User input (default)
- **`later`** — Task notifications, background events

### Batching Behavior

When multiple messages arrive while the agent is working:
- **Slash commands / bash mode**: processed one at a time (error isolation, exit codes)
- **Prompt mode**: all consecutive prompt commands batched into ONE agent turn via `joinPromptValues()`
- Different modes (prompt vs task-notification) are never mixed

### Visual Feedback

Queued messages are shown in the status bar as `N queued` — updating reactively as messages are enqueued and processed.

## Project Overview

**TM Code** (internal name: `toquemedia-studio`) is an **AI Agent-First desktop IDE** built with **Tauri 2** (Rust backend) + **React 19** (TypeScript frontend).

Unlike Cursor/VS Code (editor-first with AI in sidebar), TM Code is **chat-first**: the developer starts in a conversational interface where the AI agent writes code, shows diffs inline, displays progress, and opens a live preview — all without leaving the chat. The Monaco editor is available as a secondary mode for manual editing.

**UX flow:** Open project → Chat (default) → Agent works (diffs + preview visible) → Switch to Editor mode if needed → Back to Chat.

> **Naming:** UI-visible text uses "TM Code". Internal identifiers (config dirs, Cargo.toml, tauri.conf.json) remain `toquemedia-studio` to avoid breaking existing user data.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 19.2, TypeScript ~5.9, Chakra UI v3, Monaco Editor 0.55, Zustand 5, xterm.js 6, Framer Motion 12, TanStack Query 5 |
| **Backend** | Rust (edition 2021), Tauri 2, tokio, serde, reqwest 0.12 |
| **Build** | Vite 8, Jest 30 + ts-jest, Wrangler (Cloudflare) |
| **Package Manager** | Yarn 1.22.22 |
| **Node Version** | >= 20.19.0 (see `.nvmrc`) |
| **Other** | Firebase (auth), Cloudflare Workers (API proxy with billing/rate limiting) |

## Architecture

```
Frontend (React/TS)  ──Tauri IPC──>  Backend (Rust)  ──>  OS/Filesystem
         │
         └── Agent Service ── SSE ──> Cloudflare Worker ──> AI Providers
```

### Frontend → Backend Communication
Frontend calls Rust functions via Tauri's `invoke()`. All backend commands are registered in `src-tauri/src/lib.rs`. Service files in `src/services/` wrap these invocations.

### Key Frontend Directories

| Directory | Description |
|-----------|-------------|
| `src/components/` | React UI components organized by domain (chat, editor, views, prompt, debugger, auth, etc.) |
| `src/stores/` | Zustand state management (19 stores: project, editor, chat, agent, skill, mcp, layout, terminal, etc.) |
| `src/services/` | Tauri command wrappers and business logic (file, project, agent, AI, MCP, auth, debugger, terminal, etc.) |
| `src/hooks/` | Custom React hooks |
| `src/theme/` | Design tokens and Chakra UI theme |
| `src/types/` | TypeScript type definitions |
| `src/utils/` | Utility functions |

### Rust Backend (`src-tauri/`)

| Directory/File | Description |
|----------------|-------------|
| `src/commands/` | Rust command handlers (project, filesystem, terminal, search, debugger, container, MCP, git, AI, HTTP client) |
| `src/lib.rs` | Main Rust entry point, state management via `app.manage()` |
| `tauri.conf.json` | Tauri configuration |
| `Cargo.toml` | Rust dependencies |
| `resources/templates/` | Project templates (React, Next.js, Vue, Svelte, Angular, Express, NestJS, etc.) |

## Building and Running

### Prerequisites
- Node.js >= 20.19.0 (use `nvm use` or check `.nvmrc`)
- Rust toolchain
- Yarn 1.22.22

### Setup
```bash
# Install dependencies
yarn install

# Copy and fill environment variables
cp .env.example .env
```

### Development
```bash
npm run tauri dev        # Run full app in development mode (Vite + Tauri)
npm run dev              # Frontend-only dev server (port 1420)
```

### Building
```bash
npm run build            # TypeScript check + Vite build
npm run tauri build      # Full production build (desktop app)
npm run preview          # Build + preview with Wrangler (Cloudflare)
npm run deploy           # Build + deploy to Cloudflare
```

### Testing
```bash
npm test                          # Jest unit tests
npm test -- --testPathPattern="path/to/test"  # Run single test file
npm run test:watch                # Jest watch mode
npm run test:coverage             # Jest with coverage
npm run benchmark                 # Performance benchmarks
```

## Development Conventions

- **TypeScript strict mode** — All frontend code is in TypeScript with strict type checking
- **Service layer pattern** — Components → Stores → Services → Tauri invoke
- **Zustand for state management** — 19 stores with persist middleware where needed
- **Lazy loading** — Heavy components (Monaco, Debugger, Checkpoint) are lazy loaded
- **Web Workers** — Used for expensive operations (file tree indexing)
- **SSE streaming** — Agent responses use Server-Sent Events with reasoning block detection
- **Design tokens** — All styling uses `src/theme/tokens.ts` as the single source of truth
- **Dark theme** — Primary background `#0a0a0a`, brand accent `#FE1063` (pink/magenta)
- **UI quality matters** — Components should always be visually polished with proper spacing, transitions, and glassmorphism effects

## Data Persistence

| Data | Location |
|------|----------|
| Project metadata | `~/.config/toquemedia-studio/projects/{project-id}/meta.json` |
| Global settings | `~/.config/toquemedia-studio/settings.json` |
| Chat sessions | `~/.toquemedia-studio/sessions/{project-hash}/session_*.json` |
| Project ID file | `.toquemedia-id` in project root |

## Dev Server Ports

- **Frontend servers** (Vite, Next, Nuxt, etc.): port `7773`
- **Backend servers** (Express, Fastify, NestJS, etc.): port `7777`
- **Vite dev server**: port `1420`
- Always use `127.0.0.1` (not `localhost`) due to WKWebView IPv6 issues

## Project Templates

Available in `src-tauri/resources/templates/`:
- **Frontend**: `react-ts-vite`, `nextjs-ts`, `nuxt-ts`, `vue-ts-vite`, `svelte-ts-vite`, `astro`, `angular-ts`
- **Fullstack**: `react-express-ts`
- **Backend**: `express-ts`, `fastify-ts`, `nestjs-ts`

## Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Comprehensive project documentation and architecture guide |
| `package.json` | Dependencies, scripts, and project metadata |
| `vite.config.ts` | Vite build configuration with Tauri and Cloudflare plugins |
| `tsconfig.json` | TypeScript configuration with strict mode and path aliases (`@/*` → `src/*`) |
| `firebase.json` | Firebase emulator configuration |
| `wrangler.jsonc` | Cloudflare Workers configuration |
| `.env.example` | Required environment variables template |

## Agent Service Details

The agent system is orchestrated through:
- `src/services/agent/agentService.ts` — Main orchestration loop
- `src/services/agent/agentRunner.ts` — Agent execution
- `src/services/agent/toolExecutor.ts` — Tool execution with permissions and .env protection
- `src/services/agent/contextBuilder.ts` — Context assembly
- `src/services/agent/streamParser.ts` — SSE parsing with reasoning block detection
- `src/services/agent/diffService.ts` — Inline diff generation
- `src/services/agent/slashCommandRegistry.ts` — Slash command handling (`/plan`, `/init`, `/payments`)

## AI Provider Integration

The backend API (`~/dev/deskotp/toquemedia-studio-api`) acts as a proxy with billing, rate limiting, and request queuing through Cloudflare Workers.

### Active Models (Currently in Use)

Only **two models** are actively configured as defaults:

| Plan | Default Model | Provider | Context Budget |
|------|--------------|----------|----------------|
| **Free (Explorer)** | `deepseek-v4-flash` | DashScope (Alibaba Cloud) | 262,144 tokens (1M capped) |
| **Pro / Business (4x/8x)** | `glm-5.1` | OpenRouter (Z-AI) | 200,000 tokens |

### Plan-Specific Configuration

- **Free tier**: Restricted to `deepseek-v4-flash` only (efficient, no thinking mode; upstream supports 1M ctx, capped at 256K)
- **Paid tiers**: Use `glm-5.1` with toggleable reasoning, strong tool calling, and 200K context
- **Multimodal (images)**: Paid plans → Qwen 3.6 Plus analyzes images, text description sent to GLM-5.1
- **`/plan` command**: Uses `deepseek-v4-flash` as fallback for all plans (avoids billing leak on free tier)

### Available Providers (Configured but Not Default)

The backend supports multiple providers but they're not set as defaults:

| Provider | Models | API Endpoint |
|----------|--------|-------------|
| **DashScope** (Alibaba Cloud) | `deepseek-v4-flash`, `qwen3.6-plus`, `glm-5`, `kimi-k2.5`, `qwen3-coder-next`, `MiniMax-M2.5`, `step-3.5-flash` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| **OpenRouter** | `glm-5.1` (Z-AI), future models | `https://openrouter.ai/api/v1/chat/completions` |
| **MiMo** (Xiaomi) | `mimo-v2-flash` | `https://api.xiaomimemo.com/v1/chat/completions` |
| **Gemini** (Google) | `gemini-3-flash-preview`, `gemini-3-flash` | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| **StepFun** | `step-3.5-flash` | `https://api.stepfun.ai/v1/chat/completions` |

> **Note**: Many models are "dead" (kept in code for potential reactivation): `mimo-v2-flash`, `glm-5`, `qwen3-coder-next`, `MiniMax-M2.5`, `gemini-3-flash-preview`, `step-3.5-flash`

### Billing Architecture

- **Token budget**: Calculated from subscription revenue × 0.65 (35% gross margin retained)
- **Free tier**: 2,000,000 tokens/month flat cap
- **Overage**: Purchased TMS credits (1 TMS = 100,000 raw tokens)
- **Cycle**: Monthly billing cycle anchored to user's signup date
