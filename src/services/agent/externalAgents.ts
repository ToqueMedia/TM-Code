// Discovery of OTHER AI coding agents' local session history for the current
// project, so the TM Code agent can pick up where a different tool (Claude Code,
// Qwen Code, Aider, …) left off. We only surface WHERE the transcripts are (agent
// + directory + file count) in the system prompt; the agent reads the actual
// content on demand with read_file/list_directory, which is permission-gated the
// first time it touches a path outside the project. So discovery is metadata-only
// (existence + count), never transcript content.
//
// Most agents key their per-project history by an ENCODED absolute cwd:
//   Claude Code / OpenClaude / Qwen: `/Users/x/dev/proj` → `-Users-x-dev-proj`
//   (path separators and `.`/`_` collapse to `-`). Aider keeps its transcript
//   inside the repo itself (`.aider.chat.history.md`), so it's already in scope.
//
// Best-effort throughout: a missing dir / unreadable path just yields nothing.

import { invoke } from '@/utils/invokeMetrics'

export interface ExternalAgentSessions {
  id: string
  label: string
  /** Human-readable location shown to the agent (with `~` or repo-relative). */
  location: string
  /** Absolute path the agent should list/read (for out-of-project ones). */
  absolutePath: string
  fileCount: number
  format: 'jsonl' | 'markdown'
  /** One-line hint on the on-disk format. */
  formatHint: string
}

/** `/Users/x/dev/proj.foo` → `-Users-x-dev-proj-foo` (Claude/Qwen convention). */
function dashEncode(p: string): string {
  return p.replace(/\\/g, '/').replace(/[/._]/g, '-')
}

interface AgentDef {
  id: string
  label: string
  /** Directory (absolute) to glob + the glob pattern + display path. */
  resolve: (home: string, projectPath: string) => { dir: string; pattern: string; display: string }
  formatHint: string
}

/** Agents whose per-project transcripts are readable plain-text JSONL, keyed by
 *  the dash-encoded project path. (Codex nests by date, Cursor uses SQLite,
 *  Gemini keys by basename — added later behind a reader; omitted for now so we
 *  never point the agent at something it can't actually read.) */
const JSONL_AGENTS: AgentDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    resolve: (home, p) => ({
      dir: `${home}/.claude/projects/${dashEncode(p)}`,
      pattern: '*.jsonl',
      display: `~/.claude/projects/${dashEncode(p)}/`,
    }),
    formatHint: 'JSONL — one message per line (fields: type, message.role, message.content, timestamp).',
  },
  {
    id: 'openclaude',
    label: 'OpenClaude',
    resolve: (home, p) => ({
      dir: `${home}/.openclaude/projects/${dashEncode(p)}`,
      pattern: '*.jsonl',
      display: `~/.openclaude/projects/${dashEncode(p)}/`,
    }),
    formatHint: 'JSONL — one message per line (Claude-Code-compatible layout).',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    resolve: (home, p) => ({
      dir: `${home}/.qwen/projects/${dashEncode(p)}/chats`,
      pattern: '*.jsonl',
      display: `~/.qwen/projects/${dashEncode(p)}/chats/`,
    }),
    formatHint: 'JSONL — one message per line.',
  },
]

/**
 * Discover other agents' session stores for `projectPath`. Metadata only
 * (existence + file count). Best-effort: any failure yields fewer entries, never
 * throws. Returns [] when nothing is found (the caller omits the prompt section).
 */
export async function discoverExternalAgentSessions(
  projectPath: string,
): Promise<ExternalAgentSessions[]> {
  if (!projectPath) return []

  let home = ''
  try {
    home = await invoke<string>('get_home_directory')
  } catch {
    return []
  }

  const found: ExternalAgentSessions[] = []

  await Promise.all(
    JSONL_AGENTS.map(async (agent) => {
      const { dir, pattern, display } = agent.resolve(home, projectPath)
      try {
        const files = await invoke<string[]>('glob_files', { pattern, directory: dir })
        if (files.length > 0) {
          found.push({
            id: agent.id,
            label: agent.label,
            location: display,
            absolutePath: dir,
            fileCount: files.length,
            format: 'jsonl',
            formatHint: agent.formatHint,
          })
        }
      } catch {
        /* directory absent / unreadable — this agent simply has no history here */
      }
    }),
  )

  // Aider keeps its transcript inside the repo, so it's already in project scope.
  try {
    const aiderPath = `${projectPath.replace(/[\\/]+$/, '')}/.aider.chat.history.md`
    if (await invoke<boolean>('path_exists', { path: aiderPath })) {
      found.push({
        id: 'aider',
        label: 'Aider',
        location: '.aider.chat.history.md (project root)',
        absolutePath: aiderPath,
        fileCount: 1,
        format: 'markdown',
        formatHint: 'Markdown transcript — read directly.',
      })
    }
  } catch {
    /* ignore */
  }

  // Stable order for prompt-cache friendliness (discovery runs Promise.all).
  found.sort((a, b) => a.id.localeCompare(b.id))
  return found
}

/**
 * Render the system-prompt block. Returns null when nothing was found so the
 * section is omitted (zero token cost on the common path). Points the agent at
 * the folders and tells it HOW to read them — it does the actual reading with
 * its own tools (permission-gated for out-of-project paths).
 */
export function buildExternalAgentSessionsSection(
  sessions: ExternalAgentSessions[],
): string | null {
  if (sessions.length === 0) return null

  const lines = sessions.map(
    (s) => `- ${s.label}: ${s.fileCount} session file(s) in ${s.location} — ${s.formatHint}`,
  )

  return `# Other AI agents' sessions (this project)

Another coding agent has local session history for THIS project. You can READ those
transcripts to CONTINUE its work — but ONLY when the user asks you to pick up / resume
prior work, or when it's clearly relevant. Do not read them unprompted.

To resume: use list_directory on the folder, pick the most recently modified file,
read_file it, then briefly summarize the prior goal + current state before acting.
Reading a path OUTSIDE this project asks the user for access once — that's expected.

${lines.join('\n')}`
}
