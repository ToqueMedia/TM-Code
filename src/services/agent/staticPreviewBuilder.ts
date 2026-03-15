import { invoke } from '@tauri-apps/api/core'

class StaticPreviewBuilder {
  private static instance: StaticPreviewBuilder

  static getInstance(): StaticPreviewBuilder {
    if (!StaticPreviewBuilder.instance) {
      StaticPreviewBuilder.instance = new StaticPreviewBuilder()
    }
    return StaticPreviewBuilder.instance
  }

  async buildPreview(htmlFilePath: string): Promise<string> {
    let html = await invoke<string>('read_file', { path: htmlFilePath })
    const baseDir = htmlFilePath.substring(0, htmlFilePath.lastIndexOf('/'))

    // Inline <link rel="stylesheet" href="...">
    const linkRegex = /<link\s+[^>]*?href=["']([^"']+)["'][^>]*?>/gi
    const linkMatches = [...html.matchAll(linkRegex)]

    for (const match of linkMatches) {
      const fullTag = match[0]
      // Only process stylesheet links
      if (!fullTag.includes('stylesheet')) continue

      const href = match[1]
      // Skip external URLs
      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
        continue
      }

      const cssPath = href.startsWith('/') ? href : `${baseDir}/${href}`

      try {
        const cssContent = await invoke<string>('read_file', { path: cssPath })
        html = html.replace(fullTag, `<style>\n${cssContent}\n</style>`)
      } catch {
        // CSS file not found — leave the link tag
      }
    }

    // Inline local <script src="...">
    const scriptRegex = /<script\s+[^>]*?src=["']([^"']+)["'][^>]*?>\s*<\/script>/gi
    const scriptMatches = [...html.matchAll(scriptRegex)]

    for (const match of scriptMatches) {
      const fullTag = match[0]
      const src = match[1]

      if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
        continue
      }

      const jsPath = src.startsWith('/') ? src : `${baseDir}/${src}`

      try {
        const jsContent = await invoke<string>('read_file', { path: jsPath })
        html = html.replace(fullTag, `<script>\n${jsContent}\n</script>`)
      } catch {
        // JS file not found — leave the script tag
      }
    }

    return html
  }

  findHtmlFile(filePaths: string[]): string | null {
    // Prioritize index.html
    const indexHtml = filePaths.find(p => p.endsWith('/index.html'))
    if (indexHtml) return indexHtml

    // Fall back to any .html file
    return filePaths.find(p => p.endsWith('.html')) || null
  }
}

export default StaticPreviewBuilder
