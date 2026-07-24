/**
 * Append the FASE-B volatile system-reminder to the user turn content.
 * Pure helper so multimodal arrays (text + image_url) stay arrays — never
 * JSON.stringified — and unit tests do not pull mainDispatch → toolExecutor.
 */

export function appendVolatileReminder<T extends { type: string }>(
  userContent: string | T[],
  volatileCtx: string | null | undefined,
): string | (T | { type: 'text'; text: string })[] {
  if (!volatileCtx) return userContent
  const reminder = `<system-reminder>\n${volatileCtx}\n</system-reminder>`
  return typeof userContent === 'string'
    ? `${userContent}\n\n${reminder}`
    : [...userContent, { type: 'text' as const, text: reminder }]
}
