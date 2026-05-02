# Plan: e2e testing power for the TM Code agent

**Status:** Draft for review
**Goal:** Give the agent a first-class tool to run end-to-end tests on user
projects, using Playwright as the underlying engine. Replace today's pattern
where the agent guesses test-runner commands via `execute_command` with a
dedicated, parseable interface.

---

## 1. Goals

- The agent can run e2e tests with a single tool call.
- The agent receives **structured JSON results** (passed, failed, errors,
  durations) — not raw stdout — so it can reason about failures.
- Projects without Playwright get a clear, opinionated scaffolding path the
  agent can trigger explicitly (no implicit installs).
- Works in any project that uses Playwright, regardless of framework
  (React, Vue, Svelte, plain HTML, fullstack monorepo).
- Honors the existing dev-server slot: tests target whatever URL the dev
  server is currently serving (no second server, no port collision).

## 2. Non-goals

- Cypress / WebdriverIO support (single test runner, fewer surprises).
- Mobile testing (Appium, Detox). Out of scope.
- AI-assisted exploratory testing (browser-use, Magnitude). The agent
  writes Playwright specs the normal way; LLM-driven test execution is a
  separate axis we can revisit later.
- Visual regression / screenshot diffing (Percy, Chromatic). Skip until
  there is a concrete user request.
- Auto-running tests on save / file watcher. Tests run only when the agent
  (or user) explicitly invokes them.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Agent (model)                                                │
│  └─ calls run_e2e_tests(...)                                 │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│ toolExecutor.ts → run_e2e_tests handler                      │
│  1. Detect Playwright (package.json + playwright.config.*)   │
│  2. If missing → return guidance result, do NOT auto-install │
│  3. Spawn `npx playwright test --reporter=json [filters]`    │
│  4. Parse JSON output → normalize → return                   │
│  5. Truncate large output, preserve first N failures intact  │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│ Rust (existing `execute_command`)                            │
│  Spawns the npx process, captures stdout+stderr+exit code    │
└──────────────────────────────────────────────────────────────┘
```

No new Rust code required — reuse the existing `execute_command` path.
All work is in `toolExecutor.ts` (tool definition + JSON parser) and a new
skill file under `src-tauri/resources/skills/playwright-e2e/`.

## 4. Tool spec

### Definition

```typescript
{
  name: 'run_e2e_tests',
  description: 'Run Playwright end-to-end tests in the project. Returns ' +
    'structured pass/fail counts, timing, and the first N failure details ' +
    '(error message, stack trace excerpt, file:line). Use this after ' +
    'implementing a user-facing feature to verify it works end-to-end. ' +
    'When Playwright is not installed, returns a guidance result — do not ' +
    'auto-install; ask the developer first.',
  input_schema: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description: 'Optional test name filter (passed to --grep). ' +
          'Use to narrow the run while iterating on a specific test.',
      },
      file: {
        type: 'string',
        description: 'Optional spec file path (absolute or project-relative). ' +
          'Runs only that file.',
      },
      project: {
        type: 'string',
        description: 'Optional Playwright project name (e.g. "chromium", ' +
          '"webkit"). Defaults to all configured projects.',
      },
      timeoutSecs: {
        type: 'number',
        description: 'Soft cap on total run time. Default 300 (5 min). ' +
          'Hard ceiling 900.',
      },
    },
    required: [],
  },
  concurrencySafe: false,  // tests may share state via the dev server
}
```

### Result shape

```typescript
type RunE2EResult =
  | {
      status: 'no_playwright'
      hint: string                    // "Run scaffold_e2e_tests to set up Playwright"
      detectedFiles: string[]         // what we DID find (e.g. partial config)
    }
  | {
      status: 'no_tests_found'
      searchedDirs: string[]
      hint: string
    }
  | {
      status: 'completed'
      summary: {
        passed: number
        failed: number
        skipped: number
        flaky: number
        durationMs: number
        projectsRun: string[]         // ["chromium", "webkit"]
      }
      failures: Array<{
        title: string                 // "should login with Google"
        file: string                  // "tests/auth.spec.ts"
        line: number
        project: string               // "chromium"
        errorMessage: string          // first 500 chars
        stackExcerpt: string          // first 5 stack frames inside user code
        retry: number                 // 0 = first attempt, 1+ = flake retry
      }>
      truncated: boolean              // true when > MAX_FAILURES_INLINE
      fullJsonPath?: string           // .playwright-results.json for the agent to read on demand
    }
  | {
      status: 'runner_error'
      stderr: string                  // truncated to 1KB
      exitCode: number
      hint: string
    }
```

### Execution flow

1. **Detect Playwright**
   - Walk up from `cwd` looking for `package.json` containing `@playwright/test`
     in `dependencies` or `devDependencies` (any package.json on the path —
     handles monorepo workspaces the same way the dep-finder used to).
   - Look for `playwright.config.{ts,js,mjs}` in the same directory tree.
   - Both required; either missing → `status: 'no_playwright'`.

2. **Build command**
   - Base: `npx playwright test --reporter=json --reporter=line`
   - The dual reporter writes JSON to a temp file and prints a one-line
     summary so the user sees progress in the chat console.
   - Apply filters: `--grep "${filter}"`, `<file>`, `--project=<project>`.

3. **Run with timeout**
   - Reuse `execute_command`'s timeout + abort-signal plumbing.
   - Default 300s, max 900s (Playwright's own per-test timeout still applies).

4. **Parse JSON**
   - Read the temp file (Playwright writes a structured JSON artefact).
   - Walk `suites[].suites[].specs[].tests[].results[]`.
   - Aggregate counts, extract failures, truncate to first 10 by default.
   - Save full JSON to `.playwright-results.json` (project root, gitignored)
     so the agent can `read_file` it for the long tail when needed.

5. **Return**
   - Normalized result object, JSON-stringified, capped at the regular
     tool-result truncation limit (~4000 chars). The summary + 10 failures
     fits comfortably; bigger runs reference `fullJsonPath`.

## 5. Skill: `playwright-e2e`

New file: `src-tauri/resources/skills/playwright-e2e/SKILL.md`.

Auto-load conditions (in `skillService.loadSkills`):
- Project is JS/TS (`package.json` exists), AND
- Either `@playwright/test` is in deps, OR the agent's current task mentions
  "test", "e2e", "spec" in the user message.

Content outline (~150 lines):

```markdown
---
name: playwright-e2e
description: Write and run Playwright end-to-end tests against the project's
  dev server. Tests live in `tests/` or `e2e/`. Run via the `run_e2e_tests`
  tool — it returns structured pass/fail data so you can reason about
  failures without parsing stdout.
license: MIT
---

# Playwright e2e tests

## When to run tests
- After implementing a user-facing feature (login flow, form submit, route
  change). Don't claim "done" without running the relevant e2e.
- After fixing a bug — add a regression test FIRST, then make it pass.
- Skip when the change is purely backend / non-user-facing (use unit tests
  instead).

## File layout
- `tests/<feature>.spec.ts` — one spec per feature
- `playwright.config.ts` — points `baseURL` to the dev server (7773 for TM
  Code projects, framework default otherwise)
- `tests/fixtures/` — shared setup (auth state, test data)

## Writing a test (skeleton)
\`\`\`typescript
import { test, expect } from '@playwright/test'

test.describe('Auth flow', () => {
  test('signs in with Google', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /continuar com google/i }).click()
    // ... assertions
  })
})
\`\`\`

## Running
- Full suite: `run_e2e_tests({})`
- Single file: `run_e2e_tests({ file: 'tests/auth.spec.ts' })`
- By name: `run_e2e_tests({ filter: 'signs in' })`
- Specific browser: `run_e2e_tests({ project: 'chromium' })`

## Reading failures
The tool returns `failures[]` with file:line, error message, and stack
excerpt. Quote those locations to the developer when reporting. Don't dump
raw stack traces.

## Scaffolding (when Playwright is missing)
Tool returns `status: 'no_playwright'`. Ask the developer once before
running `npm init playwright@latest`. Default config: `tests/`,
TypeScript, chromium-only (faster iteration).

## Hard rules
- Tests target the running dev server. Start the dev server first
  (`start_dev_server`) — don't spawn a second one.
- Headless by default. The headed mode is for the developer to debug
  manually — agent never asks for it.
- Never commit `.playwright-results.json` or `playwright-report/` —
  add to `.gitignore` if scaffolding.
```

## 6. Scaffolding

Out of scope for the tool itself — the agent runs `npm init playwright@latest`
via `execute_command` when the user agrees. The skill documents this so the
agent doesn't reinvent the install commands.

Optional follow-up: a separate `scaffold_e2e_tests` tool that wraps
`npm init playwright@latest --yes` with sensible defaults (TypeScript,
`tests/` directory, chromium only). Defer to V2 — manual scaffolding is
fine for the first cut.

## 7. Integration steps

| # | File | Change | Lines |
|---|---|---|---|
| 1 | `src/services/agent/toolExecutor.ts` | Register `run_e2e_tests` tool, implement detection + JSON parse | ~150 |
| 2 | `src-tauri/resources/skills/playwright-e2e/SKILL.md` | New skill file | ~150 |
| 3 | `src/services/agent/skillService.ts` | Add auto-load condition for the new skill | ~10 |
| 4 | `src/services/agent/contextBuilder.ts` | Mention `run_e2e_tests` in §7 (Using your tools) | ~3 |
| 5 | `src-tauri/tauri.conf.json` | Add `playwright-e2e` to bundled skills (already covered by `resources/skills/**/*` glob) | 0 |
| 6 | `.gitignore` (template) | Add `.playwright-results.json` + `playwright-report/` to scaffolded projects | docs only |
| 7 | Tests | Unit tests for the JSON parser (mock Playwright output, assert normalization) | ~80 |

Total: ~400 lines added, no Rust changes, no new dependencies in TM Code
itself.

## 8. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Playwright `--reporter=json` schema changes between versions | Low | Pin against the schema version we test; fall back to parsing line reporter on schema mismatch |
| Agent runs the suite in a tight loop while iterating on a fix | Medium | Tool default timeout 300s; combine with the existing in-flight tool blocking so two calls can't overlap |
| Large test suites blow the chat result budget | Medium | Truncate to first 10 failures inline, full JSON readable on demand |
| Tests need auth state (login first) → flaky if dev server restarted between runs | Medium | Skill teaches `storageState` + setup spec pattern; document in failure messages where appropriate |
| First Playwright run downloads ~400MB of browsers | Low | Surface a clear progress message; the existing `executeInstallStreaming` handles long-running commands gracefully |
| Agent invokes `run_e2e_tests` without dev server running | Medium | Tool checks `useLayoutStore.getState().devServer` first, returns `runner_error` with hint to start it |

## 9. Testing strategy (for TM Code itself)

- **Unit tests** for the Playwright JSON parser using a fixture corpus:
  - empty suite, all-pass, mixed pass/fail, flake retry, timeout, runner-crash
- **Integration test** that spawns a tiny Playwright project with one
  passing + one failing test and verifies the tool returns the right shape
- **Manual smoke**: run on `~/dev/tms-projects/BugHunter` after this lands —
  the auth implementation is half-broken, perfect for verifying that
  `run_e2e_tests` correctly reports the breakage

## 10. Future extensions (post-V1)

- `scaffold_e2e_tests` tool with opinionated defaults (TypeScript, chromium
  only, fixtures dir, GitHub Actions workflow snippet)
- Playwright trace viewer integration — open a `.zip` trace in the user's
  browser when a test fails so the developer can step through
- Visual regression mode (Playwright `toHaveScreenshot()`) — separate tool
  with explicit baseline management
- Hybrid mode: when a test fails on a UI assertion, capture a screenshot +
  pass to a vision model for "does this look right?" — only if there's
  proven value vs cost
- Cypress backend — only if a user explicitly demands it; not worth the
  surface area for V1

## 11. Out of scope (explicit)

- Browser-use / Magnitude / WebQA agents (LLM-driven exploratory testing)
- Mobile testing (Appium, Detox)
- Performance testing (k6, Lighthouse) — separate concern, separate tool
- Mutation testing (Stryker, etc.)
- Test generation by AI (write the test, then run it). The agent already
  writes specs as part of the normal feature implementation flow — no
  special tool needed.

---

## Open questions for review

1. **Auto-install browsers?** First Playwright run hits `npx playwright
   install chromium` which downloads ~150MB. Should the tool detect this
   and prompt, or let the agent handle it explicitly via the existing
   install path? Leaning: explicit (no surprise downloads).

2. **Headed mode?** Useful when the user is debugging a test interactively.
   Out of scope for the agent's tool, but worth a separate flag in the
   `scaffold_e2e_tests` follow-up so the user can run `npm run test:e2e:debug`
   themselves.

3. **Default browser projects?** Playwright defaults to chromium + firefox +
   webkit. For agent iteration speed, scaffold with chromium-only and
   document how to add the others. User can opt-in later.

4. **Where do test results persist?** Currently planning
   `.playwright-results.json` in project root. Alternative:
   `~/.toquemedia-studio/test-results/<project-id>/`. Project root is
   simpler but pollutes the user's repo (mitigate via .gitignore).

5. **Permissioning?** Should `run_e2e_tests` go through the dangerous-command
   approval flow? It runs user code, can hit the network (real-world
   side effects if tests touch external APIs). Lean: yes, require approval
   the first time per session, then auto-approve subsequent calls.
