/**
 * Fork sub-agent pattern — adapted from claude-vaz for TM Code.
 *
 * The fork pattern allows a child agent to inherit the parent's full
 * conversation context, enabling context-rich delegation without
 * re-summarising the conversation history.
 *
 * TM Code differences from claude-vaz:
 *   - No coordinator mode (always available)
 *   - No GrowthBook feature flags — uses a simple boolean toggle
 *   - No git worktrees — single working directory
 *   - Uses ContentBlockAPI type instead of claude-vaz's Message union
 *
 * SRP: builds forked conversation messages and child directive text.
 */

import type { ContentBlockAPI } from '../../types/chat'
import { filterIncompleteToolCalls, type InternalMessage } from './messageUtils'

// ── Constants ──

const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
const FORK_DIRECTIVE_PREFIX = 'Your directive: '
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

// ── Feature gate ──

let forkEnabled = false

export function setForkSubagentEnabled(enabled: boolean): void {
  forkEnabled = enabled
}

export function isForkSubagentEnabled(): boolean {
  return forkEnabled
}

// ── Recursion guard ──

/**
 * Detect if the current conversation is already inside a fork child.
 * Prevents recursive forking — fork children must execute directly.
 */
export function isInForkChild(messages: InternalMessage[]): boolean {
  return messages.some(m => {
    if (m.role !== 'user') return false
    if (!Array.isArray(m.content)) return false
    return (m.content as ContentBlockAPI[]).some(
      block => block.type === 'text' && block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

// ── Message builders ──

/**
 * Build the forked conversation messages for a child agent.
 *
 * Strategy:
 * 1. Filter out orphaned tool_call blocks (API safety)
 * 2. Keep the parent's full conversation history
 * 3. Append a directive message that instructs the child
 *
 * The child inherits context but starts fresh with a clear directive.
 */
export function buildForkedMessages(
  parentMessages: InternalMessage[],
  directive: string,
): InternalMessage[] {
  // Strip orphaned tool_call blocks that would cause API errors
  const cleanMessages = filterIncompleteToolCalls(parentMessages)

  // Append the fork directive as a new user message
  const directiveMessage: InternalMessage = {
    role: 'user',
    content: buildChildDirective(directive),
  }

  return [...cleanMessages, directiveMessage]
}

/**
 * Build the directive text that instructs the fork child.
 *
 * The directive includes a boilerplate tag for recursion detection
 * and strict rules for the child's behaviour.
 */
function buildChildDirective(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps.
3. Do NOT editorialize or add meta-commentary.
4. USE your tools directly: read_file, write_file, search, etc.
5. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
6. Stay strictly within your directive's scope.
7. Keep your report under 500 words unless the directive specifies otherwise.
8. Your response MUST begin with "Scope:". No preamble.

Output format:
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * Build placeholder tool_result blocks for all tool_call blocks in a message.
 *
 * When the parent was in the middle of executing tools when the fork
 * triggered, we need to provide placeholder results for any pending
 * tool_call blocks so the API doesn't reject the conversation.
 */
export function buildPlaceholderToolResults(
  assistantContent: ContentBlockAPI[],
): ContentBlockAPI[] {
  const toolCallBlocks = assistantContent.filter(
    (block): block is ContentBlockAPI & { type: 'tool_call'; id: string } =>
      block.type === 'tool_call',
  )

  return toolCallBlocks.map(block => ({
    type: 'tool_result' as const,
    toolCallId: block.id,
    content: FORK_PLACEHOLDER_RESULT,
  }))
}
