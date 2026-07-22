/**
 * Convert an HTML document into readable plain text for the agent's web_fetch
 * tool. Runs in the WebView (and jsdom under tests), so DOMParser is available.
 *
 * Goal: strip chrome (scripts/styles/nav) and preserve enough block structure
 * (headings, paragraphs, list items, line breaks) that the model can read a docs
 * page without being buried in markup. This is deliberately lightweight — it is
 * NOT a full Readability port; it just makes fetched pages legible.
 */

/** Elements whose textContent is never useful content. */
const DROP_SELECTOR =
  'script,style,noscript,template,svg,canvas,iframe,object,embed,link,head > meta'

/** Block-ish elements: we append a newline so textContent keeps their boundaries. */
const BLOCK_SELECTOR =
  'p,div,section,article,li,tr,ul,ol,table,blockquote,pre,header,footer,nav,aside,figure,figcaption,br,hr,h1,h2,h3,h4,h5,h6,dt,dd,details,summary'

/** Cheap check: does this body look like markup we should parse as HTML? */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 4000).toLowerCase()
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<div[\s>]|<p[\s>]|<article[\s>]|<main[\s>]/.test(head)
}

export interface ExtractedPage {
  title: string
  text: string
  /**
   * Absolute URLs of the page's external stylesheets (<link rel="stylesheet">),
   * resolved against `baseUrl` when given. Collected BEFORE the DROP pass
   * (which removes <link> tags) so a design-copy flow can fetch the raw CSS —
   * colors/fonts/spacing live there, not in the extracted text.
   */
  stylesheets: string[]
  /** Total characters of inline <style> blocks (signal that critical CSS is
   *  inlined — fetch the page with mode:'raw' to read it). */
  inlineStyleChars: number
}

/**
 * Extract { title, text, stylesheets } from an HTML string. On any parser
 * failure it falls back to a naive tag-strip so the caller always gets
 * *something* readable.
 */
export function htmlToText(html: string, baseUrl?: string): ExtractedPage {
  try {
    if (typeof DOMParser === 'undefined') {
      return { title: '', text: stripTags(html), stylesheets: [], inlineStyleChars: 0 }
    }
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // Collect design signals BEFORE dropping chrome (the DROP pass removes
    // <link> and <style>). Dedup + resolve to absolute so the agent can pass
    // them straight back into web_fetch.
    const stylesheets: string[] = []
    const seenHref = new Set<string>()
    doc.querySelectorAll('link[rel~="stylesheet" i][href]').forEach((el) => {
      const href = el.getAttribute('href')?.trim()
      if (!href) return
      try {
        const abs = baseUrl ? new URL(href, baseUrl).toString() : href
        if (!seenHref.has(abs)) {
          seenHref.add(abs)
          stylesheets.push(abs)
        }
      } catch { /* malformed href — skip */ }
    })
    let inlineStyleChars = 0
    doc.querySelectorAll('style').forEach((el) => {
      inlineStyleChars += el.textContent?.length ?? 0
    })

    doc.querySelectorAll(DROP_SELECTOR).forEach((el) => el.remove())

    // Push newlines into block boundaries so the flat textContent below keeps
    // paragraph/heading/list structure. Headings also get a leading blank line.
    doc.querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
      el.append('\n')
      if (/^H[1-6]$/.test(el.tagName)) el.prepend('\n')
    })

    const title = (doc.querySelector('title')?.textContent ?? '').trim()
    // Prefer the main content region when the page marks one up.
    const root =
      doc.querySelector('main') ??
      doc.querySelector('article') ??
      doc.body ??
      doc.documentElement

    const text = normalizeWhitespace(root?.textContent ?? '')
    return { title, text, stylesheets, inlineStyleChars }
  } catch {
    return { title: '', text: stripTags(html), stylesheets: [], inlineStyleChars: 0 }
  }
}

/** Collapse runs of spaces/tabs and blank lines without destroying paragraphs. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Last-resort tag stripper for when DOMParser is unavailable or throws. */
function stripTags(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  )
}
