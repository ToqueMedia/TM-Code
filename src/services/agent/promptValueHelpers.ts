/**
 * PromptValue boundary helpers — translate between the queue's
 * `PromptValue` representation and the two consumer shapes the agent
 * service needs:
 *
 *  - **Chat bubble display** (`extractDisplayFromValue`) — flatten a
 *    PromptValue into `{text, attachments}` so the existing
 *    `addUserMessage` API keeps working.
 *  - **Text-only model input** (`buildAugmentedPrompt`) — walk the
 *    value in order producing a single string with per-attachment XML
 *    markers inline. Used by models flagged `supportsAttachments: false`.
 *  - **Multimodal model input** (`buildContentParts`) — walk the value
 *    in order producing an OpenAI-compatible content parts array with
 *    real `image_url` parts. Used by models flagged
 *    `supportsAttachments: true`.
 *
 * Extracted from usePromptBar so these are unit-testable without a
 * React renderer.
 */

import type { Attachment } from '../../types/chat'
import type { ContentBlock, PromptValue } from '../../types/messageQueueTypes'
import type { OpenAIContentPart } from './agentService'

// === Resolver function shapes ===
//
// The helpers take injected resolvers so unit tests can pass mocks
// without reaching into the Tauri IPC layer. Production call sites
// wire the real implementations from attachmentService.

export type MentionResolver = (text: string, projectPath: string) => Promise<string>
export type AttachmentXmlResolver = (attachments: Attachment[]) => Promise<string>
export type ImageDataUriResolver = (attachment: Attachment) => Promise<string | null>

// === Display extraction ===

/**
 * Extract `(text, attachments)` for chat bubble display from a
 * PromptValue. Strings pass through unchanged. Block arrays are
 * flattened: text blocks join with newline, attachment blocks collect
 * into a list.
 */
export function extractDisplayFromValue(value: PromptValue): { text: string; attachments: Attachment[] } {
  if (typeof value === 'string') {
    return { text: value, attachments: [] }
  }
  const texts: string[] = []
  const attachments: Attachment[] = []
  for (const block of value) {
    if (block.type === 'text') {
      if (block.text.length > 0) texts.push(block.text)
    } else {
      attachments.push(block.attachment)
    }
  }
  return { text: texts.join('\n'), attachments }
}

// === Augmented text prompt (text-only models) ===

/**
 * Walk a PromptValue in order, producing text + per-attachment XML
 * markers inline. Used by models without vision support so the model
 * sees the placeholder sequence where the user actually typed it.
 */
export async function buildAugmentedPrompt(
  value: PromptValue,
  projectPath: string,
  resolveMentions: MentionResolver,
  resolveAttachmentXml: AttachmentXmlResolver,
): Promise<string> {
  if (typeof value === 'string') {
    let augmented = value || 'Analyze the attached files.'
    const mentionContext = await resolveMentions(augmented, projectPath)
    if (mentionContext) augmented += mentionContext
    return augmented
  }

  const parts: string[] = []
  for (const block of value) {
    if (block.type === 'text') {
      let text = block.text
      const mentionContext = await resolveMentions(text, projectPath)
      if (mentionContext) text += mentionContext
      if (text.length > 0) parts.push(text)
    } else {
      const xml = await resolveAttachmentXml([block.attachment])
      if (xml) parts.push(xml.trim())
    }
  }
  if (parts.length === 0) return 'Analyze the attached files.'
  return parts.join('\n')
}

// === Multimodal content parts (vision models) ===

/**
 * Walk a PromptValue in order, producing an OpenAI-compatible content
 * parts array. Image attachments become `image_url` parts (via the
 * injected `resolveImageDataUri`); non-image attachments fall back to
 * text parts with the same XML markers as the text-only path.
 *
 * Returns `null` if no image parts were produced — the caller should
 * fall back to `buildAugmentedPrompt` in that case (no reason to pay
 * the overhead of the array shape for a purely text message).
 */
export async function buildContentParts(
  value: PromptValue,
  projectPath: string,
  resolveMentions: MentionResolver,
  resolveAttachmentXml: AttachmentXmlResolver,
  resolveImageDataUri: ImageDataUriResolver,
): Promise<OpenAIContentPart[] | null> {
  const blocks: ContentBlock[] = typeof value === 'string'
    ? (value.length > 0 ? [{ type: 'text', text: value }] : [])
    : value

  const parts: OpenAIContentPart[] = []
  let hasImage = false

  for (const block of blocks) {
    if (block.type === 'text') {
      let text = block.text
      const mentionContext = await resolveMentions(text, projectPath)
      if (mentionContext) text += mentionContext
      if (text.length > 0) parts.push({ type: 'text', text })
    } else {
      const att = block.attachment
      if (att.type === 'image') {
        const dataUri = await resolveImageDataUri(att)
        if (dataUri) {
          parts.push({ type: 'image_url', image_url: { url: dataUri } })
          hasImage = true
        } else {
          // Image read failed — fall back to textual placeholder so
          // the model at least knows an image was intended.
          const xml = await resolveAttachmentXml([att])
          if (xml) parts.push({ type: 'text', text: xml.trim() })
        }
      } else {
        // Non-image attachments (files, folders) stay as text XML blocks.
        const xml = await resolveAttachmentXml([att])
        if (xml) parts.push({ type: 'text', text: xml.trim() })
      }
    }
  }

  if (!hasImage) return null

  // Vision APIs reject image-only user messages in some providers —
  // ensure at least one text part.
  if (!parts.some(p => p.type === 'text')) {
    parts.unshift({ type: 'text', text: 'Analyze the attached image(s).' })
  }

  return parts
}
