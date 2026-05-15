/**
 * Sliding 3-task window helper shared by the chat-mode `TodoListCard`
 * (post-/plan approval) and the `AgentTasksPanel` (live agent task
 * tracker). Both compact UIs follow the same rule:
 *
 *   - default: show the first 3 tasks
 *   - once the "anchor" task is past index 2, slide so the anchor is the
 *     bottom of the visible window
 *   - surface "· N earlier / N more" counters so the user knows what's
 *     hidden without an open scroll affordance
 *
 * Caller supplies the anchor index — what counts as "the task the user
 * should see right now" differs between consumers (in_progress flag vs
 * first non-completed), and is policy not mechanism. The helper is
 * mechanism only: math on the array indices.
 *
 * Returns indices into the ORIGINAL array — callers slice their own items.
 */
export interface SlidingWindow {
  /** Inclusive index of the first item in the visible window. */
  start: number
  /** Inclusive index of the last item in the visible window. */
  end: number
  /** Count of items before `start` (collapsed into "· N earlier"). */
  hiddenAbove: number
  /** Count of items after `end` (collapsed into "· N more"). */
  hiddenBelow: number
}

/**
 * Compute the window indices.
 *
 * @param total Total number of items in the source array. Pass `array.length`.
 * @param anchorIdx Index the window must include. Pass `-1` (or any
 *   out-of-range value) to fall back to "show last `size` items" (recap mode
 *   when no anchor — e.g., all tasks completed).
 * @param size Window length. Default 3.
 */
export function computeSlidingWindow(
  total: number,
  anchorIdx: number,
  size = 3,
): SlidingWindow {
  if (total <= 0) {
    return { start: 0, end: -1, hiddenAbove: 0, hiddenBelow: 0 }
  }
  const lastIdx = total - 1
  const span = Math.max(0, size - 1)

  // No anchor (or out-of-range): show the tail. Useful for "all complete"
  // recap or when the caller hasn't classified any item as active.
  let resolvedAnchor = anchorIdx
  if (resolvedAnchor < 0 || resolvedAnchor > lastIdx) {
    resolvedAnchor = lastIdx
  }

  // Bias: keep the anchor at the bottom of the window once it's past
  // `span`. Earlier anchors (0..span) show [0..span] — the natural
  // "first 3" view at start-of-list.
  let start: number
  if (resolvedAnchor <= span) {
    start = 0
  } else {
    start = resolvedAnchor - span
  }
  const end = Math.min(lastIdx, start + span)
  return {
    start,
    end,
    hiddenAbove: start,
    hiddenBelow: lastIdx - end,
  }
}
