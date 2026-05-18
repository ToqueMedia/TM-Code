# Slice plan — `contextBuilder.ts` + `toolExecutor.ts`

**Status:** Plan / awaiting go-ahead before edits
**Date:** 2026-05-18

Both files are now at the size where new edits routinely require scrolling past dozens of unrelated sections. `contextBuilder.ts` is 1 745 lines; `toolExecutor.ts` is 3 797. Together they account for ~5 500 of the ~25 000 lines under `src/services/`.

## Goals

- **No behavioural change.** Same prompt output byte-for-byte; same tool registrations; same call sites.
- **Smaller surface per file.** Each split file under ~500 lines, with one responsibility.
- **Same import surface from outside.** External callers (`agentService.ts`, `agentRunner.ts`, sub-agents) continue to import `ContextBuilder` and `ToolExecutor` exactly as before — the slice is internal.
- **Tests stay green.** `contextBuilder.test.ts` (22 tests) and the toolExecutor-adjacent tests must pass without modification after each step.

## Constraints

- Class state stays where it lives today. Helpers move out as pure functions or external modules; instance methods stay on the class if they read/write `this.*`.
- No new abstractions on the way in. Don't add a `ToolRegistry` interface; don't introduce a `PromptSectionContext`. The goal is moving code, not redesigning it.
- Each commit must compile and pass tests independently — easier to revert one step than five.

## `contextBuilder.ts` — proposed slice

Current shape: one `ContextBuilder` class with two public methods (`buildSystemPrompt`, `buildCmdModeSystemPrompt`) and ~40 private `getXxxSection` helpers, half for chat mode and half for cmd mode. Plus several module-level helpers (`extractCriticalSections`, vocabulary renderers, language directives).

### Target layout

```
src/services/agent/contextBuilder/
  index.ts                              // public re-exports — same surface as today
  ContextBuilder.ts                     // the class itself (~400 lines after slice)
                                         //   - constructor, fields, buildSystemPrompt,
                                         //     buildCmdModeSystemPrompt orchestration
                                         //   - thin wrappers that delegate to sections/*
  sections/
    chatRole.ts                         // getRoleSection, getModelSpecificSection
    chatSystem.ts                       // getSystemSection, getDoingTasksSection,
                                         //   getExecutingActionsSection, getClosedLoopSection
    chatTools.ts                        // getToolsSection
    chatEnvironment.ts                  // getEnvironmentSection, getTemplateContextSection,
                                         //   getProjectStructureSection, getReadmeSection,
                                         //   getProjectMemorySection, getActivePlanSection,
                                         //   getTaskListSection, getMemoryGuidanceSection,
                                         //   getSkillsSection, getAppliedScaffoldingSection
    chatPublishing.ts                   // getPublishingSection (single largest section,
                                         //   ~200 lines on its own)
    chatConstraints.ts                  // getConstraintsSection, getReminderSection,
                                         //   getCompletionContractSection
    cmdMode.ts                          // all getCmd* methods together — the cmd-mode prompt
                                         //   is small enough (~250 lines) that splitting it
                                         //   further than this isn't worth it
  helpers.ts                            // extractCriticalSections, renderBrandVocabularyXml,
                                         //   sharedUiBaseline, language-directive builders,
                                         //   and the SYSTEM_PROMPT_DYNAMIC_BOUNDARY constant
```

### Function signatures for section files

Each section file exports pure functions. They receive whatever subset of `PromptContext` they need plus any pre-computed values (skills list, applied scaffolding, etc.) — they do **not** receive the class instance:

```ts
// chatPublishing.ts
export function getPublishingSection(): string { ... }

// chatEnvironment.ts
export function getEnvironmentSection(ctx: PromptContext): string { ... }
export function getAppliedScaffoldingSection(ctx: PromptContext): string | null { ... }
// ...
```

The class then becomes a thin orchestrator:

```ts
// ContextBuilder.ts
import { getRoleSection, getModelSpecificSection } from './sections/chatRole'
import { getPublishingSection } from './sections/chatPublishing'
// ...

class ContextBuilder {
  async buildSystemPrompt(...) {
    // ...
    const parts: string[] = [
      getRoleSection(ctx),
      getModelSpecificSection(ctx),
      // ...
      getPublishingSection(),
      // ...
    ]
    return parts.filter(Boolean).join('\n\n')
  }
}
```

### Why this split (and not by mode-then-domain)

Cmd mode is small enough that splitting it across role/system/tools/env files would create five 50-line files. Keeping it as `cmdMode.ts` matches its size and means future cmd-mode-only changes touch one file.

Chat mode is large enough that the per-domain split actually helps: the publishing section (which gets touched every time deploy/Turso/Dockerfile rules change) is now in its own file; the constraints section (touched on every UX rule change) is separate from environment (touched when project-state shape changes).

### Step-by-step

Each step is a single commit that compiles + tests pass.

1. Move module-level constants and helpers to `contextBuilder/helpers.ts`. Import from the existing file.
2. Move `cmdMode.ts` first — fully self-contained, no cross-dependencies on chat sections.
3. Move `chatPublishing.ts` — also self-contained.
4. Move `chatRole.ts`, `chatSystem.ts`, `chatTools.ts`, `chatConstraints.ts`.
5. Move `chatEnvironment.ts` (depends on memory + plan helpers but those came in step 1).
6. Rename the orchestrator file `contextBuilder.ts → contextBuilder/ContextBuilder.ts` and add `contextBuilder/index.ts` to re-export everything callers need.

Expected diff per step: ~200–400 lines moved, zero logic changes.

## `toolExecutor.ts` — proposed slice

Current shape: one `ToolExecutor` class with:
- ~24 `this.tools.set('toolName', { definition, execute })` registrations
- ~15 helper methods (`validatePathWithinProject`, `checkForbidden*`, `isEnvFile`, `simpleHash`, `getProjectRoot`, `refreshFileTree`, ...)
- A handful of public methods that the rest of the agent loop relies on (`execute`, `getToolDefinitions`, `enableCmdMode`, `enterReadOnlyMode`, `registerMCPTools`, ...)

### Target layout

```
src/services/agent/toolExecutor/
  index.ts                              // re-exports ToolExecutor + types
  ToolExecutor.ts                       // class (~600 lines after slice)
                                         //   - constructor, state fields, mode flags,
                                         //     execute(), getToolDefinitions(),
                                         //     enableCmdMode, enterReadOnlyMode, register()
                                         //   - calls registerXxxTools() helpers from tools/*
  tools/
    filesystem.ts                       // read_file, write_file, edit_file, create_file,
                                         //   create_directory, delete_file, rename_file,
                                         //   list_directory, search_files, glob
    web.ts                              // web_search, web_fetch
    execution.ts                        // execute_command, start_dev_server, get_diagnostics,
                                         //   read_dev_server_logs, read_large_result, read_skill
    provisioning.ts                     // provision_auth, provision_database, provision_deploy,
                                         //   request_credentials
    agents.ts                           // research, spawn_background_agent, update_tasks,
                                         //   check_background_agents, verify
    mcp.ts                              // registerMCPTools (currently inline in the class)
  guards/
    pathValidation.ts                   // validatePathWithinProject, isEnvFile
    forbiddenPatterns.ts                // checkForbiddenAuthImports, checkForbiddenItkV2,
                                         //   checkForbiddenServiceAccountImport,
                                         //   checkForbiddenDockerfileShape,
                                         //   checkForbiddenDataLayerDeps
                                         //   (most of these already live in a sibling file
                                         //   — consolidate here so the registrations import
                                         //   from one place)
    readTracking.ts                     // readFileTimestamps map + simpleHash + update helper
```

### Tool registration shape

Each `tools/*.ts` file exports a `registerXxx(executor)` function that calls `executor.register('name', { definition, execute })`:

```ts
// tools/filesystem.ts
import type ToolExecutor from '../ToolExecutor'
import { validatePathWithinProject } from '../guards/pathValidation'
import { checkForbiddenAuthImports } from '../guards/forbiddenPatterns'

export function registerFilesystemTools(executor: ToolExecutor): void {
  executor.register('read_file', {
    definition: { ... },
    execute: async (input) => { ... },
  })
  // ... write_file, edit_file, etc.
}
```

The class exposes a thin `register(name, tool)` method (today it's `this.tools.set(name, tool)` inline — same thing, just public). The constructor calls each `registerXxxTools(this)` in sequence:

```ts
class ToolExecutor {
  private tools = new Map<string, RegisteredTool>()

  constructor() {
    registerFilesystemTools(this)
    registerWebTools(this)
    registerExecutionTools(this)
    registerProvisioningTools(this)
    registerAgentTools(this)
  }

  register(name: string, tool: RegisteredTool): void {
    this.tools.set(name, tool)
  }
  // ...
}
```

### Helpers that stay on the class

These read or mutate `this.*` state — they stay on the class, but their bodies can be thinned by extracting pure helpers:

- `validatePathWithinProject` — reads `this.cmdModeCwd` / `useProjectStore`. Stays as instance method; the actual path-prefix check moves to `guards/pathValidation.ts` as a pure function.
- `enableCmdMode` / `disableCmdMode` / `enterReadOnlyMode` / `exitReadOnlyMode` — pure state mutation, stay on class.
- The `readFileTimestamps` map and `updateReadStateAfterWrite` — stay on class but the hash function moves to `guards/readTracking.ts`.

### Step-by-step

1. Move `forbiddenPatterns` checks into `guards/forbiddenPatterns.ts` (most live in a sibling `forbiddenPatterns.ts` file already; consolidate). Update the class to import from one place.
2. Move `simpleHash` + the `readFileTimestamps` declarations to `guards/readTracking.ts`.
3. Add a public `register(name, tool)` method on the class. Wire it through every existing `this.tools.set(...)` call as a one-line search-replace (keeps each set call working, lets sub-files use the same hook).
4. Move filesystem tool registrations to `tools/filesystem.ts`. Constructor calls `registerFilesystemTools(this)`.
5. Repeat for web, execution, provisioning, agents.
6. Rename `toolExecutor.ts → toolExecutor/ToolExecutor.ts` and add the index barrel.

Each step preserves byte-for-byte tool behaviour; the slice is purely a file-layout change.

## Risk + rollback

- Every step is one commit. If a step breaks tests, `git revert` that single commit and the rest stays intact.
- The TypeScript compiler catches missing imports / removed references — `npx tsc --noEmit` after each move is the primary safety net.
- Sub-agent tests (verifyAuthFlow, planCommand, authCommand) import `ToolExecutor.getInstance()` — that singleton accessor must continue to exist on the class. Confirmed it does today.
- The `provision_database` tool added in this same release sits in `tools/provisioning.ts` after the slice — no extra work to integrate.

## What this slice does NOT do

- It does not change the prompt content. The publishing/auth/data-layer rules are the same.
- It does not change tool semantics. `provision_auth` still writes the same env vars, `execute_command` still has the same flag-block rules.
- It does not move logic into the worker. The CMD-mode / chat-mode split is preserved.
- It does not add tests. The existing 22 contextBuilder tests + the toolExecutor-adjacent suites are the ratchet; new tests are out of scope for the move.

## Acceptance

- `npx tsc --noEmit` clean after each step.
- All existing tests pass after each step (no test files touched).
- After the final step, no file under `src/services/agent/` exceeds 700 lines except `ToolExecutor.ts` and `ContextBuilder.ts` orchestrators (which should each land around 500–600 lines).
- A `git diff main..slice-branch` shows only file moves + new barrel files; no semantic line changes.

## Go-ahead checklist

Before I start moving code:

1. Confirm the target layout (Section "Target layout" for each file).
2. Confirm the slice is acceptable in 8–12 commits (one per step) on a feature branch.
3. Confirm CI / test gates apply (TS + jest only — no Rust changes).
4. Pick a window when no one else is editing these two files (the merge conflicts on a slice mid-stream are painful).
