/**
 * Compact prompt templates for summarization side-calls.
 *
 * Ported from claude-vaz services/compact/prompt.ts — adapted for TM Code
 * (no Bun feature flags, no proactive mode).
 */

import { stripInlineReasoning } from '../completionText'

// Aggressive no-tools preamble
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your detailed summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.
`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * Strip the <analysis> drafting scratchpad and format the <summary> block.
 *
 * Failure-mode guard: if the summarizer omitted/malformed the <summary>
 * wrapper, the old code stripped <analysis> unconditionally and returned the
 * leftovers — often near-empty — which then REPLACED the whole conversation
 * (a silent total context loss; pollution audit, 2026-06-12). When no
 * <summary> block parses, fall back to the full raw response (minus a
 * correctly-closed analysis block): a verbose summary beats an empty one.
 */
export function formatCompactSummary(summaryRaw: string): string {
  // O sumário de compactação é o pior sítio para deixar passar raciocínio cru:
  // ele volta para o HISTÓRICO como a memória da conversa toda, e um bloco
  // <think> lá dentro contamina todos os turnos seguintes. O strip só existia
  // no gerador de mensagens de commit (auditoria 2026-07-28) — e os modelos
  // de sumarização vêm da config KV, portanto não se sabe à partida se metem
  // o raciocínio inline no content.
  const summary = stripInlineReasoning(summaryRaw)
  const summaryMatch = summary.match(/<summary>([\s\S]*?)<\/summary>/)

  if (!summaryMatch) {
    // No parseable <summary>: keep everything the model wrote. Only strip
    // <analysis> if it closed properly — an unclosed tag means the content
    // after it is probably the real summary text.
    const fallback = summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim()
    return (fallback.length >= 80 ? fallback : summary.trim())
      .replace(/\n\n+/g, '\n\n')
  }

  let formatted = summary

  // Strip analysis sections (all of them — the model may emit several)
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')

  const content = summaryMatch[1] || ''
  formatted = formatted.replace(
    /<summary>[\s\S]*?<\/summary>/,
    `Summary:\n${content.trim()}`,
  )

  // Clean up extra whitespace between sections
  formatted = formatted.replace(/\n\n+/g, '\n\n')

  return formatted.trim()
}

/**
 * Build the user message that replaces the compacted conversation.
 *
 * `transcriptPath` aponta para o arquivo JSONL das mensagens que o sumário
 * substituiu (ver compactTranscriptArchive). É a diferença entre "isto foi
 * resumido" e "isto foi resumido E aqui está o original": o sumário é lossy por
 * definição, e sem o caminho o modelo não tem como recuperar a citação literal
 * do developer, a mensagem de erro exata ou o snippet que o resumo colapsou.
 * O claude-vaz passa o transcript da sessão pelo mesmo motivo
 * (compact.ts → getCompactUserSummaryMessage(summary, …, transcriptPath)).
 */
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  recentTurnsPreserved?: boolean,
  transcriptPath?: string | null,
): string {
  const formattedSummary = formatCompactSummary(summary)

  // Quando os turnos recentes sobrevivem à compactação, dizê-lo explicitamente
  // evita o pior efeito colateral do sumário: o modelo tratar o resumo como a
  // TOTALIDADE do que sabe e voltar a ler ficheiros cujos resultados estão logo
  // a seguir, intactos, nas mensagens preservadas.
  const parts: string[] = [
    recentTurnsPreserved
      ? `This session is being continued from a previous conversation that ran out of context. The summary below covers the EARLIER portion only — the most recent turns follow it verbatim, including their tool results. Trust those directly; do not re-read what they already show.

${formattedSummary}`
      : `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`,
  ]

  if (transcriptPath) {
    parts.push(
      `If you need specific details from before the compaction (exact code snippets, verbatim error messages, the developer's literal wording), the raw pre-compaction transcript was saved to:
${transcriptPath}

It is a JSONL file — one message per line, with tool_call and tool_result blocks intact. Use search_files on it for the symbol or phrase you need; do not page through the whole file, and do not mention the archive to the developer unless you actually read it.`,
    )
  }

  if (suppressFollowUpQuestions) {
    parts.push(
      `Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`,
    )
  }

  return parts.join('\n\n')
}
