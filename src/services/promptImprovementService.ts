import FirebaseAuthService from './auth/firebaseAuth'
import { tauriFetch } from './tauriFetch'
import { resolveAIWorkerUrl } from '../utils/devUrls'

const PROMPT_IMPROVER_SYSTEM = `Rewrite user prompts for coding LLM agents.

Return ONLY the improved prompt text. No markdown fences, no preface, no commentary.

Use a compact, high-signal structure that models reliably follow:
Objective, Context, Constraints, Acceptance criteria, and Output expectations.

Rules:
- Do not invent product requirements, files, credentials, dates, or technologies.
- Keep the user's language.
- Keep it short and directly actionable.
- If the original prompt is already clear, make only minimal structural improvements.`

export async function improveUserPrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim()
  if (!trimmed) return ''

  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) throw new Error('Not authenticated')

  const response = await tauriFetch(`${resolveAIWorkerUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Request-Type': 'utility',
    },
    timeoutSecs: 45,
    body: JSON.stringify({
      model: 'tm-active-model',
      stream: false,
      temperature: 0.1,
      max_tokens: 350,
      messages: [
        { role: 'system', content: PROMPT_IMPROVER_SYSTEM },
        { role: 'user', content: trimmed },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Prompt improvement failed (${response.status}): ${detail.slice(0, 200)}`)
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  return (data.choices?.[0]?.message?.content ?? '').trim()
}
