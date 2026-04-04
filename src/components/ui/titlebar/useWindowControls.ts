import React from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

function isMacOS(): boolean {
  try {
    const plat = (navigator && (navigator.platform || navigator.userAgent)) || ''
    return /Mac/.test(String(plat))
  } catch {
    return false
  }
}

export async function handleClose(): Promise<void> {
  try {
    await getCurrentWindow().close()
  } catch (err) {
    console.warn('[window] close failed:', err)
  }
}

export async function handleMinimize(): Promise<void> {
  try {
    await getCurrentWindow().minimize()
  } catch (err) {
    console.warn('[window] minimize failed:', err)
  }
}

export async function handleFullToggle(): Promise<void> {
  try {
    const win = getCurrentWindow()
    if (isMacOS()) {
      const fs = await win.isFullscreen()
      await win.setFullscreen(!fs)
    } else {
      const isMax = await win.isMaximized()
      if (isMax) await win.unmaximize()
      else await win.maximize()
    }
  } catch (err) {
    console.warn('[window] fullToggle failed:', err)
  }
}

function shouldStartDrag(target: HTMLElement): boolean {
  const isInteractiveTag = (n: string) => ['input', 'textarea', 'button', 'select', 'svg', 'path', 'a'].includes(n)
  let el: HTMLElement | null = target
  while (el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : ''
    if (isInteractiveTag(tag)) return false
    const role = el.getAttribute && el.getAttribute('role')
    if (role === 'button' || role === 'menu' || role === 'textbox' || role === 'link') return false
    if (el.dataset?.noDrag !== undefined) return false
    if (el.getAttribute && el.getAttribute('data-tauri-drag-region') === 'false') return false
    el = el.parentElement
  }
  return true
}

export async function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
  try {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (!shouldStartDrag(t)) return
    await getCurrentWindow().startDragging()
  } catch { }
}
