import { cachedBuildFileTree, cachedReadFile } from './agent/ipcCache'
import { Attachment, AttachmentType } from '../types/chat'
import type { FileTreeNode } from '../types/fileTree'

// 8MB raw: base64 inflates ~1.37×, and the old 5MB ceiling rejected ordinary
// Retina screenshots — the attach then failed silently and the model received
// the "image did not reach you" XML fallback instead of pixels.
// PAIRED with promptValueHelpers MAX_PER_IMAGE_BYTES (base64-side, 12MB):
// that one MUST stay ≥ this × 4/3 — change them together.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_FILE_CHARS = 20_000
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

let idCounter = 0
function nextId(): string {
  return `att_${Date.now()}_${++idCounter}`
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function guessTypeFromExtension(path: string): AttachmentType {
  const name = path.replace(/\\/g, '/').split('/').pop() || ''
  const ext = getExtension(name)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'file'
}

export async function createAttachmentFromPath(path: string): Promise<Attachment> {
  const name = path.replace(/\\/g, '/').split('/').pop() || path

  // Check if path is a directory on disk via lightweight stat()
  let type: AttachmentType
  try {
    const { stat } = await import('@tauri-apps/plugin-fs')
    const info = await stat(path)
    type = info.isDirectory ? 'folder' : guessTypeFromExtension(path)
  } catch {
    type = guessTypeFromExtension(path)
  }

  const attachment: Attachment = {
    id: nextId(),
    type,
    name,
    path,
  }

  // For images, read base64 for thumbnail preview
  if (type === 'image') {
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`)
      }
      const ext = getExtension(name)
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
      attachment.mimeType = mime
      attachment.sizeBytes = bytes.byteLength
      attachment.base64 = `data:${mime};base64,${uint8ToBase64(bytes)}`
    } catch {
      // If reading fails, still attach without preview
    }
  }

  return attachment
}

export async function createImageAttachmentFromClipboard(blob: Blob): Promise<Attachment> {
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`)
  }

  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const mime = blob.type || 'image/png'
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  const base64 = `data:${mime};base64,${uint8ToBase64(bytes)}`

  return {
    id: nextId(),
    type: 'image',
    name: `pasted-image.${ext}`,
    path: '',  // No disk path for pasted images
    mimeType: mime,
    sizeBytes: blob.size,
    base64,
  }
}

// NOTE: @-mention resolution moved to src/services/agent/atMentions.ts
// (claude-vaz parity port, 2026-06). Mentions are no longer inlined as
// <mentioned_files> XML inside the user prompt — they render as synthetic
// read_file / list_directory tool-call context in <system-reminder> blocks,
// with real readFileState bookkeeping. The UI-side mention parser
// (utils/mentionParser.ts) is unchanged — it drives autocomplete only.

/**
 * Image XML when pixels were NOT delivered (no image_url, sidecar failed or
 * never ran). The model MUST be told this delivery failed — otherwise it
 * invents what the screenshot contained.
 *
 * NÃO afirmar "this model is text-only": este fallback dispara por razões
 * transitórias (gate de plano, cap de bytes, falha de leitura) e o modelo
 * PARAFRASEAVA a frase de volta ao utilizador como limitação permanente
 * do produto (visto em produção 2026-06-12, Gemini multimodal a negar a
 * própria visão). O texto diz só a verdade local: ESTA imagem não chegou
 * NESTE pedido.
 */
export const IMAGE_UNDELIVERED_BODY =
  '[An image was attached but the vision pipeline could not deliver pixels or a description with this request. Tell the developer the image did not reach you this time, then offer alternatives: they can describe what they see, attach the file by path, or retry. Do NOT claim that you or this environment cannot process images in general.]'

/**
 * Image XML when a sidecar description WAS delivered. The undelivered body
 * must NOT be used here — the model treated that instruction as overriding
 * the description and told the user the image never arrived (sessão
 * 2026-08-14, pasted-image.png + GLM-5.2 cego + sidecar).
 */
export const IMAGE_DESCRIBED_BODY =
  '[Image attached. A visual description follows in <image_description> — treat that description as what you see. Do not tell the user the image failed to arrive.]'

export type ImageXmlMode = 'undelivered' | 'described'

/**
 * Resolves all attachments into a context string to append to the user prompt.
 *
 * `imageMode: 'described'` is for the sidecar-success path: images become a
 * metadata marker plus a follow-up `<image_description>`. Default
 * `'undelivered'` is the honest fallback when pixels never left the client.
 */
export async function resolveAttachments(
  attachments: Attachment[],
  options?: { imageMode?: ImageXmlMode },
): Promise<string> {
  if (attachments.length === 0) return ''

  const parts = await Promise.all(attachments.map(async (att): Promise<string> => {
    try {
      if (att.type === 'file') {
        const content = await cachedReadFile(att.path)
        const truncated = content.length > MAX_FILE_CHARS
          ? content.slice(0, MAX_FILE_CHARS) + '\n[... truncated]'
          : content
        return `<attached_file path="${att.path}">\n${truncated}\n</attached_file>`
      } else if (att.type === 'folder') {
        // Shallow traversal — only root-level children names are rendered,
        // so maxDepth: 1 avoids deep filesystem walks on large directories.
        const tree = await cachedBuildFileTree<FileTreeNode>({
          rootPath: att.path,
          filter: { showHidden: false, maxDepth: 1 },
        })
        const listing = (tree.children || [])
          .map(c => `${c.type === 'directory' ? '[d] ' : '    '}${c.name}`)
          .join('\n')
        return `<attached_folder path="${att.path}">\n${listing}\n</attached_folder>`
      } else if (att.type === 'image') {
        const size = att.sizeBytes ? `${Math.round(att.sizeBytes / 1024)}KB` : 'unknown size'
        const source = att.path ? `path="${att.path}"` : 'source="clipboard"'
        const body = options?.imageMode === 'described'
          ? IMAGE_DESCRIBED_BODY
          : IMAGE_UNDELIVERED_BODY
        return `<attached_image name="${att.name}" mime="${att.mimeType || 'image/png'}" ${source} size="${size}">\n${body}\n</attached_image>`
      }
      return ''
    } catch {
      return `<attached_file path="${att.path}">\n[Error: could not read file]\n</attached_file>`
    }
  }))

  const filtered = parts.filter(Boolean)
  return filtered.length > 0 ? '\n\n<attachments>\n' + filtered.join('\n') + '\n</attachments>' : ''
}

/** Resolver for the sidecar-success path — images are described, not lost. */
export function resolveDescribedAttachments(attachments: Attachment[]): Promise<string> {
  return resolveAttachments(attachments, { imageMode: 'described' })
}

/**
 * Resolve an image attachment to a data URI suitable for the
 * OpenAI/OpenAI-compatible `image_url` content part.
 *
 * Returns `null` if the attachment is not an image, cannot be read,
 * or exceeds the maximum size limit.
 *
 * The base64 is either already cached on the Attachment (for
 * clipboard/drag-drop paths) or read from disk here (for file picker
 * / mention paths that only captured the path).
 */
export async function resolveImageToDataUri(att: Attachment): Promise<string | null> {
  if (att.type !== 'image') return null

  // Fast path — already loaded at capture time.
  if (att.base64 && att.base64.startsWith('data:')) return att.base64

  // Slow path — read from disk. Only possible if we have a path.
  if (!att.path) return null

  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const bytes = await readFile(att.path)
    if (bytes.byteLength > MAX_IMAGE_BYTES) return null

    const ext = getExtension(att.name)
    const mime = att.mimeType || (ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`)
    return `data:${mime};base64,${uint8ToBase64(bytes)}`
  } catch {
    return null
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Process in 8KB chunks to avoid call stack overflow on large images
  const CHUNK = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary)
}
