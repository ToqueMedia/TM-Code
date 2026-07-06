/**
 * Shared display helpers for compact shell-styled tool calls.
 * Maps raw tool names to suggestive verbs and builds compact subtitles
 * (path, query, command) so the user sees intent at a glance instead
 * of a wall of underscored identifiers.
 */
import { basename as pathBasename, shortenPath as pathShorten } from '@/utils/platform'

export type ToolDisplay = {
  /** Verb shown while the tool is running (present continuous) */
  running: string
  /** Verb shown after the tool completes */
  done: string
  /** Verb shown when the tool fails */
  failed: string
}

const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  read_file: { running: 'Reading', done: 'Read', failed: 'Read failed' },
  read_around: { running: 'Reading nearby lines', done: 'Read nearby lines', failed: 'Nearby read failed' },
  write_file: { running: 'Writing', done: 'Wrote', failed: 'Write failed' },
  create_file: { running: 'Creating', done: 'Created', failed: 'Create failed' },
  edit_file: { running: 'Editing', done: 'Edited', failed: 'Edit failed' },
  delete_file: { running: 'Deleting', done: 'Deleted', failed: 'Delete failed' },
  rename_file: { running: 'Renaming', done: 'Renamed', failed: 'Rename failed' },
  create_directory: { running: 'Creating folder', done: 'Created folder', failed: 'Folder failed' },
  list_directory: { running: 'Listing', done: 'Listed', failed: 'List failed' },
  search_files: { running: 'Searching', done: 'Searched', failed: 'Search failed' },
  glob: { running: 'Matching', done: 'Matched', failed: 'Glob failed' },
  execute_command: { running: 'Running', done: 'Ran', failed: 'Command failed' },
  execute_command_background: { running: 'Starting background command', done: 'Background command started', failed: 'Background command failed' },
  check_background_commands: { running: 'Checking background commands', done: 'Checked background commands', failed: 'Background check failed' },
  start_dev_server: { running: 'Starting dev server', done: 'Dev server started', failed: 'Dev server failed' },
  stop_dev_server: { running: 'Stopping dev server', done: 'Dev server stopped', failed: 'Dev server stop failed' },
  read_dev_server_logs: { running: 'Reading logs', done: 'Logs read', failed: 'Log read failed' },
  read_large_result: { running: 'Reading slice', done: 'Read slice', failed: 'Slice read failed' },
  web_search: { running: 'Searching the web', done: 'Web results', failed: 'Web search failed' },
  web_fetch: { running: 'Fetching', done: 'Fetched', failed: 'Fetch failed' },
  research: { running: 'Researching', done: 'Research done', failed: 'Research failed' },
  spawn_background_agent: { running: 'Spawning agent', done: 'Agent spawned', failed: 'Agent spawn failed' },
  check_background_agents: { running: 'Checking agents', done: 'Checked agents', failed: 'Agent check failed' },
  update_tasks: { running: 'Updating tasks', done: 'Tasks updated', failed: 'Task update failed' },
  verify: { running: 'Verifying', done: 'Verified', failed: 'Verify failed' },
}

export function getToolDisplay(toolName: string): ToolDisplay {
  if (TOOL_DISPLAY[toolName]) return TOOL_DISPLAY[toolName]
  // MCP tools come through as `mcp__<server>__<name>` — show the leaf name.
  if (toolName.startsWith('mcp__')) {
    const leaf = toolName.split('__').slice(2).join('__') || toolName
    const pretty = leaf.replace(/_/g, ' ')
    return { running: pretty, done: pretty, failed: `${pretty} failed` }
  }
  const pretty = toolName.replace(/_/g, ' ')
  return { running: pretty, done: pretty, failed: `${pretty} failed` }
}

/** Pick the most informative single-line subtitle for a tool call. */
export function getToolSubtitle(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  const pick = (k: string): string | null => {
    const v = input[k]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  // File-path style tools
  const path = pick('file_path') || pick('path')
  if (path) {
    if (toolName === 'rename_file') {
      const np = pick('new_path') || pick('newPath')
      return np ? `${shortenPath(path)} → ${shortenPath(np)}` : shortenPath(path)
    }
    return shortenPath(path)
  }
  // Search / glob
  const pattern = pick('pattern') || pick('query')
  if (pattern) return pattern
  // Commands
  const cmd = pick('command')
  if (cmd) return cmd
  // Web
  const url = pick('url')
  if (url) return url
  // Generic — first string-valued entry
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 0) {
      return `${k}=${truncate(v, 80)}`
    }
  }
  return null
}

export function shortenPath(path: string): string {
  // Always keep filename and at most 2 parent folders for context.
  // Cross-platform: handles both `/` and `\` separators.
  return pathShorten(path, 3)
}

export function basename(path: string): string {
  return pathBasename(path)
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
