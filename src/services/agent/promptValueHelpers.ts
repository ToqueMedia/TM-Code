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

import type { Attachment, ContentPart, ConversationMessage } from '../../types/chat'
import type { ContentBlock, PromptValue } from '../../types/messageQueueTypes'
import type { OpenAIContentPart } from './agentService'

/**
 * Hard cap on the total bytes of image data URIs in a single multimodal
 * payload. 10 MB matches the comfort zone for most vision providers
 * (Qwen and Kimi reject larger; OpenAI's vision endpoint also has a
 * per-message limit around this range). When exceeded, buildContentParts
 * returns null so the caller falls back to the text path.
 */
export const MAX_MULTIMODAL_PAYLOAD_BYTES = 10 * 1024 * 1024

// === Resolver function shapes ===
//
// The helpers take injected resolvers so unit tests can pass mocks
// without reaching into the Tauri IPC layer. Production call sites
// wire the real implementations from attachmentService.
//
// All three resolvers are bundled into a single PromptResolvers object
// passed to the helpers — keeps call sites immune to argument
// reordering and makes adding a new resolver in the future a typed
// change at every site.

export type MentionResolver = (text: string, projectPath: string) => Promise<string>
export type AttachmentXmlResolver = (attachments: Attachment[]) => Promise<string>
export type ImageDataUriResolver = (attachment: Attachment) => Promise<string | null>

export type PromptResolvers = {
  resolveMentions: MentionResolver
  resolveAttachmentXml: AttachmentXmlResolver
  resolveImageDataUri: ImageDataUriResolver
}

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
  resolvers: PromptResolvers,
): Promise<string> {
  const { resolveMentions, resolveAttachmentXml } = resolvers

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
  resolvers: PromptResolvers,
): Promise<OpenAIContentPart[] | null> {
  const { resolveMentions, resolveAttachmentXml, resolveImageDataUri } = resolvers

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

  // Payload size guard. Vision providers and the backend proxy have
  // request body limits; an over-budget multimodal payload typically
  // returns an opaque 413 or upstream timeout. Cap the total size of
  // image_url data URIs and downgrade to the text path if exceeded —
  // the user gets a working (text-only) request instead of a confusing
  // failure.
  const totalImageBytes = parts.reduce(
    (sum, p) => sum + (p.type === 'image_url' ? p.image_url.url.length : 0),
    0,
  )
  if (totalImageBytes > MAX_MULTIMODAL_PAYLOAD_BYTES) {
    return null
  }

  // Vision APIs reject image-only user messages in some providers AND
  // reject whitespace-only text parts. Check that there's at least one
  // text part with non-trivial content; otherwise prepend a fallback.
  const hasNonEmptyText = parts.some(
    p => p.type === 'text' && p.text.trim().length > 0,
  )
  if (!hasNonEmptyText) {
    parts.unshift({ type: 'text', text: 'Analyze the attached image(s).' })
  }

  return parts
}

// === Content flattening (for logging / fallback summarisation) ===

/**
 * Flatten an OpenAI-compatible content field to a string for code that
 * only needs the text (logging, mechanical fallback summarisation).
 * Image parts become `[image]` markers; text parts concatenate
 * newline-joined. Null/undefined returns empty string.
 *
 * Used by agentService.mechanicalFallback and summarizeToolResult
 * to safely extract text from messages whose content can be either
 * shape after the multimodal refactor.
 */
export function contentAsText(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map(part => (part.type === 'text' ? part.text : '[image]'))
    .join('\n')
}

// === ConversationHistory downgrade ===

/**
 * Flatten any `content: ContentPart[]` in a ConversationMessage[] into
 * plain string content. Used at the boundary into the agent loop when
 * the active model does not support vision but the history contains
 * messages from a previous (vision-capable) session.
 *
 * Image parts become a `[image: <name>]` placeholder so the model at
 * least knows an image was present in the history. Text parts join
 * with newline.
 *
 * The original history is not mutated — a fresh array is returned.
 */
export function downgradeHistoryToText(
  history: readonly ConversationMessage[],
): ConversationMessage[] {
  return history.map(msg => {
    if (msg.content == null || typeof msg.content === 'string') {
      return msg as ConversationMessage
    }
    const parts = msg.content as ContentPart[]
    const text = parts
      .map(p => (p.type === 'text' ? p.text : '[image attached — switch to a multimodal model to view]'))
      .join('\n')
    return { ...msg, content: text }
  })
}
