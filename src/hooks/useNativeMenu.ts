import { useEffect } from 'react'
import { useEditorRepository } from '@/stores/editorStore'
import { useLayoutStore } from '@/stores/layoutStore'
import MonacoBridge from '@/utils/monacoBridge'
import { TEXT_FILE_EXTENSIONS } from '@/utils/platform'

// Editor-only menu IDs — ignored when not in editor view
const editorOnlyIds = new Set([
	'save', 'save-all', 'close-tab', 'close-all-tabs',
	'find', 'replace', 'toggle-comment', 'format-document',
	'toggle-word-wrap', 'split-editor',
	'go-to-line', 'go-to-definition', 'peek-definition', 'go-to-references', 'go-to-symbol',
])

/**
 * Listens for native macOS menu events forwarded from Rust via window.eval.
 * Each menu item ID maps to the same actions as the in-window MenuBar.
 * Editor-only actions are ignored when not in editor view.
 */
export function useNativeMenu() {
	useEffect(() => {
		function onNativeMenu(e: Event) {
			const id = (e as CustomEvent<{ id: string }>).detail?.id
			if (!id) return

			// Ignore editor-only actions when not in editor view
			const viewMode = useLayoutStore.getState().viewMode
			if (viewMode !== 'editor' && editorOnlyIds.has(id)) return

			const bridge = MonacoBridge.getInstance()
			const dispatch = (event: string) => window.dispatchEvent(new CustomEvent(event))

			switch (id) {
				// File
				case 'open-file':
					(async () => {
						const { open } = await import('@tauri-apps/plugin-dialog')
						const selected = await open({
							directory: false,
							multiple: false,
							title: 'Open File',
							filters: [{ name: 'Text Files', extensions: TEXT_FILE_EXTENSIONS }],
						})
						if (!selected) return
						const filePath = String(selected)
						const sep = filePath.includes('/') ? '/' : '\\'
						const parentDir = filePath.substring(0, filePath.lastIndexOf(sep)) || sep
						const { useProjectStore } = await import('@/stores/projectStore')
						await useProjectStore.getState().openProject(parentDir)
						const { useEditorRepository } = await import('@/stores/editorStore')
						useEditorRepository.getState().openFile(filePath)
						const { useLayoutStore } = await import('@/stores/layoutStore')
						useLayoutStore.getState().setViewMode('editor')
					})().catch(() => {})
					break
				case 'open-folder':
					import('@tauri-apps/plugin-dialog').then(({ open }) => {
						open({ directory: true, multiple: false, title: 'Select project directory' }).then(selected => {
							if (selected) {
								import('@/stores/projectStore').then(({ useProjectStore }) => {
									useProjectStore.getState().openProject(String(selected))
								})
							}
						})
					}).catch(() => {})
					break
				case 'save':
					bridge.runAction('tmcode.save')
					break
				case 'save-all':
					useEditorRepository.getState().saveAllFiles().catch(() => {})
					break
				case 'close-tab': {
					const { activeFile, closeFile } = useEditorRepository.getState()
					if (activeFile) closeFile(activeFile)
					break
				}
				case 'close-all-tabs':
					useEditorRepository.getState().closeAllFiles()
					break
				case 'settings':
					useLayoutStore.getState().setViewMode('settings')
					break

				// Edit
				case 'find':
					bridge.runAction('actions.find')
					break
				case 'replace':
					bridge.runAction('editor.action.startFindReplaceAction')
					break
				case 'find-in-files':
					dispatch('search:open')
					break
				case 'toggle-comment':
					bridge.runAction('editor.action.commentLine')
					break
				case 'format-document':
					bridge.runAction('editor.action.formatDocument')
					break

					// View
				case 'command-palette':
				case 'open-command-palette':
					dispatch('command:palette')
					break
				case 'quick-open':
				case 'go-to-file':
					dispatch('quickopen:toggle')
					break
				case 'view-chat':
					useLayoutStore.getState().setViewMode('chat')
					break
				case 'view-editor':
					useLayoutStore.getState().setViewMode('editor')
					break
				case 'view-preview':
					useLayoutStore.getState().setViewMode('preview')
					break
				case 'toggle-sidebar':
					dispatch('sidebar:toggle')
					break
				case 'toggle-bottom-panel':
				case 'toggle-terminal':
					dispatch('panel:toggle-bottom')
					break
				case 'split-editor':
					dispatch('editor:split')
					break
				case 'toggle-word-wrap':
					bridge.runAction('editor.action.toggleWordWrap')
					break

				// Go
				case 'go-to-line':
					dispatch('editor:go-to-line')
					break
				case 'go-to-definition':
					bridge.runAction('editor.action.revealDefinition')
					break
				case 'peek-definition':
					bridge.runAction('editor.action.peekDefinition')
					break
				case 'go-to-references':
					bridge.runAction('editor.action.goToReferences')
					break
				case 'go-to-symbol':
					bridge.runAction('editor.action.quickOutline')
					break

				// Help
				case 'documentation':
					import('@tauri-apps/plugin-opener').then(opener => {
						opener.openUrl('https://toquemedia.com/docs')
					}).catch(() => {})
					break
				case 'report-issue':
					dispatch('app:report-issue')
					break
			}
		}

		window.addEventListener('native-menu', onNativeMenu)
		return () => window.removeEventListener('native-menu', onNativeMenu)
	}, [])
}
