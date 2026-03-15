import { tokens } from '@/theme/tokens'
import MonacoBridge from '../../utils/monacoBridge'

interface ContextMenuOptions {
	activeFile: string | null
	projectPath?: string
}

export function showEditorContextMenu(e: React.MouseEvent, options: ContextMenuOptions) {
	e.preventDefault()
	const { activeFile, projectPath } = options

	const items: { label: string; action: () => void }[] = []

	// Edit actions (Monaco)
	const bridge = MonacoBridge.getInstance()
	items.push({ label: 'Copy', action: () => bridge.trigger('editor.action.clipboardCopyAction') })
	items.push({ label: 'Cut', action: () => bridge.trigger('editor.action.clipboardCutAction') })
	items.push({ label: 'Paste', action: () => bridge.trigger('editor.action.clipboardPasteAction') })
	items.push({ label: 'Select All', action: () => bridge.trigger('editor.action.selectAll') })
	items.push({
		label: 'Format Document', action: () => {
			try { MonacoBridge.getInstance().trigger('editor.action.formatDocument') } catch { }
		}
	})
	items.push({ label: '\u2014', action: () => { } })
	items.push({ label: 'Command Palette\u2026', action: () => window.dispatchEvent(new CustomEvent('command:palette')) })
	items.push({ label: 'Quick Open', action: () => window.dispatchEvent(new CustomEvent('quickopen:toggle')) })
	items.push({ label: 'Toggle Bottom Panel', action: () => window.dispatchEvent(new CustomEvent('panel:toggle-bottom')) })

	if (activeFile) {
		const filePath = activeFile
		items.push({ label: '\u2014', action: () => { } })
		items.push({
			label: 'Reveal in Finder', action: async () => {
				try {
					const dir = filePath.substring(0, Math.max(0, filePath.lastIndexOf('/')))
					const opener = await import('@tauri-apps/plugin-opener')
					try { await opener.revealItemInDir(filePath) } catch {
						await opener.openPath(dir)
					}
				} catch { }
			}
		})
		items.push({
			label: 'Copy Path', action: async () => {
				try { await navigator.clipboard.writeText(filePath) } catch { }
			}
		})
		if (projectPath) {
			const rel = filePath.startsWith(projectPath) ? filePath.slice(projectPath.length + 1) : filePath
			items.push({ label: 'Copy Relative Path', action: async () => { try { await navigator.clipboard.writeText(rel) } catch { } } })
		}
	}

	// Render menu overlay
	const menu = document.createElement('div')
	Object.assign(menu.style, {
		position: 'fixed',
		left: e.clientX + 'px',
		top: e.clientY + 'px',
		zIndex: '3000',
		background: tokens.colors.menu.bg,
		border: `1px solid ${tokens.colors.menu.border}`,
		borderRadius: '8px',
		minWidth: '220px',
		boxShadow: tokens.shadow.overlay
	} as CSSStyleDeclaration)

	items.forEach(it => {
		const row = document.createElement('div')
		if (it.label === '\u2014') {
			Object.assign(row.style, {
				height: '1px',
				background: tokens.colors.menu.separator,
				margin: '4px 0'
			} as CSSStyleDeclaration)
		} else {
			row.textContent = it.label
			Object.assign(row.style, {
				padding: '8px 12px',
				color: tokens.colors.menu.text,
				cursor: 'default'
			} as CSSStyleDeclaration)
			row.onmouseenter = () => { row.style.background = tokens.colors.menu.hover }
			row.onmouseleave = () => { row.style.background = 'transparent' }
			row.onclick = () => { try { it.action() } finally { cleanup() } }
		}
		menu.appendChild(row)
	})

	const cleanup = () => {
		if (menu.parentNode) document.body.removeChild(menu)
		document.removeEventListener('mousedown', dismiss)
	}
	const dismiss = () => cleanup()
	document.addEventListener('mousedown', dismiss)
	document.body.appendChild(menu)
}
