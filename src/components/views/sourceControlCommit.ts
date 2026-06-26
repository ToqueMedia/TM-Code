export const TM_CODE_COMMIT_SIGNATURE = 'Co-Authored-By: TM Code <tm.code@toquemedia.net>'

// The signature is invisible to the user and appended at commit time.
export function ensureTmCodeCommitSignature(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return ''
  if (/^Co-Authored-By:\s*TM Code\s*</im.test(trimmed)) return trimmed
  return `${trimmed}\n\n${TM_CODE_COMMIT_SIGNATURE}`
}

/** Strip any TM Code trailer the AI may still emit, so it never reaches the textarea. */
export function stripTmCodeCommitSignature(message: string): string {
  return message.replace(/\n*^Co-Authored-By:\s*TM Code\s*<[^>]*>\s*$/gim, '').trim()
}

/**
 * Strip chain-of-thought from the AI message. The commit-message call is
 * non-streaming, so reasoning models can emit `<think>...</think>` inline.
 */
export function stripReasoningBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const lastClose = out.toLowerCase().lastIndexOf('</think>')
  if (lastClose !== -1) out = out.slice(lastClose + '</think>'.length)
  return out.replace(/<\/?think>/gi, '').trim()
}

export function cleanGeneratedCommitMessage(message: string): string {
  const cleaned = stripReasoningBlocks(message)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(commit message:?\s*)/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
  return stripTmCodeCommitSignature(cleaned)
}
