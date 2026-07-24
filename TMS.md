# TMS.md

## Overview
- TM Code is a React + TypeScript desktop IDE packaged with Tauri.
- Product focus: agent-first coding workflows, chat/CMD agent modes, project context, tool execution, previews, billing/BYOK, and desktop release packaging.
- Related projects:
  - worker: `~/dev/deskotp/toquemedia-studio-api`
  - web: `~/dev/web/toquemedia-studio`
  - claude-vaz: `~/dev/claude-vaz`

## Stack
- Frontend: React 19, TypeScript, Vite 8, Chakra UI v3, Zustand, TanStack Query, Monaco Editor, xterm.js.
- Desktop: Tauri 2, Rust 2021, tauri plugins for fs/dialog/process/notification/opener/updater.
- Workers: Cloudflare Workers under `workers/ai-pass-through` and `workers/collab-signaling`.
- Tests: Jest 30 with ts-jest/jsdom for app code; `tsx --test` for the AI pass-through worker.
- Package manager: Yarn 1.22.22. Node engine: `>=20.19.0`.
- Current app version: `0.8.5` in `package.json` and `src-tauri/Cargo.toml`.

## Commands
- Install: `yarn install`
- Frontend dev: `yarn dev`
- Desktop dev: `yarn tauri dev`
- App build: `yarn build`
- Mac ARM64 production build: `yarn tauri:build:mac-arm64`
- Windows x64 production build: `yarn tauri:build:win-x64`
- Jest: `yarn test`
- Jest watch: `yarn test:watch`
- Jest coverage: `yarn test:coverage`
- AI worker dev: `yarn dev:ai-worker`
- AI worker tests: `yarn test:ai-worker`
- AI worker typecheck: `yarn --cwd workers/ai-pass-through typecheck`
- Collab worker dev/tests: `yarn dev:collab-worker`, `yarn test:collab-worker`

## Structure
- `src/components`: React UI by feature area plus shared UI primitives.
- `src/hooks`: React hooks for editor, files, billing, BYOK, queues, keyboard, and runtime concerns.
- `src/services`: app services, agent orchestration, Tauri wrappers, MCP, deploy, file/editor/runtime logic.
- `src/services/agent`: agent loop, prompt/context builder, tool selection, tool execution, TMS bootstrap, telemetry.
- `src/stores`: Zustand stores for app, chat/agent, layout, files, billing, BYOK, MCP, deploy, and feature state.
- `src/theme` and `src/themes`: Chakra/system theme tokens and ToqueMedia theme code.
- `src/types` and `src/utils`: shared types and utilities.
- `src-tauri`: Rust/Tauri native backend and commands.
- `workers/ai-pass-through`: managed LLM/BYOK Cloudflare Worker.
- `workers/collab-signaling`: collaboration signaling Worker.
- `public`: static assets and browser workers.
- Tests are colocated in `__tests__` folders or named `*.test.ts(x)`.

## EntryPoints
- Frontend app: `src/main.tsx`, `src/App.tsx`.
- Agent service path: `src/services/agent/agentService.ts`, `src/services/agent/query.ts`, `src/services/agent/toolExecutor.ts`.
- Prompt/context system: `src/services/agent/contextBuilder.ts`, `src/services/agent/contextBuilder/sections/*`, `src/services/agent/contextBuilder/auxiliaryRegistry.ts`.
- Tool profile system: `src/services/agent/toolsetSelector.ts`.
- TMS bootstrap and telemetry: `src/services/agent/tmsBootstrap.ts`, `src/services/agent/tmsContext.ts`.
- Desktop backend: `src-tauri/src/lib.rs` and command modules under `src-tauri/src/commands`.
- AI worker: `workers/ai-pass-through/src/index.ts`.

## Project Patterns
- Prefer the `@/` alias for imports from `src`.
- React components are PascalCase; hooks are named `useSomething`; services use `somethingService.ts`.
- Keep tests focused and close to the changed feature.
- Agent context should use small indexed/on-demand sections before broad project context.
- `TMS.md` is injected in full in the static system prompt (provider prompt-cache); do not re-request it via `request_context`.
- `request_context` covers auxiliaries such as `project.symbol_index`, `project.structure_overview`, design-system blocks, and `project.docs_full` (README/PLAN/TODO — not a substitute for re-reading TMS).
- `TMS.md` is operational memory, not a milestone log. Keep it short; update durable facts at FINAL CHECKPOINT of a significant task.
- Update `TMS.md` only when durable commands, entrypoints, patterns, agent rules, confirmed facts, or pending confirmations change.

## Agent Rules
- Before editing an existing file, inspect the relevant current file/range first.
- Use search/list/symbol-index style navigation before broad reads when the target is unknown.
- Use Read/Grep/Glob/LS-style file tools for source inspection. Avoid shell `cat`, `head`, `tail`, `sed`, `grep`, or `rg` through command execution for normal source reading.
- Use shell commands for validation, builds, tests, git diagnostics, and runtime commands.
- Preserve user changes in the worktree. Do not revert unrelated files.
- Use `apply_patch` for manual file edits.
- Run focused tests for agent/runtime changes; run `yarn build` for broad TypeScript or frontend changes when feasible.
- For `workers/ai-pass-through`, run `yarn test:ai-worker` and `yarn --cwd workers/ai-pass-through typecheck` when changing worker logic.

## Confirmed
- `/init` expects the compact TMS structure used in this file.
- Existing valid TMS files should not be recreated or repaired on every user message.
- Missing TMS creation is handled by explicit project bootstrap, not by normal task reminders.
- `read_file` behavior is designed to avoid waste: exact-range unchanged reads can return a stub, large files are guarded, binary extensions are rejected, and line-numbered output is used when practical.
- The agent loop has a read-before-write guard and a no-edit recovery guard for mutable bugfix tasks.
- Dynamic tool selection starts with a small toolset and can expand via `request_tools`.
- Auxiliary context selection keeps broad/high-cost context on demand through `request_context`.
- Team BYOK pool accounting should use the shared team pool, not per-member slices.

## Inferred
- CMD mode has lighter context gating than chat mode, so TMS guidance in CMD must stay especially compact.

## Pending Confirmation
- None currently known.

## lastGeneratedAt
2026-07-01

## sourceFilesUsed
- `AGENTS.md`
- `package.json`
- `workers/ai-pass-through/package.json`
- `src-tauri/Cargo.toml`
- `src/services/agent/commands/initCommand.ts`
- `src/services/agent/contextBuilder.ts`
- `src/services/agent/contextBuilder/auxiliaryRegistry.ts`
- `src/services/agent/contextBuilder/sections/chatSections.ts`
- `src/services/agent/contextBuilder/sections/cmdSections.ts`
- `src/services/agent/contextBuilder/tmsSectionContext.ts`
- `src/services/agent/agentService.ts`
- `src/services/agent/toolsetSelector.ts`
- `src/services/agent/tmsBootstrap.ts`
- previous `TMS.md`
