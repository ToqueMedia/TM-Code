import { invoke } from '@/utils/invokeMetrics'
import { t } from '../../../i18n'
import { useChatStore } from '../../../stores/chatStore'
import { runAgentWithCallbacks } from '../agentRunner'

export async function executeInit(
  args: string,
  projectPath: string,
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
  })
}

function formatExtraContext(args: string): string {
  const trimmed = args.trim()
  if (!trimmed) return ''
  return `\n\nDeveloper-provided /init context:\n${trimmed.slice(0, 2000)}`
}

/**
 * Fase de MINERAÇÃO DE DOUTRINA (task F2-13, 2026-08-03).
 *
 * O /init original produzia mapas de ESTRUTURA (stack, comandos, pastas) e
 * ficava aquém do TMS escrito à mão para o próprio exodus-ide — cuja
 * diferença não era detalhe, era DOUTRINA: quem é dono de quê entre
 * componentes, o que nunca fazer e porquê, as armadilhas operacionais que
 * um humano da equipa sabe de cor. Medido na sessão momenu-fact de 07-30:
 * um TMS estrutural-mas-raso custou 12 de 20 tool calls a redescobrir o
 * que o mapa devia ter dito. Estes blocos são partilhados pelas DUAS
 * variantes do prompt (criar/refrescar) para nunca divergirem.
 */
const DOCTRINE_MINING_PHASE = `Phase 1b — doctrine mining (what a teammate knows by heart):
Structure is not enough — the valuable part of this file is DOCTRINE. Mine these sources:
 - CI workflows (.github/workflows, pipelines) and release/deploy scripts: what runs automatically, and what a developer must NEVER trigger by accident (e.g. "releases are cut by tag — never push a tag casually"). Turn each into a rule WITH its consequence.
 - OWNERSHIP boundaries in multi-component repos (workspaces, services, workers, native shells): which component OWNS which responsibility, and what breaks when the boundary is violated (e.g. "billing is counted ONLY in service X — client-side counting is a regression"). One line per boundary.
 - Long "why" comments in core modules and any incident/postmortem notes in docs: they encode past pain. Extract the RULE they protect, not the story.
 - Config traps: env files with load-order quirks, generated paths that must not be edited, permission/allow-lists that need updating alongside code (e.g. "every new native command must also be added to <allowlist file> or it is blocked").
Doctrine entries state the rule AND the consequence of breaking it — a rule without its "why" gets deleted by the next refactor.`

const SELF_CHECK = `Self-check before writing (the quality bar):
Could a FRESH agent, reading ONLY this TMS.md, correctly answer —
 1. "Who owns <each major responsibility>?" for every component boundary in the repo;
 2. "What must NEVER be done here, and what happens if I do?";
 3. "Which command validates a change of each major type (frontend, backend, native, CI)?"
If the repo contains an answer that your draft omits, mine deeper before writing. If the repo genuinely does not answer it, record it in "Pending Confirmation" — an honest gap beats a confident blank.`

const TMS_STRUCTURE = `Required TMS.md structure:
\`\`\`markdown
# TMS.md

This file provides guidance to TM Code when working in this repository.

## Overview
<1-3 bullets: what this project is and what matters operationally; if a canonical architecture doc exists, point to it as authoritative>

## Stack
<languages, frameworks, package managers, runtime/build systems>

## Commands
<install/dev/build/test/lint/deploy commands; write "not configured" when absent; include per-command gotchas inline (e.g. pipes masking exit codes, watch modes)>

## Structure
<only key directories and their purpose; no exhaustive tree>

## EntryPoints
<main app/server/worker/native entrypoints and why they matter>

## Project Patterns
<repo-specific conventions AND ownership doctrine: for multi-component repos, one line per boundary — which component owns which responsibility, and the consequence of violating it>

## Agent Rules
<specific rules TM Code should follow in this repo, INCLUDING the never-dos mined from CI/scripts/docs, each with its consequence; include preserved custom instructions here>

## Confirmed
<facts verified from files — doctrine facts included; cite source paths inline>

## Inferred
<reasonable inferences, clearly marked as inferred>

## Pending Confirmation
<questions or assumptions not provable from code>

## lastGeneratedAt
<ISO timestamp>

## sourceFilesUsed
- <relative path>
\`\`\``

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

${DOCTRINE_MINING_PHASE}

Phase 2 — ask only for gaps:
- Use ask_user_question only for non-obvious repo practices the code cannot answer: unusual commands, deployment gotchas, required env setup, branch/release conventions, or local workflow quirks.
- Do not ask about facts already visible in manifests, README, or existing instructions.

Phase 3 — update TMS.md:
- Preserve human-authored information from the existing TMS.md. If it has legacy "Memory", "Decisions", "Pending Tasks", or "Custom Instructions" sections, keep their substance under the closest required section or leave them as additional sections after the required structure.
- Remove stale generated detail when current files contradict it.
- Do not include generic coding advice, obvious language defaults, or long tutorials.
- Do not list every component/file. Summarize only stable, operationally useful structure and patterns.
- Record uncertainty in "Pending Confirmation" instead of guessing.

${SELF_CHECK}

${TMS_STRUCTURE}

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

${DOCTRINE_MINING_PHASE}

Phase 2 — ask only for gaps:
- Use ask_user_question only for non-obvious repo practices the code cannot answer: unusual commands, deployment gotchas, required env setup, branch/release conventions, or local workflow quirks.
- Skip questions whose answers are visible in manifests, README, or existing instructions.

Phase 3 — write TMS.md:
- Be accurate: separate verified facts from inferences.
- Do not include generic development practices, obvious language defaults, long tutorials, or exhaustive file inventories.
- Record uncertainty in "Pending Confirmation" instead of guessing.
- Keep sourceFilesUsed to files actually read, relative to the project root.

${SELF_CHECK}

${TMS_STRUCTURE}

Write the file with write_file. Do not echo the TMS.md body in chat; briefly state what was analyzed and which source files were used.`
}
