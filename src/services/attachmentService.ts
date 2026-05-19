import { cachedBuildFileTree, cachedReadFile } from './agent/ipcCache'
import { Attachment, AttachmentType } from '../types/chat'
import type { FileTreeNode } from '../types/fileTree'
import { extractMentions } from '../utils/mentionParser'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_FILE_CHARS = 20_000
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
// Treat as binary so we refuse to inline them as text.
const BINARY_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  'pdf', 'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
  'mp3', 'wav', 'flac', 'ogg', 'm4a',
  'mp4', 'mov', 'webm', 'mkv', 'avi',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'exe', 'dll', 'so', 'dylib', 'bin',
])

let idCounter = 0
function nextId(): string {
  return `att_${Date.now()}_${++idCounter}`
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function getFileName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
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

/**
 * Normalise a mention token and check that its resolved filesystem path stays
 * inside the project root. Returns null when the target escapes the project
 * (path traversal defence) or is otherwise invalid.
 *
 * `projectPath` must be absolute; trailing separators are tolerated.
 */
function resolveMentionTarget(token: string, projectPath: string): {
  fullPath: string
  displayPath: string
  hadTrailingSlash: boolean
} | null {
  const hadTrailingSlash = token.endsWith('/') || token.endsWith('\\')
  const cleaned = token.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  if (!cleaned) return null

  const isAbsolute = cleaned.startsWith('/') || /^[A-Za-z]:\//.test(cleaned)
  const root = projectPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')

  // Compose candidate and normalise `..` / `.` segments so we can reject
  // traversals before hitting the filesystem.
  const raw = isAbsolute ? cleaned : `${root}/${cleaned}`
  const segments: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { segments.pop(); continue }
    segments.push(seg)
  }
  const normalised = (raw.startsWith('/') ? '/' : '') + segments.join('/')

  const rootPrefix = root.endsWith('/') ? root : root + '/'
  if (normalised !== root && !normalised.startsWith(rootPrefix)) {
    return null
  }

  return {
    fullPath: normalised,
    displayPath: token,
    hadTrailingSlash,
  }
}

/**
 * Extracts @path mentions from text, reads file contents or directory listings,
 * returns a context block. A trailing "/" on the mention marks it as a directory
 * (e.g. "@src/components/"); paths without the suffix are probed via stat().
 *
 * E.g. "update @src/App.tsx" → reads src/App.tsx and returns <mentioned_files>.
 *      "explain @src/hooks/" → lists children and returns <mentioned_directory>.
 */
export async function extractAndResolveMentions(text: string, projectPath: string): Promise<string> {
  const mentions = extractMentions(text)
  if (mentions.length === 0) return ''

  // Deduplicate by token so multiple references in a prompt resolve once.
  const unique = Array.from(new Set(mentions.map(m => m.token)))

  const parts = await Promise.all(unique.map(async (token): Promise<string> => {
    const resolved = resolveMentionTarget(token, projectPath)
    if (!resolved) {
      return `<mentioned_file path="${token}">\n[Access denied: path resolves outside the project root]\n</mentioned_file>`
    }
    const { fullPath, displayPath, hadTrailingSlash } = resolved

    // Images are never useful as truncated UTF-8 — surface a clear note instead.
    const ext = getExtension(getFileName(fullPath))
    if (IMAGE_EXTENSIONS.has(ext)) {
      return `<mentioned_image path="${displayPath}" ext="${ext}">\n[Image referenced — attach via paste / file picker to send it to a multimodal model.]\n</mentioned_image>`
    }
    if (BINARY_EXTENSIONS.has(ext)) {
      return `<mentioned_file path="${displayPath}">\n[Binary file (${ext}) — contents not inlined.]\n</mentioned_file>`
    }

    // Disambiguate file vs dir. Trailing slash is an authoritative hint.
    let isDirectory = hadTrailingSlash
    if (!isDirectory) {
      try {
        const { stat } = await import('@tauri-apps/plugin-fs')
        const info = await stat(fullPath)
        isDirectory = !!info.isDirectory
      } catch {
        // Leave as false; read_file will produce a friendly error below.
      }
    }

    if (isDirectory) {
      try {
        const tree = await cachedBuildFileTree<FileTreeNode>({
          rootPath: fullPath,
          filter: { showHidden: false },
        })
        const children = tree.children || []
        const listing = children
          .slice(0, 200)
          .map(c => `${c.type === 'directory' ? '[d]' : '   '} ${c.name}`)
          .join('\n') || '(empty directory)'
        const overflowNote = children.length > 200
          ? `\n[... ${children.length - 200} more entries]`
          : ''
        return `<mentioned_directory path="${displayPath}">\n${listing}${overflowNote}\n</mentioned_directory>`
      } catch {
        return `<mentioned_directory path="${displayPath}">\n[Error: could not list directory]\n</mentioned_directory>`
      }
    }

    try {
      const content = await cachedReadFile(fullPath)
      const truncated = content.length > MAX_FILE_CHARS
        ? content.slice(0, MAX_FILE_CHARS) + '\n[... truncated]'
        : content
      return `<mentioned_file path="${displayPath}">\n${truncated}\n</mentioned_file>`
    } catch {
      return `<mentioned_file path="${displayPath}">\n[Error: could not read file]\n</mentioned_file>`
    }
  }))

  return '\n\n<mentioned_files>\n' + parts.join('\n') + '\n</mentioned_files>'
}

/**
 * Resolves all attachments into a context string to append to the user prompt.
 */
export async function resolveAttachments(attachments: Attachment[]): Promise<string> {
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
        const tree = await cachedBuildFileTree<FileTreeNode>({
          rootPath: att.path,
          filter: { showHidden: false },
        })
        const listing = (tree.children || [])
          .map(c => `${c.type === 'directory' ? '[d] ' : '    '}${c.name}`)
          .join('\n')
        return `<attached_folder path="${att.path}">\n${listing}\n</attached_folder>`
      } else if (att.type === 'image') {
        const size = att.sizeBytes ? `${Math.round(att.sizeBytes / 1024)}KB` : 'unknown size'
        const source = att.path ? `path="${att.path}"` : 'source="clipboard"'
        return `<attached_image name="${att.name}" mime="${att.mimeType || 'image/png'}" ${source} size="${size}">\n[Image attached — this model is text-only, so the image could not be shown. Describe what you need help with, or switch to a multimodal model.]\n</attached_image>`
      }
      return ''
    } catch {
      return `<attached_file path="${att.path}">\n[Error: could not read file]\n</attached_file>`
    }
  }))

  const filtered = parts.filter(Boolean)
  return filtered.length > 0 ? '\n\n<attachments>\n' + filtered.join('\n') + '\n</attachments>' : ''
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
