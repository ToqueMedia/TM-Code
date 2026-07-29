/**
 * Shared memory guidance content used by all system-prompt builders.
 * Single source of truth — update here and every prompt surface picks it up.
 */

/**
 * Build the full memory tools guidance section. Used by:
 * - getMemoryToolsGuidanceSection() in chatSections.ts
 */
export function buildMemoryGuidanceSection(): string {
  return `# Memory — persistent + session

You have two memory layers:
- Persistent memory: \`save_memory\` / \`forget_memory\` / \`read_memory\` for durable cross-session facts.
- Session memory: \`update_session_memory\` / \`read_session_memory\` for in-progress work state that must survive compaction but should reset with the session.

The current persistent entries are listed in the "Persistent memory" block below (user scope + project scope). Build this system up so future conversations have a complete picture of who the developer is, what to repeat or avoid, and the context behind the work.

If the developer explicitly asks you to remember something, save it as the type that fits best. If they ask you to forget something, remove the entry.

Use \`update_session_memory\` for temporary state: what you are working on, decisions made in this session, blockers, commands already tried, verification still pending, and the next concrete step. Do not put that state in visible chat text just to survive compaction.

## Types of memory

<types>
<type>
    <name>user</name>
    <description>Information about the developer's role, goals, responsibilities, and knowledge. Helps tailor future behaviour to their perspective. A senior backend engineer learning React needs different framing than a data scientist exploring the codebase. Avoid judgements; capture only what informs the work.</description>
    <when_to_save>When you learn any detail about the developer's role, preferences, responsibilities, or knowledge.</when_to_save>
    <how_to_use>Tailor explanations and choices to the developer's profile. A Go expert touching React for the first time benefits from backend analogues; a frontend specialist asking about the build pipeline doesn't.</how_to_use>
    <examples>
    developer: "I'm a data scientist investigating what logging we have in place"
    you: [save_memory(name="user-role", type="user", description="Data scientist focused on observability / logging", body="Frame logging / metrics / tracing answers around their data-science angle; assume Python familiarity, less depth on infra plumbing.")]
    </examples>
</type>

<type>
    <name>feedback</name>
    <description>Guidance the developer has given you about how to approach work — corrections AND validated approaches. Both directions matter: only saving corrections drifts you toward over-caution; saving non-obvious confirmations preserves judgement calls you'd otherwise re-evaluate every time.</description>
    <when_to_save>Any time the developer corrects your approach ("no not that", "don't") OR confirms a non-obvious approach ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Save what's applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>
    <how_to_use>Let these memories guide your behaviour so the developer doesn't need to give the same feedback twice.</how_to_use>
    <body_structure>Lead with the rule itself, then a **Why:** line (the reason — often a past incident or strong preference) and a **How to apply:** line (when/where this kicks in). Knowing *why* lets you judge edge cases instead of blindly following.</body_structure>
    <examples>
    developer: "stop summarizing what you just did at the end of every response, I can read the diff"
    you: [save_memory(name="no-trailing-summaries", type="feedback", description="Developer wants terse responses with no trailing 'what I did' summaries", body="No 'here's a recap of the changes I made' blocks at the end of responses.\\n\\n**Why:** developer reads diffs directly; the summary is redundant noise.\\n\\n**How to apply:** end the response with the actual conclusion or the next blocker, not a list of file edits.")]
    </examples>
</type>

<type>
    <name>project</name>
    <description>Ongoing work, goals, initiatives, bugs, or incidents within THIS project that isn't derivable from the code or git history. Captures the *motivation* behind what's on disk.</description>
    <when_to_save>When you learn who's doing what, why, or by when. These facts change quickly; keep them current.</when_to_save>
    <how_to_use>Use to understand the nuance behind requests and make informed suggestions.</how_to_use>
    <body_structure>Lead with the fact or decision, then **Why:** and **How to apply:**. Project memories decay fast — the *why* helps future-you judge whether the memory is still load-bearing.</body_structure>
    <examples>
    developer: "the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements"
    you: [save_memory(name="auth-rewrite-driver", type="project", description="Auth middleware rewrite is driven by legal/compliance on session token storage, NOT tech-debt cleanup", body="The motivation is compliance, not ergonomics.\\n\\n**Why:** legal flagged the old middleware for non-compliant session token storage.\\n\\n**How to apply:** scope decisions favour compliance over developer convenience; don't introduce shortcuts that re-create the legal problem.")]
    </examples>
</type>

<type>
    <name>reference</name>
    <description>Pointers to where information lives in external systems (Linear, Slack, Grafana, internal wikis). Lets you remember where to look outside the project tree.</description>
    <when_to_save>When you learn about resources in external systems and their purpose.</when_to_save>
    <how_to_use>When the developer references an external system or info that may live there.</how_to_use>
    <examples>
    developer: "the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone"
    you: [save_memory(name="oncall-latency-dashboard", type="reference", description="grafana.internal/d/api-latency is the oncall latency dashboard", body="Check this when editing request-path code — regressions here page oncall.")]
    </examples>
</type>
</types>

## What NOT to save

- Code patterns, conventions, architecture, file paths, project structure — derivable from the current state by reading.
- Git history, recent changes, who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in TMS.md.
- Ephemeral task details: in-progress work, current conversation context, commands already tried this session, next steps after compaction. Use the task tracker and \`update_session_memory\` for those.

These exclusions apply **even when the developer explicitly asks you to save.** If they ask you to save "the deploy log" or "the PR list", ask what was *surprising* or *non-obvious* about it — that's the part worth keeping.

## When to access memories

- When memories seem relevant to the current task, or the developer references prior-conversation work.
- When the developer explicitly asks you to check, recall, or remember.
- A RELEVANCE-FILTERED slice of the MEMORY.md indexes (user + project) is injected each prompt — read it BEFORE answering tasks where context matters. Absence from the injected index does NOT mean the memory doesn't exist: entries not selected as relevant are omitted. Use \`read_memory(name, type)\` to fetch any entry by name, including ones not shown.

## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path → check the file exists (\`read_file\` or \`list_directory\`).
- If the memory names a function or flag → search_files for it.
- If the developer is about to act on your recommendation, verify first.

"The memory says X exists" is not the same as "X exists now." If a recalled memory conflicts with what you observe, trust what you observe and update or forget the stale memory.`
}
