import type { ConvertedShellReadCommand } from './commandPurpose'
import {
  GLOB,
  GLOB_ALIAS,
  GREP_ALIAS,
  LIST_DIRECTORY,
  LS_ALIAS,
  READ_ALIAS,
  READ_FILE,
  SEARCH_FILES,
} from './toolNames'

function shellReadAlias(toolName: ConvertedShellReadCommand['toolName']): string {
  switch (toolName) {
    case READ_FILE:
      return READ_ALIAS
    case SEARCH_FILES:
      return GREP_ALIAS
    case LIST_DIRECTORY:
      return LS_ALIAS
    case GLOB:
      return GLOB_ALIAS
  }
}

function shellReadAliasInput(converted: ConvertedShellReadCommand): Record<string, unknown> {
  const input = converted.input
  switch (converted.toolName) {
    case READ_FILE:
      return {
        file_path: input.file_path,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }
    case SEARCH_FILES:
      return {
        pattern: input.query,
        path: input.directory ?? '.',
        ...(input.caseSensitive !== undefined ? { caseSensitive: input.caseSensitive } : {}),
        ...(input.useRegex !== undefined ? { useRegex: input.useRegex } : {}),
        ...(input.includePatterns !== undefined ? { includePatterns: input.includePatterns } : {}),
      }
    case LIST_DIRECTORY:
      return {
        path: input.file_path ?? '.',
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
      }
    case GLOB:
      return {
        pattern: input.pattern,
        path: input.directory ?? '.',
      }
  }
}

export function formatShellReadRedirect(command: string, converted: ConvertedShellReadCommand | null): string {
  const base =
    'Shell file inspection through execute_command is disabled. ' +
    `Use ${READ_ALIAS}, ${GREP_ALIAS}, ${LS_ALIAS}, or ${GLOB_ALIAS} for source inspection.`
  if (!converted) {
    return `${base}\n\nThis command was classified as file/code inspection but is ambiguous or compound, so TM Code did not execute it:\n${command}`
  }

  const alias = shellReadAlias(converted.toolName)
  const suggestedInput = shellReadAliasInput(converted)
  return [
    base,
    '',
    'Suggested next tool call:',
    `${alias} ${JSON.stringify(suggestedInput)}`,
    '',
    `Original command was not executed: ${command}`,
  ].join('\n')
}
