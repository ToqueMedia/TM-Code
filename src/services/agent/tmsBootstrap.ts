/**
 * TMS.md bootstrap service for external projects.
 *
 * When a project opened in TM Code lacks TMS.md (and has meaningful content),
 * this module provides a focused prompt that instructs the agent to:
 *   1. Analyze the project (read package.json, scan structure, detect framework)
 *   2. Create TMS.md at the project root
 *   3. Start the dev server using the detected command
 *
 * The prompt is designed to be the sole user input in a dedicated agent turn —
 * the agent has no competing user intent and must focus entirely on project setup.
 *
 * Reuses `buildInitPrompt` from initCommand.ts to avoid template duplication.
 *
 * @module tmsBootstrap
 */

import { buildInitPrompt } from './commands/initCommand'

/**
 * Returns a focused bootstrap prompt for TMS.md creation + dev server start.
 * The caller runs this as a standalone agent turn before the user's real message.
 *
 * @param projectPath  Absolute path to the project root.
 */
export function getTmsBootstrapPrompt(projectPath: string): string {
  // Reuse the same prompt as /init (no existing TMS.md case)
  const initPrompt = buildInitPrompt(projectPath, null)

  // Append dev server instruction — not part of /init (which lets the user decide)
  return `${initPrompt}

After writing TMS.md, start the dev server using start_dev_server with:
- command: the dev command you detected from package.json (e.g. "npm start", "npm run dev", "yarn dev")
- project_kind: "frontend", "backend", or "fullstack" based on your analysis

If you cannot determine the dev command, skip the dev server step and report what you found.`
}
