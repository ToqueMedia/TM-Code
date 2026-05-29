# AGENTS.md

## What this is

Tauri 2 desktop IDE (Rust backend + React 19 / TypeScript frontend). Chat-first AI agent interface — the agent writes code, shows diffs, runs terminals, opens previews. Monaco editor is secondary mode.

Internal name: `toquemedia-studio`. UI name: "TM Code".

## Commands

```bash
# Install (uses Yarn 1.22.22, NOT npm)
yarn install

# Dev — full app (Vite + Tauri)
npm run tauri dev

# Dev — frontend only (Vite, port 1420)
npm run dev

# Build
npm run build          # tsc + vite build
npm run tauri build    # full production build

# Tests
npm test               # Jest (single run)
npm run test:watch     # Jest watch
npm run test:coverage  # Jest with coverage

# Tauri CLI passthrough
npm run tauri <subcommand>
```

## CI checks (must pass before merge)

Frontend: `npx tsc --noEmit` → `yarn test` → `yarn build`
Backend: `cargo fmt -- --check` → `cargo clippy -- -D warnings` → `cargo build` → `cargo test`

Run backend checks from `src-tauri/`:
```bash
cd src-tauri && cargo fmt -- --check
cd src-tauri && cargo clippy -- -D warnings
cd src-tauri && cargo test
```

## Path aliases

`@/*` and `~/` both resolve to `src/` (configured in tsconfig.json paths + jest moduleNameMapper). Use `@/` in new code.

## Testing

- Jest 30, ts-jest, jsdom environment
- Tests live in `__tests__/` directories alongside source, or as `*.test.ts` / `*.test.tsx` files
- Setup file: `src/components/__tests__/setupTests.ts`
- CSS modules mocked via `identity-obj-proxy`
- Vite env utils mocked at `src/utils/__mocks__/viteEnv.ts`
- tsconfig for tests (`tsconfig.test.json`) uses `moduleResolution: node` + `commonjs` — differs from app tsconfig

## Architecture

```
Frontend (React/TS) → Tauri IPC (invoke) → Rust commands
```

- **Components**: `src/components/` — React UI split by domain (chat, editor, views, dialogs, welcome, etc.)
- **Stores**: `src/stores/` — Zustand state management
- **Services**: `src/services/` — Tauri command wrappers and business logic
- **Rust entry**: `src-tauri/src/lib.rs` — registers all commands, manages shared state
- **Rust commands**: `src-tauri/src/commands/` — 23 modules (filesystem, terminal, git, deploy, mcp, debugger, etc.)
- **Resources**: `src-tauri/resources/templates/` and `src-tauri/resources/skills/` — bundled into the app

## Tauri specifics

- Dev server URL: `http://localhost:1420` (Vite, fixed port, strictPort)
- macOS private API enabled (for vibrancy/frameless window)
- Preview webview is a child `wry::WebView` managed via global static (`lib.rs`)
- `tauri-plugin-localhost` serves prod build on port 14300 (not used in dev)
- Platform-specific deps: macOS uses objc2 + window-vibrancy, Windows uses window-vibrancy, Linux needs system libs (webkit2gtk, libgtk-3, etc.)
- `tauri-plugin-updater` uses native-tls (not rustls) to avoid `ring` crate on Windows ARM64

## Environment

Required `.env` variables (see `.env.example`):
- `VITE_FIREBASE_*` — Firebase config for auth
- `VITE_WORKER_URL` — Backend worker URL for agent API

## Code style

- TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`)
- No ESLint or Prettier config — TypeScript compiler is the quality gate
- Rust: default rustfmt, clippy with `-D warnings`
- Chakra UI v3 for components, Framer Motion for animations
- Dark theme only — colors in `src/theme/tokens.ts`

## Multi-instance

`open_new_instance()` spawns a separate OS process (no `tauri-plugin-single-instance`). Each instance has independent Rust state and Zustand stores; they share Firebase auth via IndexedDB.

## Key files

- `CLAUDE.md` — comprehensive architecture docs, persistence model, deploy pipeline, design system
- `src-tauri/tauri.conf.json` — Tauri config (version, bundle, updater, plugins)
- `src-tauri/Cargo.toml` — Rust dependencies with platform-specific notes
- `vite.config.ts` — Vite config with Monaco worker chunking
- `jest.config.json` — test config with path alias mapping
