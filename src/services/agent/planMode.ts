/**
 * Plan mode access control — pure functions for the /plan architect role.
 *
 * Lives in its own module so unit tests can exercise the allowlist + path
 * restriction without instantiating ToolExecutor (which registers ~30 tools
 * and pulls in Tauri/store dependencies). The runtime check in
 * toolExecutor.ts wraps `checkPlanModeAccess` with the executor's project
 * root.
 */

import {
  READ_FILE, LIST_DIRECTORY, GLOB, SEARCH_FILES,
  GET_DIAGNOSTICS, READ_SKILL, READ_LARGE_RESULT,
  UPDATE_TASKS, COLLECT_RESULTS,
  WEB_SEARCH, WEB_FETCH, DELEGATE,
  WRITE_FILE, CREATE_FILE, EDIT_FILE,
  ASK_USER_QUESTION,
} from './toolNames'

// Tools the architect agent is allowed to call while planMode is on.
// Anything not in this set returns a mechanical block.
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  // Reading the project — every architect operation depends on these
  READ_FILE, LIST_DIRECTORY, GLOB, SEARCH_FILES,
  GET_DIAGNOSTICS, READ_SKILL, READ_LARGE_RESULT,
  // Internal task list (not project files)
  UPDATE_TASKS, COLLECT_RESULTS,
  // Delegation + research while drafting the plan
  WEB_SEARCH, WEB_FETCH, DELEGATE,
  // Writing the deliverable. Path-restricted to PLAN.md / TODO.md below.
  WRITE_FILE, CREATE_FILE, EDIT_FILE,
  // Structured clarifying questions — blocks the agent loop until the developer answers
  ASK_USER_QUESTION,
])

// Files the architect is allowed to mutate, identified by basename. The
// full-path check below ensures these only match at the project root —
// `node_modules/PLAN.md` or any nested PLAN.md is still rejected.
const PLAN_MODE_WRITABLE_BASENAMES: ReadonlySet<string> = new Set<string>([
  'PLAN.md', 'TODO.md',
])

const WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  WRITE_FILE, CREATE_FILE, EDIT_FILE,
])

/**
 * True iff `filePath` resolves to a plan artefact at the project root —
 * i.e. exactly `<projectRoot>/PLAN.md` or `<projectRoot>/TODO.md`. Accepts
 * either a project-relative path ("PLAN.md") or an absolute one. Anything
 * nested below the root (`subdir/PLAN.md`, `src/TODO.md`) is rejected.
 */
export function isPlanArtefactAtRoot(filePath: string, projectRoot: string): boolean {
  if (!filePath) return false
  const normalised = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = (projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '')
  // Project-relative form: bare filename, no slash.
  if (!normalised.includes('/')) {
    return PLAN_MODE_WRITABLE_BASENAMES.has(normalised)
  }
  // Absolute form: must equal projectRoot/PLAN.md or projectRoot/TODO.md.
  if (!root) return false
  for (const basename of PLAN_MODE_WRITABLE_BASENAMES) {
    if (normalised === `${root}/${basename}`) return true
  }
  return false
}

/**
 * Returns a block message if the call should be denied under planMode, or
 * null if the call may proceed. The message is what the model receives as
 * the tool result — phrase it as guidance so the next agent step routes
 * back to PLAN.md instead of retrying the same blocked tool.
 */
export function checkPlanModeAccess(
  toolName: string,
  filePath: string,
  projectRoot: string,
): string | null {
  if (!PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
    const allowedList = [
      READ_FILE, LIST_DIRECTORY, GLOB, SEARCH_FILES, GET_DIAGNOSTICS, READ_SKILL,
      UPDATE_TASKS, WEB_SEARCH, WEB_FETCH, ASK_USER_QUESTION,
    ].join(', ')
    return `Blocked in /plan architect mode: ${toolName} is an implementation tool. Document what this step would do in PLAN.md's Implementation Phases section — the coding agent will run it after the user approves the plan. Allowed in this mode: ${allowedList}, ${WRITE_FILE}/${CREATE_FILE}/${EDIT_FILE} (PLAN.md or TODO.md only).`
  }
  if (WRITE_TOOLS.has(toolName) && !isPlanArtefactAtRoot(filePath, projectRoot)) {
    return `Blocked in /plan architect mode: ${toolName} can only write PLAN.md or TODO.md at the project root. Tried to write "${filePath}". Source files belong to the implementation phase that follows user approval — describe them in PLAN.md's File Structure table instead.`
  }
  return null
}
