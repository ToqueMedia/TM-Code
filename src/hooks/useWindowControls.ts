import { useCallback } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * Shared window control handlers — eliminates duplication across
 * WelcomeScreen and any other view needing them.
 */
export function useWindowControls() {
  const handleClose = useCallback(async () => {
    try { await getCurrentWindow().close() } catch { /* noop */ }
  }, [])

  const handleMinimize = useCallback(async () => {
    try { await getCurrentWindow().minimize() } catch { /* noop */ }
  }, [])

  const handleFullToggle = useCallback(async () => {
    try {
      const win = getCurrentWindow()
      if (/Mac/.test(navigator.platform || '')) {
        const fs = await win.isFullscreen()
        await win.setFullscreen(!fs)
      } else {
        const isMax = await win.isMaximized()
        if (isMax) await win.unmaximize()
        else await win.maximize()
      }
    } catch { /* noop */ }
  }, [])

  return { handleClose, handleMinimize, handleFullToggle }
}
