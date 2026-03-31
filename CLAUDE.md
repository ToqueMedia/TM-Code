# CLAUDE.md

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

### Dev Server Ports
- Frontend servers (Vite, Next, Nuxt, etc.): port `7773`
- Backend servers (Express, Fastify, NestJS, etc.): port `7777`
- Always use `127.0.0.1` (not `localhost`) due to WKWebView IPv6 issues

## Tech Stack

- **Frontend**: React 19.2, TypeScript ~5.9, Chakra UI v3, Monaco Editor 0.55, Zustand 5, xterm.js 6, Framer Motion 12, TanStack Query 5, React Markdown, Firebase 12
- **Backend**: Rust (edition 2021), Tauri 2 (macOS private API), tokio, serde, reqwest 0.12
- **Build**: Vite 8, Jest 30 + ts-jest for testing
- **Package Manager**: Yarn 1.22.22 (Node >= 20.19.0)

## Project Templates

Available in `src-tauri/resources/templates/`:
- **Frontend**: `react-ts-vite`, `nextjs-ts`, `nuxt-ts`, `vue-ts-vite`, `svelte-ts-vite`, `astro`, `angular-ts`
- **Fullstack**: `react-express-ts`
- **Backend**: `express-ts`, `fastify-ts`, `nestjs-ts`

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
