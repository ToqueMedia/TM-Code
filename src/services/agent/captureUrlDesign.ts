/**
 * capture_url_design — navigate a URL in the on-demand Playwright browser,
 * screenshot it, and turn the pixels into a design handoff via the vision
 * sidecar (same path pasted images use for non-vision models).
 *
 * Why a dedicated tool (not "just call mcp__browser__*"):
 *  - The agent shouldn't need `/te2e` opt-in for a conversational "copy this
 *    site's design" request — browserSession.start() is the same gate.
 *  - MCP `callTool` historically dropped image blocks; we use callToolDetailed
 *    and feed the screenshot straight into vision so the model gets text it
 *    can implement from, not a silent empty result.
 *  - When vision is unavailable (free+BYOK, no sidecar), we fall back to the
 *    accessibility snapshot so the agent still gets structure.
 *
 * Playwright MCP note: `fullPage: true` saves a file and does NOT attach an
 * image block (only viewport screenshots do). We re-read the saved file via
 * the Tauri fs plugin so full-page design captures still reach vision.
 */

import MCPService, { type MCPImageContent } from '../mcp/mcpService'
import { browserSession, BROWSER_SERVER_NAME } from '../browserSessionManager'
import { DESIGN_VISION_SYSTEM, describeImagesViaSidecar } from './visionSidecar'
import type { OpenAIContentPart } from './types'
import { logger } from '../../utils/logger'

export interface CaptureUrlDesignInput {
  url: string
  /** Optional focus hint, e.g. "hero section only" / "pricing cards". */
  focus?: string
  /** Full scrollable page vs viewport. Default true (design-copy wants the page). */
  fullPage?: boolean
  signal?: AbortSignal
}

const MAX_SHOT_BYTES = 4 * 1024 * 1024

function assertHttpUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`"${raw}" is not a valid absolute URL. Provide a full http(s) URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`capture_url_design only supports http/https (got "${parsed.protocol}").`)
  }
  return parsed
}

async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; images: MCPImageContent[] }> {
  browserSession.touch()
  return MCPService.getInstance().callToolDetailed(BROWSER_SERVER_NAME, toolName, args)
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Chunk to avoid call-stack limits on large screenshots.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Playwright full-page shots only write a file path into the text result
 * (no image block). Re-hydrate base64 from disk so vision still works.
 */
async function imagesFromTextPaths(text: string): Promise<MCPImageContent[]> {
  if (!text) return []
  // Paths may be absolute ("/tmp/…/page-….png") or bare filenames.
  const candidates = text.match(/(?:^|[\s"`'])(\S+\.(?:png|jpe?g|webp))\b/gi) ?? []
  const images: MCPImageContent[] = []
  let readFile: ((path: string) => Promise<Uint8Array>) | null = null
  try {
    const fs = await import('@tauri-apps/plugin-fs')
    readFile = (p) => fs.readFile(p)
  } catch {
    return []
  }

  for (const raw of candidates.slice(0, 3)) {
    const path = raw.replace(/^[\s"`']+/, '').trim()
    if (!path) continue
    try {
      const bytes = await readFile(path)
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_SHOT_BYTES) continue
      const mimeType = /\.jpe?g$/i.test(path)
        ? 'image/jpeg'
        : /\.webp$/i.test(path)
          ? 'image/webp'
          : 'image/png'
      images.push({ mimeType, data: uint8ToBase64(bytes) })
    } catch {
      // path not readable — ignore
    }
  }
  return images
}

function toImageParts(images: MCPImageContent[]): OpenAIContentPart[] {
  return images.map((img) => ({
    type: 'image_url' as const,
    image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: 'high' as const },
  }))
}

/**
 * Take a screenshot, re-hydrating full-page file saves when needed. If a
 * full-page capture yields no image, fall back to viewport (which embeds
 * the PNG in the MCP response).
 */
async function takeScreenshot(fullPage: boolean): Promise<{
  text: string
  images: MCPImageContent[]
  mode: 'full page' | 'viewport'
}> {
  const shot = await mcpCall('browser_take_screenshot', {
    type: 'png',
    fullPage,
  })
  let images = shot.images
  if (images.length === 0 && shot.text) {
    images = await imagesFromTextPaths(shot.text)
  }
  if (images.length > 0) {
    return { text: shot.text, images, mode: fullPage ? 'full page' : 'viewport' }
  }
  // fullPage path failed to rehydrate — viewport always attaches image data.
  if (fullPage) {
    const viewport = await mcpCall('browser_take_screenshot', { type: 'png', fullPage: false })
    let vpImages = viewport.images
    if (vpImages.length === 0 && viewport.text) {
      vpImages = await imagesFromTextPaths(viewport.text)
    }
    return {
      text: [shot.text, viewport.text].filter(Boolean).join('\n'),
      images: vpImages,
      mode: 'viewport',
    }
  }
  return { text: shot.text, images, mode: 'viewport' }
}

/**
 * Run the full capture → describe pipeline. Returns a string the agent can
 * paste into its plan for recreating the design.
 */
// ── Mutex do browser partilhado (multi-agent) ──
// Uma cadeia de promessas serializa TODAS as capturas do processo: main + N
// tarefas paralelas partilham a mesma sessão Playwright/tab; sem isto,
// navigate/screenshot de dois agentes interleavam e ambos saem corrompidos.
let browserChain: Promise<unknown> = Promise.resolve()
export function withBrowserExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = browserChain.then(fn, fn)
  browserChain = run.catch(() => { /* falha de um não trava a fila */ })
  return run
}

export async function captureUrlDesign(input: CaptureUrlDesignInput): Promise<string> {
  const parsed = assertHttpUrl(String(input.url ?? '').trim())
  const focus = typeof input.focus === 'string' ? input.focus.trim() : ''
  const fullPage = input.fullPage !== false
  const signal = input.signal

  if (signal?.aborted) return `capture_url_design cancelled by user (${parsed.toString()}).`

  // Lazy-boot the Playwright MCP browser (same path as /te2e).
  try {
    await browserSession.start()
    await browserSession.beginSession()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('capture-url-design', 'browser start failed', err)
    return (
      `Error: could not start the design-capture browser: ${msg}\n\n` +
      'capture_url_design needs Node.js (npx) and a Chromium-based browser (Chrome/Edge/Brave). ' +
      'Install those, fully quit and reopen TM Code, then retry. Meanwhile use web_fetch ' +
      '(text + stylesheet list + mode:"raw") for structural/CSS-based recreation.'
    )
  }

  if (signal?.aborted) return `capture_url_design cancelled by user (${parsed.toString()}).`

  try {
    await mcpCall('browser_navigate', { url: parsed.toString() })
    // Let late paints/fonts settle — design screenshots of SPAs otherwise
    // often capture empty shells.
    try {
      await mcpCall('browser_wait_for', { time: 2 })
    } catch {
      // wait tool optional; navigation alone is enough on static pages
    }

    if (signal?.aborted) return `capture_url_design cancelled by user (${parsed.toString()}).`

    const shot = await takeScreenshot(fullPage)

    // Prefer vision description when we have pixels.
    if (shot.images.length > 0) {
      const userText = focus
        ? `Describe this webpage screenshot as a design handoff. Focus especially on: ${focus}`
        : 'Describe this webpage screenshot as a full design handoff for recreation.'
      const description = await describeImagesViaSidecar(toImageParts(shot.images), {
        systemPrompt: DESIGN_VISION_SYSTEM,
        userText,
      })
      if (description) {
        return [
          `URL: ${parsed.toString()}`,
          `Capture: ${shot.mode}`,
          focus ? `Focus: ${focus}` : '',
          '',
          description,
          '',
          'Next steps for recreation: combine this visual description with web_fetch ' +
            '(text mode for content + stylesheet URLs; mode:"raw" for markup/classes) ' +
            'and fetch the listed CSS files for exact colors/fonts/spacing.',
        ]
          .filter(Boolean)
          .join('\n')
      }
      logger.warn('capture-url-design', 'vision sidecar unavailable — falling back to a11y snapshot')
    }

    // Fallback: accessibility tree (structure without pixels).
    const snap = await mcpCall('browser_snapshot', {})
    const snapText = (snap.text || '').slice(0, 40_000)
    return [
      `URL: ${parsed.toString()}`,
      `Capture: ${shot.mode} (screenshot taken but visual description unavailable)`,
      focus ? `Focus: ${focus}` : '',
      '',
      'Visual description was unavailable (no vision sidecar, or free+BYOK without native vision).',
      'Below is the accessibility snapshot (structure/roles/labels) — use it with web_fetch ' +
        'mode:"raw" + stylesheet URLs for design recreation.',
      '',
      snapText || shot.text || '(empty snapshot)',
    ]
      .filter(Boolean)
      .join('\n')
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return `capture_url_design cancelled by user (${parsed.toString()}).`
    }
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('capture-url-design', 'pipeline failed', err)
    return (
      `Error capturing design for ${parsed.toString()}: ${msg}\n\n` +
      'Fall back to web_fetch (text + stylesheets + mode:"raw") for a non-visual recreation.'
    )
  }
}
