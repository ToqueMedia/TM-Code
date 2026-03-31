import { useEffect, useMemo, useState } from 'react'
import ContextMenuOverlay, { type ContextMenuItem } from '../ui/ContextMenuOverlay'
import MonacoBridge from '../../utils/monacoBridge'
import { useEditorRepository } from '@/stores/editorStore'
import { useProjectStore } from '@/stores/projectStore'
import { t } from '@/i18n'

function sep(): ContextMenuItem {
	return { label: '', separator: true }
}

interface MenuEventDetail {
	x: number
	y: number
}

/**
 * React component that listens for a custom event to open the editor context menu.
 * Replaces the old raw-DOM approach with the shared ContextMenuOverlay.
 */
export default function EditorContextMenu() {
	const [isOpen, setIsOpen] = useState(false)
	const [pos, setPos] = useState({ x: 0, y: 0 })

	useEffect(function listen() {
		function onOpen(e: Event) {
			const detail = (e as CustomEvent<MenuEventDetail>).detail
			if (!detail) return
			setPos({ x: detail.x, y: detail.y })
			setIsOpen(true)
		}
		window.addEventListener('editor:contextmenu', onOpen)
		return () => window.removeEventListener('editor:contextmenu', onOpen)
	}, [])

	const activeFile = useEditorRepository(s => s.activeFile)
	const projectPath = useProjectStore(s => s.currentProject?.path)

	const items = useMemo(function buildItems(): ContextMenuItem[] {
		const bridge = MonacoBridge.getInstance()
		const editorActive = !!bridge.getCurrentEditor()
		const result: ContextMenuItem[] = []

		// ── Navigation ───────────────────────────────────────────────
		if (editorActive) {
			result.push({ label: t('ctx.goToDefinition'), hint: 'F12', action: () => bridge.runAction('editor.action.revealDefinition') })
			result.push({ label: t('ctx.goToTypeDefinition'), action: () => bridge.runAction('editor.action.goToTypeDefinition') })
			result.push({ label: t('ctx.goToImplementation'), hint: '⌘F12', action: () => bridge.runAction('editor.action.goToImplementation') })
			result.push({ label: t('ctx.goToReferences'), hint: '⇧F12', action: () => bridge.runAction('editor.action.goToReferences') })
			result.push(sep())
			result.push({ label: t('ctx.peekDefinition'), hint: '⌥F12', action: () => bridge.runAction('editor.action.peekDefinition') })
			result.push({ label: t('ctx.peekReferences'), action: () => bridge.runAction('editor.action.referenceSearch.trigger') })
			result.push(sep())
		}

		// ── Refactoring ──────────────────────────────────────────────
		if (editorActive) {
			result.push({ label: t('ctx.renameSymbol'), hint: 'F2', action: () => bridge.runAction('editor.action.rename') })
			result.push({ label: t('ctx.quickFix'), hint: '⌘.', action: () => bridge.runAction('editor.action.quickFix') })
			result.push({ label: t('ctx.refactor'), hint: '⌃⇧R', action: () => bridge.runAction('editor.action.refactor') })
			result.push({ label: t('ctx.sourceAction'), action: () => bridge.runAction('editor.action.sourceAction') })
			result.push(sep())
		}

		// ── Edit actions ─────────────────────────────────────────────
		result.push({ label: t('ctx.cut'), hint: '⌘X', action: () => MonacoBridge.getInstance().trigger('editor.action.clipboardCutAction') })
		result.push({ label: t('ctx.copy'), hint: '⌘C', action: () => MonacoBridge.getInstance().trigger('editor.action.clipboardCopyAction') })
		result.push({ label: t('ctx.paste'), hint: '⌘V', action: () => MonacoBridge.getInstance().trigger('editor.action.clipboardPasteAction') })
		result.push(sep())

		// ── Selection ────────────────────────────────────────────────
		if (editorActive) {
			result.push({ label: t('ctx.selectAll'), hint: '⌘A', action: () => bridge.trigger('editor.action.selectAll') })
			result.push({ label: t('ctx.addNextOccurrence'), hint: '⌘D', action: () => bridge.runAction('editor.action.addSelectionToNextFindMatch') })
			result.push({ label: t('ctx.selectAllOccurrences'), hint: '⌘⇧L', action: () => bridge.runAction('editor.action.selectHighlights') })
			result.push(sep())
		}

		// ── Editor ───────────────────────────────────────────────────
		if (editorActive) {
			result.push({ label: t('ctx.formatDocument'), hint: '⇧⌥F', action: () => { try { bridge.trigger('editor.action.formatDocument') } catch {} } })
			result.push({ label: t('ctx.toggleLineComment'), hint: '⌘/', action: () => bridge.runAction('editor.action.commentLine') })
			result.push(sep())
		}

		// ── Tools ────────────────────────────────────────────────────
		result.push({ label: t('ctx.commandPalette'), hint: '⌘⇧P', action: () => window.dispatchEvent(new CustomEvent('command:palette')) })
		result.push({ label: t('ctx.quickOpen'), hint: '⌘P', action: () => window.dispatchEvent(new CustomEvent('quickopen:toggle')) })

		// ── File actions ─────────────────────────────────────────────
		if (activeFile) {
			const filePath = activeFile
			result.push(sep())
			result.push({
				label: t('ctx.revealInFinder'), async action() {
					try {
						const dir = filePath.substring(0, Math.max(0, filePath.lastIndexOf('/')))
						const opener = await import('@tauri-apps/plugin-opener')
						try { await opener.revealItemInDir(filePath) } catch {
							await opener.openPath(dir)
						}
					} catch {}
				}
			})
			result.push({
				label: t('ctx.copyPath'), async action() {
					try { await navigator.clipboard.writeText(filePath) } catch {}
				}
			})
			if (projectPath) {
				const rel = filePath.startsWith(projectPath) ? filePath.slice(projectPath.length + 1) : filePath
				result.push({ label: t('ctx.copyRelativePath'), async action() { try { await navigator.clipboard.writeText(rel) } catch {} } })
			}
		}

		return result
	}, [activeFile, projectPath])

	if (!isOpen) return null

	return (
		<ContextMenuOverlay
			items={items}
			x={pos.x}
			y={pos.y}
			onClose={() => setIsOpen(false)}
		/>
	)
}

