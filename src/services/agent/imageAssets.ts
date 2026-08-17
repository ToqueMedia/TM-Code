/**
 * Local image helpers for generate_image + Read of project assets.
 *
 * OpenAI-compatible tool results are text-only, so the agent "sees" a
 * project PNG the same way capture_url_design sees a screenshot: pixels
 * go to the vision sidecar (or, on native-vision BYOK, we still describe
 * when a sidecar exists) and the model gets the description.
 */
import type { OpenAIContentPart } from './types'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

export function isProjectImagePath(path: string): boolean {
  return IMAGE_EXT.test(path)
}

export function mimeForImagePath(path: string): string {
  const ext = path.replace(/\\/g, '/').split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/png'
}

export async function fileToDataUri(absolutePath: string): Promise<string | null> {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const bytes = await readFile(absolutePath)
    if (!bytes.byteLength) return null
    const CHUNK = 8192
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
      binary += String.fromCharCode.apply(null, slice as unknown as number[])
    }
    return `data:${mimeForImagePath(absolutePath)};base64,${btoa(binary)}`
  } catch {
    return null
  }
}

const ASSET_VISION_SYSTEM =
  'You are a vision assistant serving a coding agent that just wrote or is inspecting a project image asset. ' +
  'Describe what is ACTUALLY visible: subject, style (photograph vs illustration vs 3D render vs flat graphic), ' +
  'composition, palette, lighting, visible text (verbatim), and anything that would fail as a product asset ' +
  '(illegible lettering, cartoon look when a photo was asked, wrong product, watermark). Be factual. Do not invent.'

export async function describeImageFile(
  absolutePath: string,
  brief?: string,
): Promise<string | null> {
  const dataUri = await fileToDataUri(absolutePath)
  if (!dataUri) return null
  const { describeImagesViaSidecar } = await import('./visionSidecar')
  const parts: OpenAIContentPart[] = [{ type: 'image_url', image_url: { url: dataUri } }]
  return describeImagesViaSidecar(parts, {
    systemPrompt: ASSET_VISION_SYSTEM,
    userText: brief
      ? `Brief that was requested:\n${brief}\n\nDescribe what the file actually shows, and whether it matches the brief.`
      : 'Describe this project image asset in full detail.',
  })
}
