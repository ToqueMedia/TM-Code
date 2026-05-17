# Sub-Agents (`task` tool) — Plano v0.7.0

> Author: Architecture review
> Date: 2026-05-16
> Status: PLANNED — not started
> Target release: 0.7.0
> Complexity: FULLSTACK (AgentService, ToolExecutor, ChatStore, UI, prompts)
> **Source of truth:** this plan is a ~90% port of [claude-vaz](https://github.com/anthropics/claude-vaz)'s `tools/AgentTool/` system (the `Task` tool surfaced as "Agent" in Claude Code). Names, vocabulary, type shape, and design decisions follow the upstream architecture where they fit TM Code's existing surface. Departures are flagged with **"Departure from claude-vaz"** so reviewers can see exactly where we diverge and why.

## 1. Context

**Current state:** TM Code's agent is a singleton (`AgentService.getInstance()`). Every turn — chat-mode (`runAgentInternal` with `projectPath`) and terminal-mode (`runAgentInternal` with `cmdOnlyMode + cmdCwd`) — runs in one conversation: the main agent reads skills, fetches web pages, greps the codebase, writes diffs, all into the same context. There is one history, one streaming pool, one set of stores. The only existing exception is `AgentService.createLightweight(options)` used by `/te2e` browser automation; it builds a separate `AgentService` instance with a stripped-down tool surface and still writes into the main `chatStore`. That is the closest thing we have to a sub-agent today — it predates this plan and stays untouched (Section 7 — "Lightweight agent untouched").

**Problem:** the singleton model burns context that doesn't need to be there. Two failure modes are documented:

- **`/plan` runaway (sess_1778931389233_p1v9ao, 2026-05-16)** — the architect did `read_skill('auth-proxy')` (~37 KB) + 4 `read_large_result` (~30 KB each, separately fixed in 0.6.2) + 3 `web_search` + 5 `web_fetch`. The model emitted a "Let me write the PLAN.md" preamble and stopped without calling `write_file`. The raw content of the auth-proxy skill plus 5 Inception/Mercury 2 doc pages sat in context until reasoning + output budget collapsed before the deliverable landed.
- **Long sessions (anecdotal)** — half-hour debug session followed by `/plan` loads the architect prompt on top of every previous turn. The plan turn carries debugging context that is irrelevant to architecture work.

claude-vaz solves this with the `Task` tool: the parent agent calls `Task(subagent_type='Explore', prompt='...')` which spawns a fully-isolated agent loop, runs to completion, and returns only the final text. The parent never sees the intermediate research. This plan ports that surface into TM Code.

**System boundary:** affects `agentService.ts` (sub-agent factory), `toolExecutor.ts` (new `task` tool + gating), `chatStore.ts` (sub-agent run association), `contextBuilder.ts` (`task` documented in system prompt for both chat-mode and cmd-mode), the chat UI (`SubAgentCard`), and the `/plan` + `/debug` prompts. Does NOT touch the streaming protocol with the worker, the billing path, MCP servers, the file watcher, native window code, or anything in `src-tauri`.

## 2. Goals & Non-Goals

### Goals

1. The main agent can spawn a **disposable** sub-agent that runs in its own context, returns only a final text answer, and does not pollute the parent's conversation history. (claude-vaz `Task` tool, isolated mode.)
2. Sub-agents work in **both Chat Mode and Terminal Mode** — the parent's `cmdOnlyMode` flag propagates to the sub-agent, with the same CWD and the same tool-surface restrictions cmd-mode already enforces.
3. Two built-in sub-agent types ship: `Explore` (read-only codebase) and `Research` (web + skills, no codebase writes). Built-in only — no custom/plugin agents in 0.7.0.
4. The `/plan` architect prompt is updated to use `Task(subagent_type='Research', ...)` for unfamiliar APIs instead of inlining `web_fetch` calls.
5. Sub-agent progress is visible to the user (collapsible card in chat showing tool calls + final summary) — never a black box.
6. A sub-agent that exceeds `maxTurns` or `maxWallClockMs` is killed cleanly; the parent receives a partial result with an explicit truncation reason.
7. Token accounting attributes sub-agent usage to the parent's billing envelope. Single envelope per user — sub-agent calls bill the same way main-agent calls do.
8. The system prompts of both the main IDE agent and the architect explicitly document `task` with a few-shot example. Without the few-shot, the model under-uses new tools (empirically validated across prior prompt changes — see `commands/planCommand.ts` getReminder rationale comments).

### Non-Goals — explicit, each tied to a claude-vaz feature we are NOT porting in 0.7.0

- **Parallel sub-agents.** Sequential only. claude-vaz allows multiple `Task` calls in one assistant turn (parallel tool use) and a `run_in_background` flag for async agents. Both deferred to 0.8.0 — they interact with the streaming pool, abort coordination, and the diff-approval queue in ways that need a separate design pass.
- **Fork mode (inherit parent history).** claude-vaz's `Task` allows omitting `subagent_type`, which forks the parent's full conversation context into the sub-agent. v0.7.0 only supports the isolated mode (fresh history). Fork defeats the context-saving goal; we'll add it later only if a real use case appears.
- **Custom agents from markdown files.** claude-vaz loads `~/.claude/agents/*.md` and `<project>/.claude/agents/*.md` as user-defined `AgentDefinition`s. We ship built-ins only. The loader is purely additive — add it in 0.7.1 once the built-in shapes have stabilized.
- **Plugin agents.** claude-vaz has plugin-system agent registration. Defer.
- **MCP servers per agent.** claude-vaz allows an agent definition to declare its own MCP set. Defer; sub-agents in 0.7.0 get NO MCP tools.
- **Persistent agent memory.** claude-vaz's `memory: 'user' | 'project' | 'local'` per-agent memory scope. Defer.
- **Worktree isolation.** claude-vaz's `isolation: 'worktree'` creates a temp git worktree so write-capable agents can't affect the real tree. Not needed for 0.7.0 because both built-ins are read-only.
- **Sub-agent calls sub-agent.** Hard-blocked at the executor. claude-vaz allows it; we don't until we have a depth-limit + billing-visibility story.
- **User abort of just the sub-agent.** claude-vaz has `TaskStopTool`. v0.7.0 only supports cascaded abort via the parent's Stop button.
- **Replacing the lightweight agent path.** `AgentService.createLightweight` for `/te2e` stays as-is. A refactor to unify lightweight + sub-agent is out of scope.

## 3. Architecture

### Design

```
                              ┌─────────────────────────────┐
                              │ Main AgentService (singletn)│
                              │ • parent history            │
                              │ • chatStore writes          │
                              │ • diff approval flow        │
                              │ • cmdOnlyMode flag (if set) │
                              └────────────┬────────────────┘
                                           │ task({ subagent_type, prompt })
                                           ▼
                              ┌─────────────────────────────┐
                              │ ToolExecutor.taskTool       │
                              │ • resolves definition       │
                              │ • blocks recursive task     │
                              │ • forwards cmdOnlyMode +    │
                              │   cwd from parent           │
                              └────────────┬────────────────┘
                                           │ runSubAgent(def, prompt, parentCtx)
                                           ▼
                              ┌─────────────────────────────┐
                              │ SubAgentService (NEW)       │
                              │ • new AgentService instance │
                              │ • own messages, own pool    │
                              │ • own ToolExecutor view     │
                              │ • inherits parent's auth +  │
                              │   billing channel           │
                              │ • streams to subAgentBus    │
                              │ • does NOT write chatStore  │
                              └────────────┬────────────────┘
                                           │
                          ┌────────────────┼────────────────┐
                          ▼                ▼                ▼
                  ┌──────────────┐  ┌─────────────┐  ┌─────────────────┐
                  │ subAgentStore│  │ tool calls  │  │ final text →    │
                  │ → UI card    │  │ filtered by │  │ returned to     │
                  │              │  │ allowedTools│  │ parent as       │
                  │              │  │ + cmdMode   │  │ tool result     │
                  └──────────────┘  └─────────────┘  └─────────────────┘
```

The parent's conversation history sees ONLY:

- The `task` tool call (with its input)
- The `task` tool result (the sub-agent's final text + a status header)

It does NOT see the sub-agent's intermediate tool calls, raw fetch results, or reasoning. Those live in `subAgentStore`, surfaced via the UI card.

### Components

- **`AgentService` (existing, modified)** — `getInstance()` stays as the main agent. New static factory `AgentService.forSubAgent(definition, parentCtx)` returns a fresh instance configured for sub-agent execution. The fork shares Firebase auth, billing, and the worker URL but has its own messages, history, tool executor view, and streaming pool. **Departure from claude-vaz:** they use a generator-based `runAgent` that any caller can drive; we keep TM Code's existing imperative `runAgentLoop` + callbacks pattern and just instance it a second time.
- **`SubAgentDefinition` (new type)** — mirrors claude-vaz's `BaseAgentDefinition`. Fields: `agentType`, `whenToUse`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `maxWallClockMs`, `color`, `omitProjectContext`, `getSystemPrompt`. We use `tools` + `disallowedTools` exactly as claude-vaz does (both can be set; effective set = `tools` ∖ `disallowedTools`, with sensible defaults).
- **`taskTool` (new tool in ToolExecutor)** — input schema mirrors claude-vaz: `{ subagent_type, description, prompt }`. Resolves the definition, builds a sub-agent, runs it, returns the final text. Blocks recursive `task` calls.
- **`builtInAgents.ts` (new module)** — exports `EXPLORE_AGENT` and `RESEARCH_AGENT`. Direct port of `claude-vaz/tools/AgentTool/built-in/exploreAgent.ts` shape.
- **`subAgentStore` (new Zustand store)** — `Map<runId, SubAgentRun>` where `SubAgentRun = { id, parentTurnId, definition, status, toolCalls[], finalText, errorText, startedAt, endedAt, tokenUsage }`. UI subscribes.
- **`SubAgentCard` (new React component)** — collapsible card in `MessageBubble` showing the sub-agent's tool calls (compact, single-line each), live status, and final summary. Uses the agent's `color` for the border accent (claude-vaz's `agentColorManager` pattern).

### Key interactions

**Happy path (Chat Mode):**
1. Main agent calls `task({ subagent_type: 'Research', description: 'Mercury 2 API docs', prompt: 'Find Inception\'s Mercury 2 API: base URL, auth, model id, reasoning behaviour, pricing. Return a compact summary.' })`.
2. `ToolExecutor.execute('task', ...)` resolves the `Research` definition, builds a `SubAgentService` via `AgentService.forSubAgent(def, { projectPath, cmdOnlyMode: false })`.
3. SubAgentService runs its loop. Tool calls (`web_search`, `web_fetch`, `read_skill`) dispatch via the same Tauri commands the main agent uses. The executor's per-call gate enforces the definition's `tools` whitelist. Each call/result publishes to `subAgentStore`; the UI's `SubAgentCard` renders them in real-time.
4. SubAgentService finishes (`finish_reason: stop` with no tool_use). The final text is returned to `taskTool.execute`, which returns it to the main agent as the tool result.
5. Main agent's next turn sees the sub-agent's summary as a tool result and continues.

**Happy path (Terminal Mode):**
- Same as above, but `forSubAgent` is called with `{ projectPath: cmdCwd, cmdOnlyMode: true }`.
- The sub-agent's tool executor honours cmd-mode: file writes go to disk directly (no diff prompts), the path-validation uses `cmdCwd` as root, project-tools (`provision_auth`, `start_dev_server`, etc.) are unavailable to the sub-agent anyway because both built-ins are read-only.
- The architect prompt is not relevant here (`/plan` is chat-only today). `Research` and `Explore` work identically; only the parent's surface (no chat UI in CLI) differs — see "UI/UX" below for the cmd-mode UX.

**Failure path:** sub-agent hits `maxTurns` (default 30) or wall-clock limit (default 5 min) → `SubAgentService` aborts the in-flight request, accumulates whatever text was produced, returns `Sub-agent stopped at <reason> limit. Partial result:\n<text>`. Parent decides whether to retry with a narrower prompt or proceed.

## 4. Domain Schema

Direct port of claude-vaz's `BaseAgentDefinition`, trimmed of fields we explicitly defer (Section 2).

```ts
// src/services/agent/subAgents/types.ts

export type SubAgentColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'

export interface SubAgentDefinition {
  /** Stable identifier used as the `subagent_type` enum in the task tool. */
  agentType: 'Explore' | 'Research'

  /** Description the parent agent reads in the task tool schema to decide
   *  WHEN to use this sub-agent. Mirrors claude-vaz's `whenToUse`. */
  whenToUse: string

  /** Tool whitelist. Effective allowed set = (tools ∖ disallowedTools).
   *  If omitted, defaults to the parent's full tool set minus the
   *  always-blocked list (task itself, file writes for read-only agents). */
  tools?: string[]
  disallowedTools?: string[]

  /** Override model. 'inherit' = use the parent's plan model (default).
   *  Specific model id = use that model regardless of parent's plan.
   *  Claude-vaz uses 'inherit' for ants and 'haiku' as the default for
   *  external users on Explore; we default to 'inherit' since TM Code
   *  doesn't have a haiku-equivalent tier. */
  model?: 'inherit' | string

  /** Hard caps. */
  maxTurns: number              // default 30
  maxWallClockMs: number        // default 5 * 60 * 1000

  /** UI border accent. Each built-in gets a fixed color. */
  color: SubAgentColor

  /** Skip the parent's project context (CLAUDE.md hierarchy, file tree
   *  preview, recent files) in the sub-agent's system prompt. Saves
   *  ~5-15 KB per spawn. Read-only agents that report findings to the
   *  parent don't need commit/PR/lint guidelines.
   *  Mirrors claude-vaz's `omitClaudeMd`. */
  omitProjectContext: boolean

  /** The sub-agent's system prompt builder. Called with the resolved
   *  parent context (cmdOnlyMode, projectPath, agentLanguage). */
  getSystemPrompt: (parentCtx: SubAgentParentContext) => string
}

export interface SubAgentParentContext {
  /** False in Chat Mode (project open). True in Terminal Mode.
   *  Sub-agents inherit this — the tool executor honours cmd-mode for
   *  any file operation the sub-agent attempts. */
  cmdOnlyMode: boolean
  /** Project root in chat mode, CWD in cmd mode. */
  workingPath: string
  /** Parent's settingsStore.agentLanguage. Sub-agent responds in same lang. */
  agentLanguage: string
}

export interface SubAgentRun {
  id: string
  parentTurnId: string
  definition: SubAgentDefinition
  prompt: string
  status: 'running' | 'completed' | 'error' | 'timeout' | 'aborted'
  toolCalls: SubAgentToolCallSummary[]
  finalText: string
  errorText?: string
  startedAt: number
  endedAt?: number
  tokenUsage: { input: number; output: number }
}

export interface SubAgentToolCallSummary {
  callId: string
  toolName: string
  /** First 80 chars of the args, sanitised. Card shows full args on expand. */
  argPreview: string
  status: 'pending' | 'running' | 'completed' | 'errored'
  resultPreview?: string
}
```

Storage: in-memory only. NOT persisted across IDE restarts.

## 5. State Management

### Global stores

- **`useSubAgentStore`** (new):
  - `runs: Map<runId, SubAgentRun>`
  - `startRun(def, prompt, parentTurnId): runId`
  - `appendToolCall(runId, summary)`
  - `updateToolCallResult(runId, callId, { status, resultPreview })`
  - `finalizeRun(runId, finalText, tokenUsage)`
  - `errorRun(runId, errorText)`
  - `abortRun(runId)`
  - `clearOldRuns()` — runs older than session boundary garbage-collected.

### chatStore augmentation

`Message.subAgentRunIds?: string[]` — when a message has this field, `MessageBubble` renders `<SubAgentCard runId>` between the text content blocks. Empty array means no sub-agent was spawned.

### Per-component

| Component | Local | Global |
|---|---|---|
| `SubAgentCard` | `expanded: boolean` | `useSubAgentStore.runs.get(runId)` |
| `MessageBubble` | (unchanged) | reads `subAgentRunIds` |

## 6. Interface Contracts

### `task` tool — input shape (port of claude-vaz)

```json
{
  "name": "task",
  "description": "Launch a specialized sub-agent for a self-contained sub-task. Sub-agents have their own context — your conversation does not see their intermediate work, only the final answer. The available sub-agent types are listed below; pick the one whose description matches the task.\n\nSub-agent types:\n  Explore — Read-only codebase search. Use for 'find all usages of X', 'where is Y defined', 'list every file that imports Z'. Tools: glob, grep, read_file, get_diagnostics.\n  Research — Web research + skill lookup. Use for 'find the API docs for X', 'what's the auth shape of service Y'. Tools: web_search, web_fetch, read_skill.\n\nWhen NOT to use:\n  • The task is a single read_file call — just do it directly.\n  • The task requires editing or running code — sub-agents are read-only.\n  • You already have the answer in your context.",
  "input_schema": {
    "type": "object",
    "properties": {
      "subagent_type": {
        "type": "string",
        "enum": ["Explore", "Research"]
      },
      "description": {
        "type": "string",
        "description": "Short label (3-5 words) shown in the sub-agent card while it runs."
      },
      "prompt": {
        "type": "string",
        "description": "Self-contained task description. The sub-agent sees nothing else from your conversation. Specify what you need back as a final summary."
      }
    },
    "required": ["subagent_type", "description", "prompt"]
  }
}
```

The `description` field exists because claude-vaz uses it for the live UI status label — "Searching for OAuth refs" reads better than the full prompt. Same use here.

### `SubAgentCard` props

```ts
interface SubAgentCardProps { runId: string }
// All other state via useSubAgentStore.
```

## 7. Technical Decisions

| Decision | Chosen | Alternatives considered | Trade-off |
|----------|--------|------------------------|-----------|
| Isolation level | New `AgentService` instance per call, fresh history, fresh executor view, shared singleton deps (Firebase auth, billing channel, worker URL) | (a) Fork the parent's history (claude-vaz default w/ no subagent_type). (b) Reuse the main `AgentService` with a stack of histories. | Fresh instance = clean context (the whole point). Shared deps avoid duplicating auth + worker. Fork = defeats the goal. Stack = fragile with async tool calls. **Direct port from claude-vaz** — they isolate by default for typed agents. |
| Streaming pool | Sub-agent gets its OWN streaming pool instance | Share parent's pool | Per-sub-agent pool keeps tool-result routing unambiguous and abort semantics local. Pool worker construction is deferred so cost is ~zero. **Port from claude-vaz.** |
| Parent visibility | Compact card with tool-call list + final text; collapsible | (a) Hide internals. (b) Stream full transcript inline. | Hidden = no debug; full = defeats context-saving + clutters chat. Compact card balances both. **Port from claude-vaz** — `agentDisplay.ts`. |
| Sub-agent model | Default `'inherit'` (parent's plan model). Definition may override. | (a) Always parent. (b) Always cheaper. | `'inherit'` ensures parity (user picked their plan model for a reason). Override is per-definition when a built-in benefits from a specific model. Cheaper-by-default surprises Pro/Max users. **Same approach as claude-vaz** (`'inherit'` magic value). |
| `task` tool surface | Single tool with `subagent_type` enum (+ description + prompt) | One tool per built-in (`explore_task`, `research_task`) | Single tool matches claude-vaz's `Task(subagent_type=...)` ergonomics; avoids tool-count growth as we add types. **Port from claude-vaz.** |
| Allowed-tools enforcement | Tool executor's per-call check, gated by a `subAgentContext` carried in tool input | Build a separate ToolExecutor per sub-agent | Reuses existing ~140 tool definitions, ~50 LOC for the gate vs. rebuilding the registry per call (15-30ms cold). **Departure from claude-vaz** — they pass tools through a registry filter; we filter at call site because TM Code's executor is a singleton. Same end result. |
| Recursive `task` from sub-agent | Hard block at executor | Allow with depth limit | One layer of indirection is enough for documented failure modes. Recursive spawn risks runaway billing without a clear UX. v0.8.0 can revisit. **Departure from claude-vaz** — they allow recursion; we don't until we have the depth-limit + billing-visibility story. |
| Sub-agent timeout | `maxTurns=30` OR `maxWallClockMs=5*60*1000`, whichever first | One bigger budget | Wall-clock catches model-stuck-in-loop cases turn count alone misses. 5 min is well above 95th percentile of useful research turns. **Slightly more conservative than claude-vaz** (their default is ~50 turns). |
| Token billing | Charged to parent's envelope | Separate sub-agent line | Single envelope is simpler UX. User picked the plan based on their budget, not their sub-agent budget. Reconsider if data shows abuse. **Port from claude-vaz** — they bill against the originating session. |
| Chat-mode vs Cmd-mode | Sub-agent inherits parent's `cmdOnlyMode + workingPath` via `SubAgentParentContext`. Tool executor honours the inherited flag identically to how it honours the parent's. | Force sub-agents to always run in chat-mode (with a synthetic project) | Forcing chat-mode would break terminal-mode users (no project, no chat UI). Inheriting matches the parent's user-facing behaviour. **Departure from claude-vaz** — they only have one mode; we explicitly carry our own duality through. |
| Lightweight agent path (`createLightweight` for /te2e) | Untouched. Sub-agents are a parallel surface — both create `AgentService` instances, neither replaces the other. | Refactor both into one factory | Unification would be cleaner long-term, but `/te2e` works and the refactor adds risk for zero v0.7.0 user-visible benefit. Pick this up post-0.7.0 only if real code duplication appears. **Departure from claude-vaz** — they don't have `/te2e`. |
| `/plan` integration | Architect prompt mentions `task(subagent_type='Research', ...)` for unfamiliar APIs. The "3 web call hard cap" added in 0.6.2 RELAXES to "3 direct calls OR one Research delegate". | Force `task` for every web call | Optionality preserves the cheap path. 80% of plan turns need one targeted fetch; sub-agent overhead is wasteful there. **Port of claude-vaz's pattern** — their /plan equivalent recommends Task without forcing it. |
| Built-in agent prompt shape | Direct port of `claude-vaz/tools/AgentTool/built-in/exploreAgent.ts`, adapted for TM Code's tool names | Write fresh prompts | claude-vaz's prompts have been tuned across millions of sub-agent spawns. Porting their phrasing (read-only block, parallel-tool-call hint, "fast agent that returns quickly" framing) lifts the floor. We only change tool-name references and add the cmd-mode line. **90% port.** |

## 8. Business Rules & Validation

### Rules (enforced server-side at the tool executor)

- A sub-agent NEVER writes files (`write_file`, `edit_file`, `create_file`, `delete_file`, `rename_file` all blocked).
- A sub-agent NEVER runs commands (`execute_command`, `start_dev_server` blocked).
- A sub-agent NEVER calls `task` itself.
- A sub-agent NEVER calls `provision_auth`, `request_credentials`, or any MCP tool. MCP is a parent-only surface for 0.7.0.
- A sub-agent's `read_file` is restricted to the parent's `workingPath` + skills dir + (for browser-session) sandbox. Out-of-tree reads return blocked. **Port from claude-vaz** — same restriction shape.
- `agentLanguage` is inherited from `settingsStore.agentLanguage` — sub-agent responds in the user's chosen language, identical rules to the architect prompt today.

### Error mapping

| Scenario | Behaviour |
|----------|-----------|
| Sub-agent calls a forbidden tool | Tool executor returns `Blocked: tool 'X' is not allowed in sub-agent 'Y'. Allowed: <list>.` Sub-agent reads in next turn and adapts. |
| Sub-agent exceeds maxTurns | Abort in-flight. Return `Sub-agent stopped at turn limit (30). Partial result: <accumulated text>`. |
| Sub-agent exceeds maxWallClockMs | Same shape, reason "time limit". |
| Upstream errors (provider 5xx, network) | Same retry policy as main agent (`agentService.ts:1985-1996`). If retries exhaust, return `Sub-agent failed: <err>`. |
| Parent's main turn aborted (user pressed Stop) | Cascade abort: sub-agent's `AbortSignal` fires, in-flight request cancels, status → `aborted`. UI shows aborted state. |
| User pressed Stop on sub-agent only | Not supported in 0.7.0. Cascaded abort only. |

## 9. Quality Attributes

- **Performance:** sub-agent cold-start (new `AgentService` instance + first chunk arriving) < 300 ms above the baseline upstream latency. The streaming protocol is unchanged.
- **Reliability:** sub-agent crash MUST NOT crash the parent's loop. All errors caught at the `taskTool.execute` boundary and surfaced as a tool result string.
- **Security:** tool whitelist enforced server-side (the executor). The model cannot escape by inventing a tool name; the executor returns Blocked.
- **Context savings (measurable target):** for a `/plan` turn that previously did 3 web_search + 5 web_fetch + 1 read_skill, delegating to `Research` should reduce the parent's context tokens by **≥30 K**. Verified by re-running the 2026-05-16 BugHunter `/plan` scenario in eval and checking `chatStore.tokenUsage` deltas vs. the 0.6.2 baseline.
- **Mode parity:** the same Explore/Research sub-agent must function identically whether the parent is in Chat Mode (with a `currentProject`) or Terminal Mode (`cmdOnlyMode=true`). Verified by running each built-in once in each mode during Phase 5.

## 10. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Sub-agent returns a misleading summary; parent makes a wrong call | Worse output, wasted iteration | Built-ins prompted to "be specific, name the source, quote when possible". The card surfaces tool calls so the user sees the raw research. Parent's prompt instructs verification with one targeted call if summary feels off. **Mirrors claude-vaz's anti-hallucination phrasing.** |
| Multiple sub-agents in one parent turn explode billing | User over-spends | (a) Soft warn in card UI at 3+ sub-agents per turn. (b) Single token envelope keeps usage visible in existing gauges. (c) Architect prompt: "use task once per /plan turn; chain only if first research left clear unknowns". |
| Sub-agent infinite loop | Time + tokens burned | `maxTurns=30` catches in <90s on fast models. `maxWallClockMs=5min` upper bound. Sub-agent prompt: "if not answered in 5 tool calls, return what you have with explicit unknowns". |
| Definitions drift from real usage | Quality regression | Each built-in's prompt has a phrasing-rationale comment block (same convention as architect prompt). Changes log the eval session that motivated them. |
| Parent never learns to use `task` | Feature ships, nothing changes | (a) Few-shot in architect prompt explicitly showing the `task` call. (b) Few-shot in `contextBuilder.buildSystemPrompt` and `buildCmdModeSystemPrompt`. (c) Track via existing `trackEvent('tool_pool_turn')` — if `task` calls < 5% of `web_fetch` calls after 2 weeks, iterate prompts. **Empirically validated**: in past prompt changes, tools without few-shots get under-used. |
| Card eats vertical chat space | Hard to scroll | Auto-collapse on completion. Max 8 tool calls visible per card; rest summarised "+N more". |
| `MessageBubble` rewrites regress existing rendering | Chat unstable | Additive changes only — new prop, new render branch. All existing tests must pass; add new ones for sub-agent path. |
| Terminal Mode UI (no chat panel) — where does the card render? | Cmd-mode users see nothing while sub-agent runs | Phase 4 explicit deliverable: in cmd-mode, sub-agent progress streams to the terminal-mode chat surface (`useChatStore` already exists in cmd-mode — the chat just isn't a project-tied panel). Card renders inline same as chat-mode, just inside the cmd-mode chat container. |

## 11. UI/UX Design

### Chat-mode layout

Card renders **inline** in the parent's assistant message, between the text where the model decided to delegate and the next text after the sub-agent returned.

```
┌── Assistant ─────────────────────────────────────────┐
│  I'll research Mercury 2's API surface first.        │
│                                                      │
│  ┌─ 🔎 Research · "Mercury 2 API docs" · 12s · ✅ ─┐ │
│  │ • web_search: "Inception Mercury 2 API"   ✓    │ │
│  │ • web_fetch: docs.inceptionlabs.ai/...    ✓    │ │
│  │ • web_fetch: inceptionlabs.ai/pricing     ✓    │ │
│  │                                                 │ │
│  │ Mercury 2: OpenAI-compatible base URL          │ │
│  │ https://platform.inceptionlabs.ai/v1, model id │ │
│  │ "mercury-2", $0.25/$0.75 per 1M, reasoning ON  │ │
│  │ by default.                                    │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  Based on that, I'll structure the auth + chat       │
│  endpoints around the standard /chat/completions...  │
└──────────────────────────────────────────────────────┘
```

### Cmd-mode layout

The cmd-mode chat panel renders the same `SubAgentCard` — there's no project sidebar to worry about. Card uses tighter vertical spacing because cmd-mode panels are narrower.

### States

- **Running** — card expanded, status pill animates, tool calls append live.
- **Completed** — collapses to one-liner: `🔎 Research · "Mercury 2 API docs" · 12s · ✅ 3 calls · click to expand`.
- **Error / Timeout** — stays expanded with reason pill.
- **Aborted** — collapsed, shows "Aborted".

### Visual style

Match existing chat bubbles: dark glass, pink border on focus. The card border uses the agent's `color`:
- `Research` → purple (#a371f7)
- `Explore` → cyan (#3fb8af)

Direct port of claude-vaz's `AGENT_COLORS` palette, narrowed to the two built-ins we ship.

### Accessibility

- Card uses `<details>` when collapsed; keyboard nav inherited.
- Status pill has `aria-live="polite"`.

## 12. File Structure

| File Path | Action | Description | Phase |
|-----------|--------|-------------|-------|
| `src/services/agent/subAgents/types.ts` | CREATE | `SubAgentDefinition`, `SubAgentRun`, `SubAgentParentContext`, `SubAgentToolCallSummary` | 1 |
| `src/services/agent/subAgents/colors.ts` | CREATE | Port of `agentColorManager.ts` palette | 1 |
| `src/services/agent/subAgents/builtInAgents.ts` | CREATE | Re-exports `EXPLORE_AGENT`, `RESEARCH_AGENT` | 1 |
| `src/services/agent/subAgents/exploreAgent.ts` | CREATE | Direct port of `claude-vaz/tools/AgentTool/built-in/exploreAgent.ts` w/ TM Code tool names + cmd-mode line | 1 |
| `src/services/agent/subAgents/researchAgent.ts` | CREATE | Sister to Explore: web_search + web_fetch + read_skill only | 1 |
| `src/services/agent/subAgents/__tests__/prompts.test.ts` | CREATE | Snapshot tests for each built-in's system prompt | 1 |
| `src/stores/subAgentStore.ts` | CREATE | Zustand store for runs | 2 |
| `src/services/agent/subAgents/subAgentRunner.ts` | CREATE | `runSubAgent(definition, prompt, parentCtx, parentTurnId)` — owns SubAgentService lifecycle, publishes to store | 2 |
| `src/services/agent/agentService.ts` | UPDATE | Add `static forSubAgent(definition, parentCtx)` factory. Refactor messaging callbacks to accept an override channel (publish to subAgentStore instead of chatStore). | 2 |
| `src/services/agent/__tests__/subAgentRunner.test.ts` | CREATE | Integration: spawn each built-in, verify parent gets only final text, store captures tool calls | 2 |
| `src/services/agent/toolExecutor.ts` | UPDATE | Add `task` tool; add `_subAgentContext` private flag; gate tool whitelist; block recursive task; cascade abort | 3 |
| `src/services/agent/toolNames.ts` | UPDATE | Add `TASK` constant | 3 |
| `src/services/agent/__tests__/taskTool.test.ts` | CREATE | task tool unit tests: recursion block, forbidden tool block, timeout, abort, cmd-mode passthrough | 3 |
| `src/components/chat/SubAgentCard.tsx` | CREATE | Card UI | 4 |
| `src/components/chat/SubAgentCard.test.tsx` | CREATE | Status transitions, expand/collapse, error states | 4 |
| `src/components/chat/MessageBubble.tsx` | UPDATE | Render `<SubAgentCard>` when message has `subAgentRunIds` | 4 |
| `src/stores/chatStore.ts` | UPDATE | `Message.subAgentRunIds?: string[]`; helpers | 4 |
| `src/services/agent/commands/planCommand.ts` | UPDATE | Architect prompt: few-shot for `task(Research)`; relax "3 web call cap" to "3 direct OR delegate" | 5 |
| `src/services/agent/commands/debugCommand.ts` | UPDATE | Debugger prompt: hint `task(Explore)` for "where is X used?" patterns | 5 |
| `src/services/agent/contextBuilder.ts` | UPDATE | Chat-mode `buildSystemPrompt` and cmd-mode `buildCmdModeSystemPrompt` both document `task` with a worked example | 5 |

## 13. Implementation Phases

### Phase 1 — Built-in agent definitions exist and have tested prompts (no runtime yet)

- Scope: types + `EXPLORE_AGENT` + `RESEARCH_AGENT`. Prompts snapshot-tested. Tool whitelist constants. NO runtime wiring.
- Files: `types.ts`, `colors.ts`, `builtInAgents.ts`, `exploreAgent.ts`, `researchAgent.ts`, prompts test.
- Completion criteria: `npm test src/services/agent/subAgents` passes; prompts render with all expected sections (role, read-only block, allowed tools, completion rule, language directive); both chat-mode and cmd-mode language directives produce correct output.
- **90% port** of `claude-vaz/tools/AgentTool/built-in/exploreAgent.ts`. Only TM Code tool name references and the cmd-mode-aware line differ.

### Phase 2 — Sub-agent runs end-to-end via direct API; no parent integration visible

- Scope: SubAgentStore + subAgentRunner + `AgentService.forSubAgent`. Integration test can call `runSubAgent(EXPLORE_AGENT, "find usages of X", parentCtx, "fake-parent")` and get back text. Tool calls captured in store. Token usage flowed to billing channel. NO `task` tool yet, NO UI yet.
- Files: `subAgentStore.ts`, `subAgentRunner.ts`, `agentService.ts` (factory + callback override), subAgentRunner integration test.
- Completion criteria: integration test passes. Sub-agent's tool calls do NOT appear in `chatStore`. Parent's billing envelope receives the sub-agent's token deltas via the existing `onUsageUpdate` callback.
- Depends on: Phase 1

### Phase 3 — The `task` tool is callable; recursive block, timeouts, cmd-mode passthrough all enforced

- Scope: `task` tool wired in ToolExecutor; recursive-task block; forbidden-tools gate; `maxTurns` + `maxWallClockMs` enforcement; cmd-mode + workingPath passthrough. Main agent CAN call `task` and receive a string back. No card UI yet.
- Files: `toolExecutor.ts`, `toolNames.ts`, `taskTool.test.ts`.
- Completion criteria:
  - Main agent calls `task` in a manual session; answer arrives as tool result; parent uses it.
  - Recursive `task` returns "Blocked".
  - Forbidden tool (e.g. `write_file` inside a Research sub-agent) returns "Blocked".
  - Timeout path tested with a definition that has `maxTurns: 1` and a prompt that requires more — partial returned with the right header.
  - Both chat-mode and cmd-mode runs succeed (cmd-mode test uses an in-memory project at `tempdir`).
- Depends on: Phase 2

### Phase 4 — The user sees what the sub-agent is doing

- Scope: `SubAgentCard` + `chatStore.Message.subAgentRunIds` + `MessageBubble` wiring. Live tool-call streaming. Status transitions. Collapse on completion. Cmd-mode chat container renders the same card.
- Files: `SubAgentCard.tsx` + test, `MessageBubble.tsx`, `chatStore.ts`.
- Completion criteria: spawning a sub-agent in chat-mode renders a live card. Spawning in cmd-mode renders the card in the cmd-mode chat container. Card shows tool calls live; collapses on completion. Errors surface correctly.
- Depends on: Phase 3

### Phase 5 — Prompts updated; main agent learns to use `task`

- Scope: `/plan` architect prompt + `/debug` debugger prompt + general chat-mode + cmd-mode system prompts all document `task` with worked examples. The 0.6.2 "3 web call cap" relaxes to "3 direct OR one Research delegate". Eval the change with the 2026-05-16 BugHunter scenario; verify the Research path produces PLAN.md cleanly with ≥30 K token savings.
- Files: `planCommand.ts`, `debugCommand.ts`, `contextBuilder.ts` (both `buildSystemPrompt` and `buildCmdModeSystemPrompt`).
- Completion criteria:
  - Re-running the 2026-05-16 `/plan` scenario produces PLAN.md without context bloat. Parent's context tokens ≥30 K below pre-0.7.0 baseline.
  - In cmd-mode, asking "find where X is used in this codebase" causes the agent to call `task(Explore, ...)` instead of running multiple greps in its own context.
  - `trackEvent('tool_pool_turn')` shows non-zero `task` calls in dogfood sessions across the team.
- Depends on: Phase 4

**Critical path:** 1 → 2 → 3 → 4 → 5. Phase 4 UI can start partially in parallel with Phase 3 but the run-attachment shape (chatStore.Message.subAgentRunIds) is on the path.

## 14. Open Questions

- Should sub-agents emit telemetry events distinct from the main agent's (`sub_agent_started`, `sub_agent_completed`, `sub_agent_token_usage`)? **Yes, probably** — needed to evaluate adoption in Phase 5. Decide before Phase 2.
- Should Settings expose a "Research model" override (default `'inherit'`)? Useful when users want cheap+fast for research, expensive for main. Defer decision to post-0.7.0 based on observed cost.
- `read_skill` content: should we cache per-session so calls in a sub-agent reuse the main agent's cached body? Optimization; defer to 0.7.1.
- How does the parent prompt handle a sub-agent abort result? Should we hint NOT to retry? Yes — add to `task` tool description in Phase 3.
- For Explore: should `glob` be allowed to walk outside the project root (e.g. `node_modules`)? **claude-vaz allows it; we will too** — restrict only writes, not reads. Confirm during Phase 1.
- Does the architect prompt need to MENTION `task` in addition to having it in the tool index? **Yes** — empirically, tools without few-shot examples get under-used. Add a few-shot in Phase 5. **Same finding documented by claude-vaz** in their `prompt.ts` "When NOT to use" anti-examples block — port that pattern too.

---

# Additional 0.7.0 Scope

> Added: 2026-05-17
> Status: ranges from DONE (working tree, not committed) to PLANNED to DEFERRED.

This file was originally scoped to the sub-agents feature (sections 1–14 above). The sections below document the **rest of the 0.7.0 release plan** so there's a single canonical reference.

The 0.7.0 release groups four buckets:

| Bucket | Status | Section |
|---|---|---|
| Sub-agents (`task` tool) | PLANNED | Sections 1–14 |
| Hooks via `settings.json` | PLANNED | A |
| Custom commands via `.claude/commands/*.md` | PLANNED | B |
| Already implemented in working tree | DONE — needs commit + release | C |
| Audit items considered but deprioritized | DEFERRED to 0.7.1+ | D |
| `/plan-feature` command (sibling to `/plan`) | DEFERRED — design to follow | E |

---

## A. Hooks via `settings.json`

> Source of truth: claude-vaz `setup.ts:283-327` + `constants/prompts.ts:128` (event names, blocking semantics, output wrapping).

### A.1 — Context

claude-vaz exposes a generic hook mechanism: shell commands fire in response to agent-lifecycle events. Users can enforce project conventions ("format on save", "tests before complete"), gate dangerous operations (block `execute_command` unless a pre-condition passes), or inject side effects (notify on session start, log on PreCompact). TM Code today has none of this — every automation is baked into the IDE code or hand-driven by the user.

The gap was flagged in audit 2 (#2 "Hook system", high impact / extensibility).

### A.2 — Goals

1. Users declare hooks in `settings.json` under `hooks: { <event>: HookConfig[] }`.
2. Hook events fired by the IDE harness: `SessionStart`, `PreToolCall`, `PostToolCall`, `PreCompact`, `OnError`, `Stop`.
3. Each hook is a shell command. The command's stdout/stderr is captured and may be surfaced as a `<user-prompt-submit-hook>`-wrapped system reminder (claude-vaz parity).
4. Hooks can be **blocking** (`blocking: true` — exit code non-zero blocks the action) or **non-blocking** (fire-and-forget).
5. Hook execution is gated by sandboxing: respects the same allowlist/denylist as `execute_command`.

### A.3 — Non-goals (0.7.0)

- No GUI for hook configuration — users edit `settings.json` by hand.
- No multi-host hooks (e.g. webhooks). Local shell only.
- No streaming hook output to the chat in real time — captured then surfaced atomically on completion.
- No `WorktreeCreate` hook — only relevant once we add worktree isolation (deferred).

### A.4 — Architecture

```
┌──────────────────────────────┐
│ AgentService / toolExecutor  │
│   emits event:               │
│   { name, payload }          │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ HookDispatcher (new)         │
│ • reads settings.hooks       │
│ • resolves matching configs  │
│ • spawns shell per config    │
│ • collects stdout/exit       │
│ • returns aggregate result   │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Outcomes:                    │
│ • exit ≠ 0 + blocking → tool │
│   call aborts with hook msg  │
│ • stdout → wrapped reminder  │
│ • side effects: free reign   │
└──────────────────────────────┘
```

### A.5 — Domain schema

```ts
interface HookConfig {
  /** Shell command. Runs via the same Tauri execute_command pipeline so
   *  sandbox + flaggedCommands rules apply. Env: HOOK_EVENT, HOOK_PAYLOAD
   *  (JSON-stringified event payload), TM_PROJECT_PATH, TM_CWD. */
  command: string
  /** When true, non-zero exit BLOCKS the originating action and the IDE
   *  surfaces the hook's stderr to the agent as a tool-result error.
   *  When false (default), the IDE logs the hook result but proceeds. */
  blocking?: boolean
  /** Filter — only fire for tool calls matching this name. Empty = all. */
  toolNames?: string[]
  /** Filter — only fire for the matching slash command. Empty = all. */
  slashCommands?: string[]
  /** Timeout in ms. Default 10s; max 60s. */
  timeoutMs?: number
}

interface HooksConfig {
  SessionStart?: HookConfig[]
  PreToolCall?: HookConfig[]
  PostToolCall?: HookConfig[]
  PreCompact?: HookConfig[]
  OnError?: HookConfig[]
  Stop?: HookConfig[]
}
```

### A.6 — File structure

| File | Action | Purpose |
|---|---|---|
| `src/services/hooks/types.ts` | CREATE | `HookConfig`, `HooksConfig`, `HookEvent`, `HookResult` |
| `src/services/hooks/hookDispatcher.ts` | CREATE | `dispatchHook(event, payload) → HookResult[]` |
| `src/services/hooks/__tests__/dispatcher.test.ts` | CREATE | Unit tests (exit code, blocking, timeout, filter matching) |
| `src/stores/settingsStore.ts` | UPDATE | Add `hooks?: HooksConfig` field + persistence |
| `src/services/agent/agentService.ts` | UPDATE | Emit `SessionStart`/`PreCompact`/`Stop` events |
| `src/services/agent/toolExecutor.ts` | UPDATE | Emit `PreToolCall`/`PostToolCall`/`OnError`; honour blocking result |
| `docs/HOOKS.md` | CREATE | User-facing docs: events, payloads, examples |

### A.7 — Implementation phases

- **Phase A1** — Types + `HookDispatcher` (pure, no caller wiring). Unit tests.
- **Phase A2** — `settingsStore` carries `hooks?: HooksConfig`. Reads from `settings.json` on load.
- **Phase A3** — Wire `PreToolCall` + `PostToolCall` in toolExecutor. Most-impactful pair. Test blocking semantics.
- **Phase A4** — Wire `SessionStart`, `PreCompact`, `OnError`, `Stop`.
- **Phase A5** — `docs/HOOKS.md` + few-shot example hooks shipped in the IDE templates.

Critical path: A1 → A2 → A3 → A4 → A5.

### A.8 — Risks

| Risk | Mitigation |
|---|---|
| Malicious hook in project `.claude/settings.json` runs arbitrary code | Hooks pulled from PROJECT-LEVEL settings prompt the user once for "trust this project's hooks?" (Y/N persistent). User-level `~/.claude/settings.json` trusted by default. |
| Hook timeout hangs the IDE | Default 10s, hard cap 60s. Kill on timeout. |
| Blocking hook + infinite retry loop | `OnError` hook does NOT re-fire on its own errors (single-shot per event). |
| Hooks fire from sub-agents and double-bill | Sub-agents skip the `PreToolCall`/`PostToolCall` hook events for 0.7.0. Parent-only. |

---

## B. Custom commands via `.claude/commands/*.md`

> Source of truth: claude-vaz `skills/loadSkillsDir.ts:566-623`. We adopt the directory layout, frontmatter convention, and discovery semantics; the registration shape lives in our existing `slashCommandRegistry`.

### B.1 — Context

Today the slash command registry (`src/services/agent/slashCommandRegistry.ts`) hard-codes `/init`, `/plan`, `/debug`, `/payments`, `/te2e`, `/review`. Adding `/deploy-staging` or `/run-my-test-suite` requires editing TS + rebuilding the IDE. claude-vaz CLI users get this for free via `~/.claude/commands/*.md` and `<project>/.claude/commands/*.md`.

Gap flagged in audit 2 (#3 "Custom commands", high impact / extensibility).

### B.2 — Goals

1. The IDE discovers `~/.claude/commands/*.md` (global) and `<projectRoot>/.claude/commands/*.md` (project-scoped) at session start and on file-watcher events.
2. Each `.md` file = one slash command. Frontmatter declares name + description + optional arg suggestions + plan gating.
3. Markdown body = the prompt template, with `{{args}}` interpolation for user-supplied arguments.
4. Discovered commands appear in the slash menu next to built-ins; project-scoped wins on name collision.
5. Renaming or deleting a file removes the command on the next discovery tick.

### B.3 — Non-goals (0.7.0)

- No script execution from custom commands — they're prompt templates only (no shell, no Node hooks). Users wanting "run this command" wire it through hooks (Section A).
- No nested directories — flat `commands/*.md` for 0.7.0.
- No live preview of the rendered prompt in the slash menu.
- No marketplace / share-link for commands. Local files only.

### B.4 — File format (frontmatter + body)

```markdown
---
name: deploy-staging
description: Deploy current branch to staging via the project's deploy script.
args:
  - value: ""
    description: optional release notes (will be passed to the deploy script as $1)
requires-paid-plan: false
---

The developer wants to deploy the current branch to staging. The project has
`scripts/deploy-staging.sh` (verify with `read_file` first if unsure of the
path). Run it via `execute_command`, surface its output, and capture the
returned URL.

User-supplied release notes: {{args}}
```

### B.5 — Domain schema

```ts
interface CustomCommandFile {
  /** Absolute path on disk. */
  filePath: string
  /** Scope inferred from path: user vs. project. */
  scope: 'user' | 'project'
  /** Parsed frontmatter. */
  meta: {
    name: string
    description: string
    args?: Array<{ value: string; description: string }>
    requiresPaidPlan?: boolean
  }
  /** Markdown body (frontmatter stripped). Sent as the prompt template. */
  body: string
}
```

### B.6 — File structure

| File | Action | Purpose |
|---|---|---|
| `src/services/agent/customCommands/discover.ts` | CREATE | `discoverCustomCommands(projectRoot) → CustomCommandFile[]` |
| `src/services/agent/customCommands/parser.ts` | CREATE | Frontmatter + body parsing (zero-deps; yaml-lite for FM) |
| `src/services/agent/customCommands/__tests__/parser.test.ts` | CREATE | Pure unit tests for parser |
| `src/services/agent/slashCommandRegistry.ts` | UPDATE | Merge custom commands into the registry; project overrides user; precedence over built-ins documented |
| `src/services/agent/customCommands/executor.ts` | CREATE | `executeCustomCommand(file, args, mode)` — interpolates `{{args}}`, calls `runAgentWithCallbacks` |
| `src/components/prompt/slashCommandMenu.tsx` | UPDATE | Render badge `user` / `project` next to custom commands |
| `docs/CUSTOM-COMMANDS.md` | CREATE | User docs: frontmatter schema, examples |

### B.7 — Implementation phases

- **Phase B1** — Parser + types. Pure unit tests.
- **Phase B2** — `discoverCustomCommands` reads both dirs, returns merged list with project-wins semantics. File-watcher hook re-discovers on changes.
- **Phase B3** — Registry merges. Slash menu surfaces them.
- **Phase B4** — Execution path: interpolate args, dispatch to main agent the same way built-ins do (via `runAgentWithCallbacks` with `cmdOnlyMode` propagated).
- **Phase B5** — `docs/CUSTOM-COMMANDS.md` + ship one example command in the IDE's user templates.

### B.8 — Decisions

| Decision | Chosen | Rationale |
|---|---|---|
| Discovery scope | `~/.claude/commands/*.md` + `<projectRoot>/.claude/commands/*.md` | claude-vaz uses the same two paths. Matches existing user mental model. |
| Name collision | Project > User > Built-in | Project context is the most specific. Built-ins are last resort because they're the most generic. Same precedence as claude-vaz. |
| Prompt template syntax | `{{args}}` (Handlebars-lite) | Simplest interpolation. Future-proof for `{{file}}`, `{{branch}}` etc. without committing to a full templating engine. |
| Hot-reload | File-watcher on both dirs | Discovery in steady-state must reflect on-disk reality without an IDE restart. Existing `fileWatcherService` already watches the project; extend to `~/.claude/commands/`. |
| Plan gating | `requires-paid-plan: bool` in frontmatter | Same shape as built-ins (`requiresPaidPlan`). User-written commands can opt themselves into Pro-only if they want. |

### B.9 — Risks

| Risk | Mitigation |
|---|---|
| Project `.claude/commands/rm.md` overrides built-in `/rm` (if we add one) | Project-wins precedence is intentional, but the slash menu visibly badges with `project` so user knows. |
| Malformed YAML frontmatter | Parser returns a parse error; menu shows the command grayed out with the error in tooltip. Loud failure, not silent skip. |
| `{{args}}` injection (e.g. command with `; rm -rf /` in args) | Args are interpolated as TEXT into the PROMPT — they never reach a shell. Shell execution only happens if the prompt instructs the agent to `execute_command`, which goes through normal permission flow. |

---

## C. Already implemented in working tree (queued for 0.7.0 release)

> Status: DONE — code in working tree, not yet committed. Listed here so the 0.7.0 changelog has a single source of truth.

These were built across multiple sessions of claude-vaz-parity work and are technically "feature changes" that warrant the 0.7.0 minor bump rather than a 0.6.2 patch.

### C.1 — Thinking model rationalization

- **Removed** the mid-session "⚡ Thinking" toggle UI from `AgentStatusBar.tsx`, `TerminalTitleBar.tsx`, `ChatView.tsx`.
- **Hard-coded** `preserveReasoningBetweenTurns = true` in `agentService.ts:354`.
- **Reasoning always-on** when `profile.supportsThinking === true` — slash-command request types (`plan`/`debug`/`review`/`e2e`) no longer "force" thinking, since every active coder profile already supports it. The backend belt-and-braces force at `proxy.ts:867` stays as redundancy.
- **Removed** `thinkingEnabled` / `setThinkingEnabled` from `settingsStore.ts` (dead).
- **Simplified** `useThinkingToggle` hook to return only `{ mandatory: boolean }` for the static badge.

claude-vaz parity: their thinking config is global / launch-flag based, no mid-session UI. We match.

### C.2 — Verification gate for `#auth-*` scaffold flow (`verifyAuthFlow`)

- **New** `src/services/agent/commands/verifyAuthFlow.ts` + `authVerdict.ts` (pure parseVerdict).
- **Wired** into `authCommand.runAuthFlow` AFTER the scaffold turn. Adversarial sub-agent runs auth-specific probes (bogus-token curl, MISSING_REQUEST_URI / INVALID_CREDENTIAL_OR_PROVIDER_ID / `/v2` slip / Vite proxy missing detection). On FAIL, diagnostic feeds back to main agent for up to 2 fix passes, then re-verifies. Caps prevent infinite loops.
- **Skill hardened** — `auth-proxy/SKILL.md:334` got a dedicated `### CRITICAL —` block for the `signInWithIdp` body shape (postBody + requestUri, not bare idToken).
- **CMD-mode aware** — verifier enables `toolExecutor.enableCmdMode(projectPath)` for its duration when the parent flow was CMD-launched. Without this every file read in the verifier failed with "No project is open."
- **Abort / error guards** — `userAborted` flag captured via `agent-stop-requested` listener; the loop honours Stop AND skips verification when the scaffold turn ended in error.

claude-vaz parity: their `verificationAgent.ts` adversarial pattern, adapted to auth specifically.

### C.3 — Slash command `cmdOnlyMode` propagation

- `/init`, `/plan`, `/debug`, `/payments`, `/te2e`, `/review` now accept `mode: SlashCommandMode` and propagate `cmdOnlyMode: mode === 'terminal'` to `runAgentWithCallbacks`.
- `/review` additionally wraps its sub-agent run with `enableCmdMode` / `disableCmdMode` because it goes through `createLightweight` instead of `runAgentWithCallbacks`.

Without this fix every slash command was broken in CMD mode — tool calls fell back to `useProjectStore.currentProject` which is empty in CMD.

### C.4 — Skill section extraction — orphan H3 support

- `extractCriticalSections` (`contextBuilder.ts`) now captures `### CRITICAL —` H3 blocks living under non-critical H2 parents, not just H2-nested ones. This unblocks the verifier's slice-only prompt (the `MISSING_REQUEST_URI` rule lives at H3 under "## the auth API REST endpoints", which the old extractor silently dropped).
- 3 new test cases cover orphan H3, H3→H3 boundary, H3→H2 boundary.

### C.5 — Compact summary structure (9-section template)

- New `compactPrompt.ts` (zero-deps, testable): `buildCompactPrompt()` + `formatCompactSummary()`. 9-section claude-vaz template + `<analysis>` drafting wrapper stripped post-hoc.
- 13 unit tests.
- `agentService.callSummarizationAPI` uses both.

NB: technically committed against the 0.6.2 line because the user picked it as a chat-mode quality item. Listed here for completeness.

### C.6 — Prompt cache_control markers

- `system` block serialized as `[{type:'text', text, cache_control:{type:'ephemeral'}}]` array form.
- Last tool definition carries `cache_control: { type: 'ephemeral' }`.
- IDE-side only — full upstream effect requires backend hook to forward the markers (0.7.x backlog).

NB: same as C.5, committed into 0.6.2. Listed for changelog completeness.

### C.7 — System reminder injection in `read_file`

- `read_file` injects `<system-reminder>` inside the tool result for empty files + externally-modified files (hash mismatch detected without going through our write tools).
- claude-vaz parity: `FileReadTool.ts:706-730`.

### C.8 — Time-based microcompaction

- `lastAssistantMessageAt` tracks wall-clock of last completed turn.
- When gap > 60min (matches upstream cache TTL), aggressive `keepRecent=5` (vs default 8) — cache is guaranteed expired anyway.

NB: shipped as 0.6.2 item; documented here for traceability.

### C.9 — Miscellaneous polish

- Adaptive warn buffer on context window (`utils/contextWindow.ts`) — was 20K flat, now `max(20K, effective × 7%)` so orange fires earlier on 1M-context models.
- Overrun icon (`FiAlertOctagon`) distinct from compact-imminent (`FiArchive`).
- Stale `MODEL_CONTEXT_WINDOWS_FALLBACK` table removed.
- Dead `setContextWindowSize` method removed.
- Language consistency: all retry / exhausted messages converted PT → EN to match the chat surface.

### C.10 — `/plan` multi-write+edit refactor (resilience fix)

- **Problem fixed**: the architect was emitting PLAN.md as a single `${WRITE_FILE}`({ path, content: "<full document>" }). The whole markdown body crossed the stream as JSON-escaped `input_json_delta` events. On long sessions (DashScope GLM-5.1 direct AND Xiaomi Mimo via OpenRouter both observed), the upstream socket dropped mid-stream → `content_block_stop` for the tool_use never arrived → the tool was silently dropped from `turnResult.toolCalls`. The retry path (`agentService.ts:789-823`) re-issued the turn with the same `X-Request-Type=plan` header (forcing reasoning ON again) plus the architect prompt (~10K chars) plus the same monolithic Write expectation → re-cut at the same point → exhaust `MAX_INTERRUPT_RETRIES` → surface to user. Symptom: PLAN.md never landed. Workaround: user typed "Continue" and got a degraded plan (default IDE prompt, no architect template).

- **Fix shape**: ported the incremental write pattern from claude-vaz (Write the plan file in multiple turns) and Kilo Code (incremental Write+Edit on a single plan file at a deterministic path). Architect prompt now produces:
  1. `${WRITE_FILE}` of a scaffold (frontmatter with `Status: DRAFT` + every section heading from §1 to §14 with `_In progress._` placeholders).
  2. A sequence of `${EDIT_FILE}` calls — one per section — replacing each placeholder with finished content. Each Edit is a short stream; a mid-stream drop loses at most one section, not the whole plan.
  3. A FINAL `${EDIT_FILE}` flips frontmatter `Status: DRAFT` → `Status: PENDING APPROVAL`. This is the IDE's machine-readable "plan is ready" marker.
  4. `${UPDATE_TASKS}` seeds the tracker.
  5. 3-sentence summary, then STOP.

- **Mechanical layer already supported the new shape**: `planMode.ts` already lists `EDIT_FILE` in `PLAN_MODE_ALLOWED_TOOLS` and path-restricts it to PLAN.md/TODO.md at the project root. The strict-STOP guard at `toolExecutor.ts:299` fires only AFTER both `planFileWritten` and `planTasksSeeded` are true — multiple Edits between Write and `update_tasks` don't trip it. No executor changes needed.

- **IDE readiness check upgraded**: `executePlan` no longer treats `fileExists(PLAN.md)` as the "done" signal — with the scaffold flow, the file exists from turn 2. The new `readPlanReadiness()` helper checks the file is on disk AND contains `Status: PENDING APPROVAL` (case-insensitive, blockquote-prefix-tolerant). If the marker is missing the IDE surfaces a tailored message: "Plan generation was cut off — PLAN.md is still in DRAFT. Type 'Continue' to resume from the next unfilled section." This converts what used to be silent corruption into a clear user-facing recovery path.

- **Files changed**:
  - `src/services/agent/commands/planCommand.ts` — `getChannelRuleSection`, `getCompletionRule`, `getAllowedToolsSection`, `getApprovalFlowSection`, `getTaskListSection`, `getWorkedExample`, `getReminder`, `getPlanMdTemplate` (frontmatter note); `executePlan` end-of-flow readiness gate; new `readPlanReadiness` helper.

- **Not yet refactored**: `buildTodoPrompt` (TODO generation after plan approval) still uses a single `${WRITE_FILE}` for TODO.md. TODO is smaller than PLAN.md (table + checklist, not 14 prose sections) so the cut risk is lower, but for consistency it should follow the same pattern in a follow-up. Tracked under D.7.

- **Paired follow-up**: the auto-retry path in `agentService.ts:789-823` still re-sends `X-Request-Type: plan` on each interrupt retry, re-forcing reasoning ON and re-inflating the stream that just cut. With C.10 the surface is smaller per Edit, so the cut is unlikely to recur — but the retry path should still be hardened. Tracked under D.7.

- **claude-vaz / Kilo Code parity**: matches the spirit of both. claude-vaz writes its plan file across multiple turns under the `plan` permission mode; Kilo Code's plan-mode reminder explicitly says "build your plan incrementally by writing to or editing this file". Neither uses a single monolithic Write. We're now aligned.

---

## D. Considered but deferred (audit items not picked for 0.7.0)

> Listed for memory. Each was flagged in the claude-vaz divergence audits but pushed past 0.7.0 in favour of the items above.

| # | Item | Reason for deferral |
|---|---|---|
| D.1 | **Cost tracking per-model** (audit 2 #1) — `/cost` command, per-model breakdown, cache hit stats, session-scoped cost persistence | Requires changes in the billing pipeline (worker → IDE) — bigger than 0.7.0 wants to absorb. Standalone 0.7.1 item. |
| D.2 | **File staleness with mtime** (audit 1 #3) — current hash-only check misses byte-preserving touches (formatter, sort-imports) | Real bug but rare. C.7 (system-reminder injection) partially mitigates by surfacing hash mismatch loudly when it does fire. Full fix in 0.7.1. |
| D.3 | **Read tool `cat -n` line numbering** (audit 1 #4) | Mostly affects long-file references. The IDE's offset/limit + tooling around line refs already covers most cases. Defer; pick up if eval shows the model wasting turns on line counting. |
| D.4 | **TodoWrite one-in-progress discipline + turn-since-write reminder** (audit 1 #5) | Quality-of-life. The `update_tasks` tool works; users haven't reported the chaos pattern observed in claude-vaz dogfood. Defer; revisit if user-reported. |
| D.5 | **Background agents follow-up** (audit 1 #6) — make `spawn_background_agent` accept SendMessage continuations | Power-user feature. Current one-shot covers 95% of use cases. Defer behind sub-agents (Sections 1–14) which is the higher-leverage piece. |
| D.6 | **Worker-side prompt-cache key from `cache_control` hints** | C.6 markers are emitted by the IDE but the worker doesn't yet translate them into upstream cache-key/Anthropic cache_control on the forward path. Plan-managed users (DashScope/OpenRouter) currently get no token savings from the markers. Backend work for 0.7.1+. |
| D.7 | **Retry path clears `X-Request-Type` + `buildTodoPrompt` multi-write+edit** (paired with C.10) | Two small follow-ups to the /plan resilience fix. (a) When the stream-interrupted retry re-issues a turn, the singleton `agentService.requestType` is still `'plan'` so reasoning is forced ON again — should be temporarily cleared for the retry only, then restored. Touches `agentService.ts:789-823`. (b) `buildTodoPrompt` should mirror C.10's scaffold + edits shape for TODO.md so a long task list doesn't regress to the same cut symptom. Both small enough to land mid-0.7.0 but split from C.10 for separate test coverage. |
| D.8 | **Resume `/plan` when user types "Continue" with DRAFT plan on disk** (gap in C.10) | C.10 added a tailored "Plan generation was cut off — PLAN.md is still in DRAFT. Type 'Continue' to resume from the next unfilled section" message when the architect's auto-retries exhaust. But "Continue" goes through the default chat path — the architect `systemPromptOverride` is gone by then (it was scoped to the single `runAgentWithCallbacks` call in `executePlan`, and the `finally` block reset `requestType` and `planMode`). So the model recovering on user-typed "Continue" sees the default IDE prompt, NOT the architect role, and may improvise a degraded plan — the exact failure mode C.10 was trying to fix. Fix: in `usePromptBar` (or `PromptInput.handleSend`), before dispatching a normal chat turn, check if PLAN.md exists in `<projectRoot>` with `Status: DRAFT` (reuse `readPlanReadiness`). If yes AND the user message is a short continuation cue ("continue", "continua", "go on", etc.), re-dispatch through `executePlan` instead of the default chat path. Recovers the architect role with the same plan-mode permissions and prompt. Small but touches prompt-dispatch routing — wants its own integration test. |

---

## E. `/plan-feature` command (deferred — post-0.7.0)

> Status: NOT STARTED. Full design to be authored separately when 0.7.0 sub-agents (Sections 1–14) ship.
> Source-of-truth references: claude-vaz `EnterPlanModeTool` / `ExitPlanModeTool` pair (`tools/EnterPlanModeTool/`, `tools/ExitPlanModeTool/`); Kilo Code Plan mode (`packages/opencode/src/session/prompt.ts`, `src/tool/plan.ts`, `src/session/session.ts:328` for plan-file path resolution).

### E.1 — Context

Today's `/plan` produces full-application architecture: 14-section FULLSTACK template, platform-publish constraints, file structure tabulated by phase, alternatives + risks + quality attributes. Appropriate for greenfield apps. **Overkill for feature-level changes** inside an existing project — "add OAuth", "refactor the search bar", "introduce dark mode". The model spends most of its budget filling sections that are N/A for a feature-scoped change, and the user gets a document that doesn't match the granularity of the work.

`/plan-feature` is a sibling command for feature-level planning, modelled on Kilo Code's Plan mode and claude-vaz's plan mode. Short, incremental, written to a `.tmcode/plans/` directory rather than top-level `PLAN.md`, multiple Write+Edit turns instead of one giant tool_use, and (once 0.7.0 sub-agents land) parallel exploration via `task`.

### E.2 — Shape (sketch only — full design deferred)

- **Plan file path**: `<projectRoot>/.tmcode/plans/<timestamp>-<slug>.md` (mirrors Kilo Code's `.kilo/plans/<ts>-<slug>.md`). Multiple plans coexist; old plans stay in disk for reference.
- **Activation**: slash command flips a per-session `planFeatureMode` flag — no `systemPromptOverride`. Default system prompt stays; a per-turn `<system-reminder>` is injected describing the mode + the plan file path.
- **Permission ruleset**: writes blocked everywhere except on the plan file (hard-enforced at the executor, mirrors Kilo Code's `hardPermissions`). Survives a model that ignores the prompt.
- **Sub-agent usage** (post-0.7.0): architect spawns `task(Explore, ...)` for codebase patterns, `task(Research, ...)` for external API research, potentially 2-3 in parallel. Each returns a compact summary to the architect; architect synthesises into the plan file.
- **Incremental writing**: model uses `write_file` for initial scaffold then `edit_file` for refinement across multiple small turns. No single Write with the whole document as `content`.
- **Completion signal**: `plan_exit` tool with empty params — same pattern as claude-vaz `ExitPlanMode` and Kilo Code `plan_exit`. Plan content lives in the file; never crosses the stream as tool_use args.
- **Hand-off**: when user approves, the coder agent receives a synthetic message ("execute the plan at `<path>`") on the next turn — same pattern as Kilo Code's auto-injection on agent transition.

### E.3 — Non-goals (when designed)

- **Replacing `/plan`**. They coexist:
  - `/plan` for application architecture (greenfield, FULLSTACK template, Cloudflare publish constraints, 14 sections).
  - `/plan-feature` for feature-level changes inside an existing project. Sections appear organically based on the work.
- **The 14-section template**. `/plan-feature` plans follow the user's idea, not a fixed shape.
- **Forcing reasoning ON** via `X-Request-Type` header. The user's thinking-mode preference applies normally.
- **`update_tasks` mirror**. Optional; off by default (the tracker is overkill for a 3-task feature plan).
- **Approval card on the top-level file tree**. Plans live in `.tmcode/plans/`, not at project root; the IDE renders the approval card inline in chat from the chosen plan file path.

### E.4 — Dependencies

1. Sub-agents (Sections 1–14) shipping in 0.7.0.
2. The current `/plan` first refactored to multi-write+edit shape — otherwise the cut symptom carries over to `/plan-feature` and the new command inherits the same brittleness.
3. Permission-ruleset enforcement in the ToolExecutor (the current `planMode` flag is prompt-level only; `/plan-feature` needs a hard gate that allows writes ONLY to the chosen plan file).

### E.5 — Open questions (to resolve at design time)

- Reuse existing `PlanApprovalCard` UI or new one? Probably new — `/plan-feature` plans are smaller and the approval UX can be lighter (Approve / Request changes, no Reject-to-restart since the file is incremental).
- File-watcher integration: should the IDE show plan files in the sidebar under `.tmcode/plans/`? Yes — makes them discoverable and editable.
- Resume semantics: typing `/plan-feature` while an unfinished plan exists in `.tmcode/plans/` should resume editing it (same pattern as Kilo Code's "plan already exists at X" branch), not start a new file.

Full design lands as `docs/PLAN-FEATURE-COMMAND.md` once 0.7.0 ships and we know the actual sub-agent surface to build against.

---

## F. Release checklist (0.7.0 cut)

Before the 0.7.0 tag:

- [ ] Sections 1–14 (sub-agents) — implementation complete through Phase 5.
- [ ] Section A (hooks) — implementation through Phase A5; docs published.
- [ ] Section B (custom commands) — implementation through Phase B5; docs published.
- [ ] Section C — already in working tree; bundle into the release commit(s).
- [ ] `package.json` + `tauri.conf.json` version bump 0.6.2 → 0.7.0.
- [ ] CHANGELOG entry consolidating C.1–C.9 (visible behaviour changes only — drop the polish items).
- [ ] Manual smoke test: chat-mode scaffold flow + verifier, terminal-mode `/init` + `/plan`, sub-agent spawn from architect prompt.
- [ ] BugHunter `/plan` 2026-05-16 scenario re-run to verify the ≥30K token savings claim from Section 9.
