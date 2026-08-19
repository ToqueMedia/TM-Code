import { languageDirective } from './_languageInstruction'

export function buildDebugPrompt(symptom: string, projectPath: string): string {
  return `Investigate this symptom before editing.

${languageDirective()}

Symptom: ${symptom}
Project: ${projectPath}

Start from evidence — \`read_dev_server_logs\`, the stack trace, or the failing test. If this is a runtime bug and no server is up, \`start_dev_server\`, wait for "Server ready", and reproduce so the logs capture the symptom. Read the failing path before you edit. Apply the smallest fix; no drive-by refactors. Re-run the scenario and say if you could not verify.

Keep prose short. Cause, files changed, verification result.`
}
