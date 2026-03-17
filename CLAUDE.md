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
yarn install              # Install dependencies (uses Yarn 1.22.19, NOT npm)
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

- **Components** (`src/components/`): React UI — `CodeEditorNew.tsx` is the main editor layout, `WelcomeScreen.tsx` is the landing page. Dialogs live in `components/dialogs/`, reusable UI in `components/ui/`.
- **Stores** (`src/stores/`): Zustand state — `projectStore.ts` (workspace/project state), `editorStore.ts` (tabs/active file), `settingsStore.ts` (preferences), `fileTreeStore.ts`.
- **Services** (`src/services/`): Tauri command wrappers — `fileService.ts`, `projectService.ts`, `terminalService.ts`, `searchService.ts`, `debuggerService.ts`.
- **Rust Commands** (`src-tauri/src/commands/`): `project.rs`, `file_tree.rs`, `terminal.rs`, `search.rs`, `debugger.rs`. Module exports in `mod.rs`.

### Data Persistence
- Project metadata: `~/.config/toquemedia-studio/projects/{project-id}/meta.json`
- Global settings: `~/.config/toquemedia-studio/settings.json`
- Chat sessions: `~/.toquemedia-studio/sessions/{project-hash}/session_*.json`
- Project ID file: `.toquemedia-id` in project root

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Chakra UI v3, Monaco Editor, Zustand, xterm.js, Framer Motion
- **Backend**: Rust (edition 2021), Tauri 2, tokio, serde
- **Build**: Vite 8, ts-jest for testing
- **Package Manager**: Yarn 1.22.22 (Node >= 20.19.0)

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
- Lazy loading for heavy components (Monaco, Debugger)
- Web Workers for expensive operations (file tree indexing)
- **UI quality is not over-engineering.** Components should always be visually polished, using `tokens.ts` design tokens, proper spacing, transitions, and glassmorphism effects. "Avoid over-engineering" means no unnecessary abstractions or extra features — not skipping visual polish.
