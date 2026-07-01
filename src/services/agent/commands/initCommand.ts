import { invoke } from '@/utils/invokeMetrics'
import { t } from '../../../i18n'
import { useChatStore } from '../../../stores/chatStore'
import { runAgentWithCallbacks } from '../agentRunner'
import type { SlashCommandMode } from '../slashCommandRegistry'

export async function executeInit(
  args: string,
  projectPath: string,
  mode: SlashCommandMode = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()

  // Check if TMS.md already exists
  const tmsPath = `${projectPath}/TMS.md`
  let existingTms: string | null = null

  try {
    existingTms = await invoke<string>('read_file', { path: tmsPath })
  } catch {
    // Doesn't exist — normal
  }

  if (existingTms !== null) {
    chatStore.addSystemMessage(
      t('init.alreadyExists')
    )
  } else {
    chatStore.addSystemMessage(
      t('init.analyzing')
    )
  }

  const initPrompt = buildInitPrompt(projectPath, existingTms, args)

  await runAgentWithCallbacks(initPrompt, {
    addUserMessage: true,
    userMessageText: '/init',
    intentOverride: {
      profile: 'project_bootstrap',
      readOnly: false,
      source: 'keyword',
      confidence: 'high',
      reason: '/init selected project_bootstrap to create or refresh TMS.md',
    },
    // CMD mode never populates useProjectStore.currentProject; without this,
    // the tool executor's getProjectRoot falls back to that store and every
    // file tool fails with "No project is open." See agentRunner.ts:179.
    cmdOnlyMode: mode === 'terminal',
  })
}

function formatExtraContext(args: string): string {
  const trimmed = args.trim()
  if (!trimmed) return ''
  return `\n\nDeveloper-provided /init context:\n${trimmed.slice(0, 2000)}`
}

export function buildInitPrompt(projectPath: string, existingTms: string | null, args = ''): string {
  const extraContext = formatExtraContext(args)

  if (existingTms !== null) {
    return `Refresh the project's TM Code memory file: ${projectPath}/TMS.md.

TMS.md is loaded into future TM Code sessions, so keep it concise: include only what the agent would likely get wrong without this file. Do not turn it into a file-by-file inventory.
${extraContext}

Phase 1 — focused survey:
- Read the existing TMS.md first with Read.
- Search/list before reading: use Glob, LS, and Grep to locate manifests, entrypoints, config, CI, and existing AI instructions.
- Read only focused key files: package.json/workspace manifests, README, build/test config, AGENTS.md/CLAUDE.md/.cursor rules if present, and app entrypoints.
- Do not use execute_command for source inspection. Use Read/Grep/LS/Glob.
- Avoid mass-reading the repository. For large files, use Read offset/limit.

Phase 2 — ask only for gaps:
- Use ask_user_question only for non-obvious repo practices the code cannot answer: unusual commands, deployment gotchas, required env setup, branch/release conventions, or local workflow quirks.
- Do not ask about facts already visible in manifests, README, or existing instructions.

Phase 3 — update TMS.md:
- Preserve human-authored information from the existing TMS.md. If it has legacy "Memory", "Decisions", "Pending Tasks", or "Custom Instructions" sections, keep their substance under the closest required section or leave them as additional sections after the required structure.
- Remove stale generated detail when current files contradict it.
- Do not include generic coding advice, obvious language defaults, or long tutorials.
- Do not list every component/file. Summarize only stable, operationally useful structure and patterns.
- Record uncertainty in "Pending Confirmation" instead of guessing.

Required TMS.md structure:
\`\`\`markdown
# TMS.md

This file provides guidance to TM Code when working in this repository.

## Overview
<1-3 bullets: what this project is and what matters operationally>

## Stack
<languages, frameworks, package managers, runtime/build systems>

## Commands
<install/dev/build/test/lint/deploy commands; write "not configured" when absent>

## Structure
<only key directories and their purpose; no exhaustive tree>

## EntryPoints
<main app/server/worker/native entrypoints and why they matter>

## Project Patterns
<repo-specific conventions, architecture decisions, import/style patterns that differ from defaults>

## Agent Rules
<specific rules TM Code should follow in this repo; include preserved custom instructions here>

## Confirmed
<facts verified from files; cite source paths inline>

## Inferred
<reasonable inferences, clearly marked as inferred>

## Pending Confirmation
<questions or assumptions not provable from code>

## lastGeneratedAt
<ISO timestamp>

## sourceFilesUsed
- <relative path>
\`\`\`

Write the updated file with write_file. Do not echo the TMS.md body in chat; briefly state what changed and which source files were used.`
  }

  return `Set up a minimal TM Code project memory file at ${projectPath}/TMS.md.

TMS.md is loaded into future TM Code sessions, so keep it concise: include only what the agent would likely get wrong without this file. Do not create a broad report and do not list every file.
${extraContext}

Phase 1 — focused survey:
- Search/list before reading: use Glob, LS, and Grep to locate manifests, entrypoints, config, CI, and existing AI instructions.
- Read only focused key files: package.json/workspace manifests, README, build/test config, AGENTS.md/CLAUDE.md/.cursor rules if present, and app entrypoints.
- Do not use execute_command for source inspection. Use Read/Grep/LS/Glob.
- Avoid mass-reading the repository. For large files, use Read offset/limit.
- Note what you could not determine from files alone.

Phase 2 — ask only for gaps:
- Use ask_user_question only for non-obvious repo practices the code cannot answer: unusual commands, deployment gotchas, required env setup, branch/release conventions, or local workflow quirks.
- Skip questions whose answers are visible in manifests, README, or existing instructions.

Phase 3 — write TMS.md:
- Be accurate: separate verified facts from inferences.
- Do not include generic development practices, obvious language defaults, long tutorials, or exhaustive file inventories.
- Record uncertainty in "Pending Confirmation" instead of guessing.
- Keep sourceFilesUsed to files actually read, relative to the project root.

Required TMS.md structure:
\`\`\`markdown
# TMS.md

This file provides guidance to TM Code when working in this repository.

## Overview
<1-3 bullets: what this project is and what matters operationally>

## Stack
<languages, frameworks, package managers, runtime/build systems>

## Commands
<install/dev/build/test/lint/deploy commands; write "not configured" when absent>

## Structure
<only key directories and their purpose; no exhaustive tree>

## EntryPoints
<main app/server/worker/native entrypoints and why they matter>

## Project Patterns
<repo-specific conventions, architecture decisions, import/style patterns that differ from defaults>

## Agent Rules
<specific rules TM Code should follow in this repo>

## Confirmed
<facts verified from files; cite source paths inline>

## Inferred
<reasonable inferences, clearly marked as inferred>

## Pending Confirmation
<questions or assumptions not provable from code>

## lastGeneratedAt
<ISO timestamp>

## sourceFilesUsed
- <relative path>
\`\`\`

Write the file with write_file. Do not echo the TMS.md body in chat; briefly state what was analyzed and which source files were used.`
}
