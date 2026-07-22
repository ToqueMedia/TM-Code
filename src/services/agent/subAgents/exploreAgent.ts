/**
 * Explore agent — read-only codebase search.
 *
 * Port of claude-vaz's exploreAgent.ts with TM Code tool names.
 * Tools: read_file, list_directory, search_files, glob, read_large_result.
 */

import type { SubAgentDefinition, SubAgentParentContext } from './types'
import { READ_FILE, READ_AROUND, LIST_DIRECTORY, SEARCH_FILES, GLOB, READ_LARGE_RESULT } from '../toolNames'

export const EXPLORE_AGENT: SubAgentDefinition = {
  agentType: 'Explore',
  whenToUse: 'Find usages, definitions, file patterns, or code structure in the project',
  tools: [READ_FILE, READ_AROUND, LIST_DIRECTORY, SEARCH_FILES, GLOB, READ_LARGE_RESULT],
  maxTurns: 15,
  maxWallClockMs: 3 * 60 * 1000,
  color: '#3fb8af',
  omitProjectContext: true,

  getSystemPrompt: (ctx: SubAgentParentContext) => {
    const cwdLine = ctx.cmdOnlyMode
      ? '\n\nCWD is the working directory for tool calls.'
      : ''

    const depthGuide = ctx.thoroughness === 'quick'
      ? 'Stop at the first match. Return immediately when you find what you need.'
      : ctx.thoroughness === 'thorough'
        ? 'Be comprehensive. Check multiple naming conventions, related files, test files, and edge cases. Report all findings.'
        : 'Check 2-3 relevant locations before concluding. Balance speed with coverage.'

    return `You are a fast codebase exploration agent inside TM Code. Your job is to find information in the project and return a clear, concise answer.

## Search Depth
${depthGuide}

## Capabilities
- **${SEARCH_FILES}** — ripgrep search across the codebase. Use for finding usages, references, patterns.
- **${GLOB}** — file pattern matching. Use for finding files by name/extension.
- **${READ_FILE}** — read a file's contents. Use after search_files/glob to read the relevant code.
- **${READ_AROUND}** — read a bounded window around a search match line.
- **${LIST_DIRECTORY}** — list files in a directory. Use for understanding project structure.
- **${READ_LARGE_RESULT}** — page through large search/read outputs when a result was truncated.
## Rules
- You are READ-ONLY. You cannot write, edit, create, or delete files.
- Be specific. Name the file path and line number when reporting findings.
- Quote relevant code snippets when answering.
- If you don't find what you're looking for, say so explicitly — don't guess.
- Return your answer as a clear text summary. Do not use markdown headers or excessive formatting.

## Completion
When you have found the answer (or determined it doesn't exist), return your summary and stop. Do not continue searching after you have a sufficient answer.

Project root: ${ctx.workingPath}${cwdLine}
Language: respond in ${ctx.agentLanguage}`
  },
}
