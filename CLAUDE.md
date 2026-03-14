# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Diamond IDE (internal name: `toquemedia-studio`) — a cross-platform desktop IDE built with **Tauri 2** (Rust backend) + **React 19** (TypeScript frontend). Features Monaco-based code editor, integrated terminal, file explorer, debugger, and search.

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
- Project ID file: `.toquemedia-id` in project root

## Tech Stack

- **Frontend**: React 19, TypeScript 5.8, Chakra UI v3, Monaco Editor, Zustand, xterm.js, Framer Motion
- **Backend**: Rust (edition 2021), Tauri 2, tokio, serde
- **Build**: Vite 7, ts-jest for testing
- **Package Manager**: Yarn 1.22.19 (Node >= 20.19.0)

## Design System

Dark theme with GitHub-inspired palette:
- Backgrounds: `#0a0e13` (welcome), `#0d1117` (editor)
- Primary text: `#e6edf3`, secondary: `#8b949e`
- Accent colors: blue `#58a6ff`, purple `#a371f7`, green `#2ea043`, orange `#f77f00`
- Borders: `rgba(48, 54, 61, 0.8)`
- Glassmorphism effects with backdrop blur

## Conventions

- All frontend code in TypeScript (strict mode)
- Chakra UI v3 for UI components
- Zustand for state management (with persist middleware where needed)
- Service layer pattern: components → stores → services → Tauri invoke
- Lazy loading for heavy components (Monaco, Debugger)
- Web Workers for expensive operations (file tree indexing)
