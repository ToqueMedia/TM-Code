// Safe platform patches for WebView environments

// Patch clipboard API to avoid NotAllowedError on initialization or non-gesture calls
(function patchClipboard() {
  try {
    const nav = (typeof navigator !== 'undefined' ? navigator : null)
    if (!nav || !nav.clipboard) return

    const originalReadText = nav.clipboard.readText?.bind(nav.clipboard)
    const originalWriteText = nav.clipboard.writeText?.bind(nav.clipboard)

    if (typeof originalReadText === 'function') {
      nav.clipboard.readText = async function() {
        try {
          return await originalReadText()
        } catch (e: unknown) {
          if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.code === 0)) {
            // Silently return empty string when permissions are not granted yet
            return ''
          }
          if (typeof e === 'object' && e !== null && String(e).includes('NotAllowedError')) {
            return ''
          }
          throw e
        }
      }
    }

    if (typeof originalWriteText === 'function') {
      nav.clipboard.writeText = async function(text: string) {
        try {
          return await originalWriteText(text)
        } catch (e: unknown) {
          if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.code === 0)) {
            // Ignore permission error on initial load
            return
          }
          if (typeof e === 'object' && e !== null && String(e).includes('NotAllowedError')) {
            return
          }
          throw e
        }
      }
    }

    // Patch read() / write() — Monaco's clipboardService uses these too
    const originalRead = nav.clipboard.read?.bind(nav.clipboard)
    const originalWrite = nav.clipboard.write?.bind(nav.clipboard)

    if (typeof originalRead === 'function') {
      nav.clipboard.read = async function() {
        try {
          return await originalRead()
        } catch (e: unknown) {
          if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.code === 0)) {
            return [] as unknown as ClipboardItems
          }
          if (typeof e === 'object' && e !== null && String(e).includes('NotAllowedError')) {
            return [] as unknown as ClipboardItems
          }
          throw e
        }
      }
    }

    if (typeof originalWrite === 'function') {
      nav.clipboard.write = async function(data: ClipboardItems) {
        try {
          return await originalWrite(data)
        } catch (e: unknown) {
          if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.code === 0)) {
            return
          }
          if (typeof e === 'object' && e !== null && String(e).includes('NotAllowedError')) {
            return
          }
          throw e
        }
      }
    }
  } catch {}
})()