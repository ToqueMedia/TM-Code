import React from 'react'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'

function getCurrentWin(): WebviewWindow {
	return WebviewWindow.getCurrent()
}

function getCurrentWinV2() {
	try {
		return getCurrentWindow()
	} catch {
		return null
	}
}

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
		const w2 = getCurrentWinV2()
		if (w2) { await w2.close(); return }
		await getCurrentWin().close()
	} catch { }
}

export async function handleMinimize(): Promise<void> {
	try {
		const w2 = getCurrentWinV2()
		if (w2) { await w2.minimize(); return }
		await getCurrentWin().minimize()
	} catch { }
}

export async function handleFullToggle(): Promise<void> {
	try {
		const w2 = getCurrentWinV2()
		if (isMacOS()) {
			if (w2) {
				const cur = await w2.isFullscreen()
				await w2.setFullscreen(!cur)
				return
			}
			const w = getCurrentWin() as unknown as { isFullscreen?: () => Promise<boolean>; setFullscreen?: (v: boolean) => Promise<void> }
			const fs = await w.isFullscreen?.()
			if (typeof fs === 'boolean') {
				await w.setFullscreen?.(!fs)
				return
			}
		}
		if (w2) {
			const isMax = await w2.isMaximized()
			if (isMax) { await w2.unmaximize() } else { await w2.maximize() }
			return
		}
		const w = getCurrentWin()
		const isMax = await w.isMaximized()
		if (isMax) { await w.unmaximize() } else { await w.maximize() }
	} catch { }
}

function shouldStartDrag(target: HTMLElement): boolean {
	const isInteractiveTag = (n: string) => ['input', 'textarea', 'button', 'select', 'svg', 'path', 'a'].includes(n)
	let el: HTMLElement | null = target
	while (el) {
		const tag = el.tagName ? el.tagName.toLowerCase() : ''
		if (isInteractiveTag(tag)) return false
		const role = el.getAttribute && el.getAttribute('role')
		if (role === 'button' || role === 'menu' || role === 'textbox' || role === 'link') return false
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
		const win = getCurrentWindow()
		await win.startDragging()
	} catch { }
}
