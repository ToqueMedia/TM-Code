// Safe platform patches for WebView environments

// Patch clipboard API to avoid NotAllowedError on initialization or non-gesture calls
(function patchClipboard() {
  try {
    const nav: any = (typeof navigator !== 'undefined' ? navigator : null)
    if (!nav || !nav.clipboard) return

    const originalReadText = nav.clipboard.readText?.bind(nav.clipboard)
    const originalWriteText = nav.clipboard.writeText?.bind(nav.clipboard)

    if (typeof originalReadText === 'function') {
      nav.clipboard.readText = async function() {
        try {
          return await originalReadText()
        } catch (e: any) {
          if (e && (e.name === 'NotAllowedError' || e.code === 0 || String(e).includes('NotAllowedError'))) {
            // Silently return empty string when permissions are not granted yet
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
        } catch (e: any) {
          if (e && (e.name === 'NotAllowedError' || e.code === 0 || String(e).includes('NotAllowedError'))) {
            // Ignore permission error on initial load
            return
          }
          throw e
        }
      }
    }
  } catch {}
})()