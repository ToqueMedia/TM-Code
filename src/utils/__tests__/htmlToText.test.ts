import { htmlToText, looksLikeHtml } from '../htmlToText'

describe('looksLikeHtml', () => {
  it('detects an HTML document', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html><body>hi</body></html>')).toBe(true)
    expect(looksLikeHtml('  <div class="x">content</div>')).toBe(true)
  })
  it('rejects JSON / plain text', () => {
    expect(looksLikeHtml('{"a":1,"b":[2,3]}')).toBe(false)
    expect(looksLikeHtml('just some plain text, no tags')).toBe(false)
  })
})

describe('htmlToText', () => {
  it('extracts the title and strips scripts/styles', () => {
    const html = `
      <html>
        <head><title>Docs — Getting Started</title><style>.a{color:red}</style></head>
        <body>
          <script>window.x = 1</script>
          <h1>Install</h1>
          <p>Run <code>npm i foo</code> to begin.</p>
        </body>
      </html>`
    const { title, text } = htmlToText(html)
    expect(title).toBe('Docs — Getting Started')
    expect(text).toContain('Install')
    expect(text).toContain('npm i foo')
    expect(text).not.toContain('window.x')
    expect(text).not.toContain('color:red')
  })

  it('preserves block structure as newlines', () => {
    const { text } = htmlToText('<body><p>First paragraph.</p><p>Second paragraph.</p></body>')
    expect(text).toBe('First paragraph.\nSecond paragraph.')
  })

  it('prefers the <main> region when present', () => {
    const html =
      '<body><nav>Home About Contact</nav><main><p>Real content here.</p></main><footer>© 2026</footer></body>'
    const { text } = htmlToText(html)
    expect(text).toContain('Real content here.')
    expect(text).not.toContain('About Contact')
  })

  it('collects absolute stylesheet URLs resolved against baseUrl', () => {
    const html = `
      <html><head>
        <link rel="stylesheet" href="/assets/app.css">
        <link rel="stylesheet" href="https://cdn.example.com/theme.css">
        <link rel="preload" href="/font.woff2" as="font">
        <link rel="Stylesheet" href="/assets/app.css">
      </head><body><p>Hi</p></body></html>`
    const { stylesheets, text } = htmlToText(html, 'https://example.com/page')
    expect(stylesheets).toEqual([
      'https://example.com/assets/app.css',
      'https://cdn.example.com/theme.css',
    ])
    expect(text).toContain('Hi')
  })

  it('counts inline <style> characters without leaking them into text', () => {
    const html = `
      <html><head><style>.btn{color:#0af;padding:8px}</style></head>
      <body><p>Hello</p><style>.x{}</style></body></html>`
    const { text, inlineStyleChars, stylesheets } = htmlToText(html)
    expect(text).toBe('Hello')
    expect(text).not.toContain('color')
    expect(inlineStyleChars).toBeGreaterThan(10)
    expect(stylesheets).toEqual([])
  })
})
