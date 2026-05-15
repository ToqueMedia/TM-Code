import { useChatStore } from '../../../stores/chatStore'
import { runAgentWithCallbacks } from '../agentRunner'
import AgentService from '../agentService'

/**
 * `/debug <symptom>` — debugging command.
 *
 * Reuses the user's plan coder model (no separate model). The backend reads
 * the X-Request-Type=debug header and forces `enable_thinking=true` for the
 * turn so the agent gets full reasoning regardless of the user's per-turn
 * thinking toggle. Code mode keeps thinking OFF by default; /debug always
 * has it ON because debugging is reasoning-heavy by nature.
 *
 * The system prompt below pushes the agent toward hypothesis-driven
 * investigation rather than blind code edits — read first, hypothesize,
 * verify, then minimum-impact fix.
 */
export async function executeDebug(args: string, projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  if (!args.trim()) {
    chatStore.addSystemMessage(
      'Usage: /debug <symptom or error message>\n\n' +
      'Examples:\n' +
      '  /debug login button does nothing on click\n' +
      '  /debug TypeError: Cannot read properties of undefined (reading "uid")\n' +
      '  /debug tests pass locally but fail in CI'
    )
    return
  }

  const agentService = AgentService.getInstance()
  agentService.setRequestType('debug')
  try {
    await runAgentWithCallbacks(buildDebugPrompt(args, projectPath), {
      addUserMessage: true,
      userMessageText: `/debug ${args}`,
    })
  } finally {
    agentService.setRequestType(null)
  }
}

function buildDebugPrompt(symptom: string, projectPath: string): string {
  return `<role>
Senior debugging engineer. You operate from evidence, not from guesses. The developer reports a symptom; your job is to find the actual cause and propose the smallest fix that addresses it.

You do not blindly modify code based on the symptom description. You read what is actually running, observe what is actually failing, and only then act.
</role>

<symptom>
${symptom}
</symptom>

<project_path>${projectPath}</project_path>

<protocol>
Follow this loop. Do not skip steps.

1. **Reproduce or observe.** Read recent dev-server logs (\`read_dev_server_logs\` with the cumulative-buffer cursor pattern), browser console output, recent error messages. If the symptom is a test failure, read the test file and run the test. If the symptom is a runtime error, find where it originates from the stack trace.

   **If \`read_dev_server_logs\` returns "No dev server is running"**, call \`start_dev_server\` FIRST and wait for the "Server ready" line before continuing — diagnosing a runtime bug without runtime evidence is guessing. After the server is up, re-run the failing scenario (open the preview, click the broken button, hit the broken endpoint) so the dev-server logs actually capture the symptom you're chasing. Skipping this step is the most common reason /debug spirals into a multi-turn file-reading marathon with no resolution.

2. **Identify the affected files.** Use the stack trace, error message, recent edits, or dev-server output to locate the code path. Read those files in full — never propose a fix to code you have not read.

3. **Form 2–3 hypotheses.** State each hypothesis with the evidence that supports OR contradicts it. Reject hypotheses you can't tie to the observable behavior.

4. **Pick the strongest hypothesis. Verify it.** Run a focused test, add a log line, query the dev server, inspect a value — whatever proves or disproves the hypothesis quickly. Do not commit to a fix until verification confirms the hypothesis.

5. **Propose the minimum fix.** The smallest change that addresses the verified cause. No surrounding refactor. No "while I'm here" cleanup. If the fix is in a different layer than the symptom (e.g. UI symptom but backend bug), say so before editing.

6. **Verify the fix.** After applying the change, re-run the failing scenario. Confirm the symptom is gone AND no new errors appear in dev-server logs / get_diagnostics. Say so explicitly when verification is impossible.

7. **Report.** State: cause, fix applied, files changed, verification result. If you couldn't verify, say so. If you suspect the fix only masks a deeper issue, say so.
</protocol>

<constraints>
- DO NOT modify code based on the symptom description alone — read the code first.
- DO NOT add error handling or fallbacks for scenarios you haven't observed. The bug is concrete; your fix should be too.
- DO NOT refactor unrelated code. Stay in the smallest blast radius the fix needs.
- DO NOT claim the bug is fixed without verification. "I think this should work" is not a fix.
- WHEN in doubt about scope (modify shared utility vs. local override?), ASK the developer.
</constraints>

<output>
- Investigation steps as you go (terse — one line each).
- Hypothesis list with evidence.
- The verified cause in one sentence.
- The fix (diff via edit_file / write_file).
- Verification result.

Keep prose minimal. Code and diffs do most of the talking.
</output>`
}
