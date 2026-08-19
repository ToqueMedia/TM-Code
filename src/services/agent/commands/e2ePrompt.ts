import { languageDirective } from './_languageInstruction'

export function buildE2EPrompt(request: string, projectPath: string): string {
  return `Drive the live preview to check: ${request}

${languageDirective()}

Project: ${projectPath}

Confirm the dev-server URL via \`read_dev_server_logs\` (start it if needed). Read only what you need for routes and selectors. Navigate, take \`mcp__browser__browser_snapshot\`, and exercise the requested flow — the happy path plus one cheap empty/error case if it is obvious. Screenshots (\`mcp__browser__browser_take_screenshot\`) only when the bug is visual.

Do not write spec files or edit source. Do not use real credentials unless the user provided them. Stop at auth walls. Ask before destructive actions or any URL that is not clearly localhost/staging. After roughly twenty browser actions, ask whether to continue. Two failed retries on the same step — move on.

Report bugs with severity, a minimal repro, and file:line. Say what you covered and what you skipped.`
}
