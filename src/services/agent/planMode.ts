/**
 * Plan mode access control — pure functions for the /plan architect role.
 *
 * Lives in its own module so unit tests can exercise the allowlist + path
 * restriction without instantiating ToolExecutor (which registers ~30 tools
 * and pulls in Tauri/store dependencies). The runtime check in
 * toolExecutor.ts wraps `checkPlanModeAccess` with the executor's project
 * root.
 */

// DOIS dialectos: o Set de permissões casa com as chaves do registo
// (CANÓNICO); as mensagens de bloqueio são LIDAS PELO MODELO e por isso
// nomeiam as tools como ele as vê no schema (ALIAS). Uma mensagem que diz
// "podes usar read_file" a quem só tem `Read` na lista não desbloqueia nada.
import {
  READ_FILE, READ_AROUND, LIST_DIRECTORY, GLOB, SEARCH_FILES,
  READ_SKILL, READ_LARGE_RESULT,
  UPDATE_TASKS, COLLECT_RESULTS,
  WEB_SEARCH, WEB_FETCH, CAPTURE_URL_DESIGN, DELEGATE,
  WRITE_FILE, CREATE_FILE, EDIT_FILE,
  ASK_USER_QUESTION,
  READ_ALIAS, LS_ALIAS, GLOB_ALIAS, GREP_ALIAS,
  WEB_SEARCH_ALIAS, WEB_FETCH_ALIAS, WRITE_ALIAS, EDIT_ALIAS,
  canonicalToolName, advertisedToolName,
} from './toolNames'

// Tools the architect agent is allowed to call while planMode is on.
// Anything not in this set returns a mechanical block.
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  // Reading the project — every architect operation depends on these
  READ_FILE, READ_AROUND, LIST_DIRECTORY, GLOB, SEARCH_FILES,
  READ_SKILL, READ_LARGE_RESULT,
  // Internal task list (not project files)
  UPDATE_TASKS, COLLECT_RESULTS,
  // Delegation + research while drafting the plan
  WEB_SEARCH, WEB_FETCH, CAPTURE_URL_DESIGN, DELEGATE,
  // Writing the deliverable. Path-restricted to the active plan artefact / TODO.md below.
  WRITE_FILE, CREATE_FILE, EDIT_FILE,
  // Structured clarifying questions — blocks the agent loop until the developer answers
  ASK_USER_QUESTION,
])

const WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  WRITE_FILE, CREATE_FILE, EDIT_FILE,
])

function normalisePlanFileName(planFileName: string): string {
  const basename = (planFileName || 'PLAN.md').replace(/\\/g, '/').split('/').pop() || 'PLAN.md'
  return basename.endsWith('.md') ? basename : 'PLAN.md'
}

/**
 * True iff `filePath` resolves to a plan artefact at the project root —
 * i.e. exactly `<projectRoot>/<planFileName>` or `<projectRoot>/TODO.md`.
 * Accepts either a project-relative path ("PLAN.md") or an absolute one.
 * Anything nested below the root (`subdir/PLAN.md`, `src/TODO.md`) is rejected.
 */
export function isPlanArtefactAtRoot(
  filePath: string,
  projectRoot: string,
  planFileName: string = 'PLAN.md',
): boolean {
  if (!filePath) return false
  const allowedBasenames: ReadonlySet<string> = new Set<string>([
    normalisePlanFileName(planFileName),
    'TODO.md',
  ])
  // Clean relative path prefix ./ or .\
  const cleanPath = filePath.replace(/^(\.\/|\.\\)+/, '')
  const normalised = cleanPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = (projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '')
  // Project-relative form: bare filename, no slash.
  if (!normalised.includes('/')) {
    return allowedBasenames.has(normalised)
  }
  // Absolute form: must equal projectRoot/PLAN.md or projectRoot/TODO.md.
  if (!root) return false
  for (const basename of allowedBasenames) {
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
  planFileName: string = 'PLAN.md',
): string | null {
  toolName = canonicalToolName(toolName)
  // O que se ECOA ao modelo é o nome que ele escreveu / que tem no schema.
  // Devolver-lhe "read_file is an implementation tool" depois de ele chamar
  // `Read` faz o bloqueio parecer ser sobre outra tool qualquer.
  const shownName = advertisedToolName(toolName)
  const planLabel = normalisePlanFileName(planFileName)
  if (!PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
    const allowedList = [
      READ_ALIAS, READ_AROUND, LS_ALIAS, GLOB_ALIAS, GREP_ALIAS, READ_SKILL,
      UPDATE_TASKS, WEB_SEARCH_ALIAS, WEB_FETCH_ALIAS, CAPTURE_URL_DESIGN, ASK_USER_QUESTION,
    ].join(', ')
    return `Blocked in /plan architect mode: ${shownName} is an implementation tool. Document what this step would do in ${planLabel}'s phases (Files & Phases on a FEATURE plan, Implementation Phases on a PROJECT plan) — the coding agent will run it after the user approves the plan. Allowed in this mode: ${allowedList}, ${WRITE_ALIAS}/${CREATE_FILE}/${EDIT_ALIAS} (${planLabel} or TODO.md only).`
  }
  if (WRITE_TOOLS.has(toolName) && !isPlanArtefactAtRoot(filePath, projectRoot, planLabel)) {
    return `Blocked in /plan architect mode: ${shownName} can only write ${planLabel} or TODO.md at the project root. Tried to write "${filePath}". Source files belong to the implementation phase that follows user approval — list them in ${planLabel}'s Files & Phases (FEATURE) or File Structure (PROJECT).`
  }
  return null
}
