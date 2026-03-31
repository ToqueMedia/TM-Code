import { useChatStore } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { runAgentWithCallbacks } from '../agentRunner'
import AgentService from '../agentService'

export async function executePlan(args: string, projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  if (!args.trim()) {
    chatStore.addSystemMessage(
      'Usage: /plan <description of what you want to build>\n\n' +
      'Example: /plan user authentication with email, Google login, and role-based access'
    )
    return
  }

  // Run the architect agent with reasoning model (Qwen 3.6 Plus via OpenRouter)
  const agentService = AgentService.getInstance()
  agentService.setRequestType('plan')
  try {
    await runAgentWithCallbacks(buildArchitectPrompt(args, projectPath), {
      addUserMessage: true,
      userMessageText: `/plan ${args}`,
    })
  } finally {
    agentService.setRequestType(null)
  }

  // Only show approval card if the agent didn't error out
  if (useAgentStore.getState().status !== 'error') {
    chatStore.addCardMessage('plan_approval', projectPath)
  }
}

export async function handlePlanApprove(projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  chatStore.addSystemMessage('Plan approved. Generating development task list...')

  // Generate TODO.md from the approved plan (with reasoning model)
  const agentService = AgentService.getInstance()
  agentService.setRequestType('plan')
  try {
    await runAgentWithCallbacks(buildTodoPrompt(projectPath), {
      addUserMessage: true,
      userMessageText: 'Generate task list from approved plan',
    })
  } finally {
    agentService.setRequestType(null)
  }

  // Only show todo card if the agent didn't error out
  if (useAgentStore.getState().status !== 'error') {
    chatStore.addCardMessage('todo_list', projectPath)
  }
}

export function handlePlanRequestChanges(): void {
  const chatStore = useChatStore.getState()
  chatStore.addSystemMessage(
    'What changes would you like? Describe in the chat and the architect will revise the plan.'
  )
}

export function handlePlanReject(): void {
  const chatStore = useChatStore.getState()
  chatStore.addSystemMessage('Plan rejected. You can start a new plan with /plan.')
}

export async function handleStartExecution(projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  chatStore.addSystemMessage('Starting plan execution...')

  const executionPrompt = `Read the TODO.md at ${projectPath}/TODO.md and start executing the tasks IN ORDER.

For each task:
1. Announce which task you're starting
2. Implement it completely
3. Mark it as done in TODO.md by changing "- [ ]" to "- [x]"
4. Move to the next task

If you encounter a problem:
- Try to solve it
- If you can't, explain the issue and move to the next task
- Add the blocked task to the "Pending Tasks" section of TMS.md

Update TMS.md Memory section as you complete milestones.

Start with the first uncompleted task.`

  await runAgentWithCallbacks(executionPrompt, {
    addUserMessage: true,
    userMessageText: 'Start executing the development plan',
  })
}

// ── Architect Prompt ──
// Follows key_prompts.md: U-Curve (§1+§11), few-shot (§3), role (§4),
// chain-of-thought (§5), constraints-as-contract (§6), context engineering (§7),
// Goldilocks (§8), output length (§14), error recovery (§15).

function buildArchitectPrompt(userIdea: string, projectPath: string): string {
  return `<completion_rule>
Write a complete PLAN.md with every section from the template below. Do not skip sections. If a section does not apply, write "N/A — {reason}" instead of omitting it.
</completion_rule>

<role>
Software architect. You analyze the existing codebase, identify constraints, evaluate trade-offs between concrete alternatives, and produce an architecture document that an engineer — or an AI coding agent — can implement without ambiguity.

You do not write wish lists. Every decision states what was chosen, what was rejected, and what was sacrificed.
</role>

<task>
The developer wants to build:
"${userIdea}"

Write an architecture document to ${projectPath}/PLAN.md.
</task>

<chain_of_thought>
Before writing PLAN.md, work through these steps using your tools:
1. Read the project's key files — entry points, config, and existing components related to this feature. The system prompt already has a file tree summary and package.json overview; go deeper only where needed.
2. Identify constraints: what exists that you must integrate with? What patterns does the codebase follow?
3. Consider at least 2 architectural approaches. Choose one with explicit reasoning.
4. Identify what can go wrong — failure modes, edge cases, integration risks.
5. Then write PLAN.md.
</chain_of_thought>

<plan_template>
The PLAN.md must follow this structure exactly:

# Architecture: {feature name}

> Author: TM Code Architect
> Date: {current date}
> Status: PENDING APPROVAL

## 1. Context

**Current state:** {what the system does today that is relevant to this feature}
**Problem:** {the gap, pain point, or need this feature addresses}
**System boundary:** {which parts of the system are affected — and which are NOT}

## 2. Goals & Non-Goals

### Goals
- {measurable outcome, not a feature description}

### Non-Goals
- {what this plan explicitly excludes — at least one item}

## 3. Architecture

### Design
{how the feature integrates into the existing system — layers touched, data flow}
{ASCII diagram showing component relationships and data flow}

### Components
{for each new or modified component:}
- **{Name}** — {responsibility}. Receives: {inputs}. Produces: {outputs}.

### Key Interactions
{step-by-step flow for the primary scenario AND the primary failure scenario}

## 4. Data Design

{entities with field names, types, and constraints — not just "key fields"}
{storage location: Zustand store, filesystem, database — and why}
{migration strategy if existing data is affected}

## 5. Interface Contracts

{for APIs: method, path, request body, response body, error codes}
{for components: props with types, callbacks}
{for events: event name, payload shape}

## 6. Technical Decisions

| Decision | Chosen | Alternatives considered | Trade-off |
|----------|--------|------------------------|-----------|
| {what was decided} | {chosen approach} | {at least one other option} | {what is gained vs. what is sacrificed} |

## 7. Quality Attributes

- **Performance:** {measurable target — e.g. "renders < 200ms with 1000 items"}
- **Reliability:** {failure modes and graceful degradation behavior}
- **Security:** {auth, validation, data protection — if applicable}

## 8. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| {what can go wrong} | {consequence if it happens} | {how to prevent or recover} |

## 9. Testing Strategy

- {what needs testing, what kind of test (unit/integration/manual), what is hard to test}

## 10. Implementation Phases

### Phase 1 — {name}: {deliverable}
- {task}: {files to create/modify}
- Depends on: none

### Phase 2 — {name}: {deliverable}
- {task}: {files to create/modify}
- Depends on: Phase 1

**Critical path:** {which phases block others, what can be parallelized}

## 11. Open Questions

- {decisions that need developer input before or during implementation}
</plan_template>

<example>
<user_idea>Add WebSocket support for real-time collaboration</user_idea>
<plan_output>
# Architecture: Real-Time Collaboration via WebSocket

> Author: TM Code Architect
> Date: 2026-03-20
> Status: PENDING APPROVAL

## 1. Context

**Current state:** The app uses HTTP request/response for all client-server communication. File changes are detected via filesystem polling every 2 seconds.
**Problem:** Two developers editing the same file see each other's changes only after a 2s delay and with no conflict resolution — last write wins silently.
**System boundary:** Affects the transport layer (new WS server), file sync service, and editor cursors. Does NOT affect the Monaco editor core, the terminal, or the authentication system.

## 2. Goals & Non-Goals

### Goals
- Changes propagate to all connected clients within 100ms
- Concurrent edits on the same file are merged without data loss (OT or CRDT)
- Presence indicators show who is editing which file

### Non-Goals
- Voice/video communication
- Conflict resolution UI for non-text files (images, binaries)
- Offline-first sync (requires a different architecture entirely)

## 3. Architecture

### Design
Client A                 Server                  Client B
   │                       │                        │
   ├──WS: edit(op)────────>│                        │
   │                       ├──transform(op)         │
   │                       ├──WS: broadcast(op')───>│
   │                       ├──persist(file)         │
   │<──WS: ack(rev)────────┤                        │

### Components
- **WsServer** (Rust, commands/ws.rs) — Accepts WebSocket connections, routes messages. Receives: client ops. Produces: transformed + broadcast ops.
- **OTEngine** (Rust, services/ot.rs) — Operational Transform logic. Receives: concurrent ops + document state. Produces: transformed ops preserving intent.
- **CollabService** (TS, services/collabService.ts) — Client-side WS wrapper. Receives: local editor changes. Produces: ops to send, remote ops to apply.
- **PresenceOverlay** (React, components/editor/PresenceOverlay.tsx) — Renders remote cursors. Receives: presence state from CollabService.

### Key Interactions
**Happy path:** Client A types → CollabService sends op → WsServer transforms against concurrent ops → broadcasts to Client B → CollabService applies remote op to Monaco.
**Failure path:** WS disconnects → CollabService queues local ops, shows "reconnecting" indicator → on reconnect, sends queued ops with last-known revision → server rebases and re-syncs full document state if revision gap > 50 ops.

## 4. Data Design

- Operation { type: 'insert' | 'delete' | 'retain', position: number, content?: string, length?: number, revision: number, clientId: string, timestamp: number }
- Presence { clientId: string, filePath: string, cursor: { line: number, column: number }, displayName: string, color: string }

Stored in: in-memory on server (operations buffer, max 1000 ops per file). Persisted: file written to disk after 500ms debounce of last op.
No migration needed — new system, no existing collab data.

## 5. Interface Contracts

WebSocket messages (JSON):
- Client → Server: { type: "op", fileId: string, op: Operation } | { type: "presence", presence: Presence }
- Server → Client: { type: "op", fileId: string, op: Operation, revision: number } | { type: "presence", presences: Presence[] } | { type: "sync", fileId: string, content: string, revision: number }
- Error: { type: "error", code: "CONFLICT" | "FILE_NOT_FOUND" | "RATE_LIMITED", message: string }

## 6. Technical Decisions

| Decision | Chosen | Alternatives considered | Trade-off |
|----------|--------|------------------------|-----------|
| Conflict resolution | OT (Operational Transform) | CRDT (Yjs/Automerge) | OT = simpler server, smaller payloads, proven in Google Docs scale. Sacrifice: server must be single coordinator (no P2P). Acceptable because we already have a centralized server. |
| Transport | Native WebSocket (tungstenite) | Socket.IO, gRPC streams | Native WS = no extra dependency, Tauri already has tokio. Sacrifice: no built-in reconnection/rooms (must implement). Acceptable for scope. |
| Editor integration | Monaco deltaDecorations API | Custom overlay canvas | deltaDecorations is Monaco-native, handles scrolling/folding automatically. Sacrifice: limited styling options for cursors. Acceptable — standard cursor indicators suffice. |

## 7. Quality Attributes

- **Performance:** Op propagation < 100ms end-to-end on LAN. OT transform < 5ms for 100 concurrent ops.
- **Reliability:** Client buffers ops during disconnect (up to 500 ops / 30 seconds). Full resync if gap exceeds buffer. No data loss — file on disk is always consistent.
- **Security:** WS connections authenticated via existing session token. Ops validated server-side (position bounds, content sanitization). Rate limit: 100 ops/second per client.

## 8. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| OT transform bugs cause document divergence | Users see different file content, potential data loss | Periodic checksum verification — server sends hash every 50 ops, client resyncs on mismatch |
| High op volume on large files degrades performance | Latency exceeds 100ms target, UI stutters | Batch ops in 16ms frames, compress sequential inserts into single op |
| WebSocket blocked by corporate proxies | Feature unusable for some users | Detect WS failure, fall back to HTTP long-polling with 500ms interval, show degraded-mode indicator |

## 9. Testing Strategy

- Unit: OT transform correctness — property-based tests (2 random op sequences, apply in both orders, verify convergence)
- Integration: 2 simulated clients editing same file, assert final content matches
- Manual: Disconnect/reconnect scenarios, high-latency simulation
- Hard to test: Race conditions under real network jitter — mitigate with checksum verification rather than trying to test exhaustively

## 10. Implementation Phases

### Phase 1 — Transport layer: WS connection established, echo server
- Create src-tauri/src/commands/ws.rs (WS accept + echo)
- Create src/services/collabService.ts (connect, send, receive)
- Depends on: none

### Phase 2 — OT engine: ops transform and merge correctly
- Create src-tauri/src/services/ot.rs (transform algorithm)
- Add op routing to ws.rs
- Unit tests for OT convergence
- Depends on: Phase 1

### Phase 3 — Editor integration: remote changes appear in Monaco
- Create src/components/editor/PresenceOverlay.tsx
- Integrate CollabService with Monaco onChange/onDidChangeCursorPosition
- Depends on: Phase 2

### Phase 4 — Resilience: reconnection, resync, edge cases
- Add disconnect detection, op buffering, full resync protocol
- Add checksum verification
- Depends on: Phase 3

**Critical path:** Phase 1 → 2 → 3 → 4 (linear — each builds on the previous). Phase 4 can begin partially during Phase 3 (buffering logic is independent of UI).

## 11. Open Questions

- Should presence show only cursor position or also selection ranges?
- Maximum number of concurrent editors per file? (Affects OT performance budget)
- Should the op log be persisted for undo-across-sessions, or is in-memory sufficient?
</plan_output>
</example>

<constraints>
These are requirements, not suggestions:
- Every section must contain concrete, implementable detail. "TBD" and "will be determined later" are not acceptable.
- "Technical Decisions" must list at least one alternative per decision. A decision without alternatives is an assumption, not a decision.
- "Quality Attributes" must have measurable targets. "Fast" is not a quality attribute. "< 200ms P99" is.
- "Risks" must list at least one risk with a mitigation. If you cannot identify any risk, you have not analyzed deeply enough.
- "Non-Goals" must list at least one item. Every plan has a boundary.
- After writing PLAN.md, give a 3-5 sentence summary in the chat.
</constraints>

<self_check>
Before finishing, verify:
1. Did every Technical Decision include at least one alternative and a trade-off?
2. Are all Quality Attributes measurable (numbers, not adjectives)?
3. Does the Risks table have at least one entry with a concrete mitigation?
4. Does the architecture handle the failure path, not just the happy path?
If any check fails, fix that section before finishing.
</self_check>

<reminder>
1. Complete every section — "N/A — {reason}" is acceptable, omitting a section is not.
2. Decisions require alternatives and trade-offs.
3. Quality attributes must be measurable.
</reminder>`
}

// ── TODO Prompt ──

function buildTodoPrompt(projectPath: string): string {
  return `Read the approved PLAN.md at ${projectPath}/PLAN.md and generate a development task list.

Write TODO.md at ${projectPath}/TODO.md following this structure:

\`\`\`markdown
# Development Tasks

> Generated from PLAN.md by TM Code
> Date: {current date}
> Status: 0/{total} tasks completed

---

## Phase 1 — {Phase Name from PLAN.md}

- [ ] **Task 1.1:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: none
  - Acceptance: {how to verify this task is done}

- [ ] **Task 1.2:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: Task 1.1
  - Acceptance: {how to verify this task is done}

## Phase 2 — {Phase Name}

- [ ] **Task 2.1:** ...

---

## Summary

| Phase | Tasks | Depends On |
|-------|-------|------------|
| Phase 1 — {name} | {count} | — |
| Phase 2 — {name} | {count} | Phase 1 |

**Critical path:** {from PLAN.md}
**Total: {count} tasks**
\`\`\`

Requirements:
1. Read PLAN.md first — use its Implementation Phases as the skeleton.
2. Break each phase into small tasks (each task = one coherent change, max 3-4 files).
3. Preserve the dependency chain from PLAN.md. Never reference a task that hasn't been done yet.
4. Each task must specify files AND an acceptance criterion (how to know it's done).
5. Include setup tasks (install deps, create directories) and testing tasks where PLAN.md's Testing Strategy calls for them.
6. Tasks that address risks from PLAN.md's Risks table should be explicit (e.g., "Add checksum verification — mitigates document divergence risk").
7. Write to TODO.md using write_file.
8. Present a summary in the chat.`
}
