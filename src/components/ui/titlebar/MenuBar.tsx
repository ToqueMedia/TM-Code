import { memo, useCallback, useEffect, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useEditorRepository } from '@/stores/editorStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSettingsStore } from '@/stores/settingsStore'
import MonacoBridge from '@/utils/monacoBridge'
import ContextMenuOverlay, { type ContextMenuItem } from '../ContextMenuOverlay'
import { t } from '@/i18n'

// ── Types ────────────────────────────────────────────────────────────

interface MenuDef {
	id: string
	label: string
	items: () => ContextMenuItem[]
}

// ── Helpers ──────────────────────────────────────────────────────────

function bridgeRun(actionId: string) {
	MonacoBridge.getInstance().runAction(actionId)
}

function bridgeTrigger(actionId: string) {
	MonacoBridge.getInstance().trigger(actionId)
}

function dispatch(event: string) {
	window.dispatchEvent(new CustomEvent(event))
}

function sep(): ContextMenuItem {
	return { label: '', separator: true }
}

// ── Menu definitions ─────────────────────────────────────────────────

function hasEditor(): boolean {
	return !!MonacoBridge.getInstance().getCurrentEditor()
}

function hasOpenFiles(): boolean {
	return useEditorRepository.getState().openFiles.length > 0
}

function useMenuDefinitions(): MenuDef[] {
	const openProject = useProjectStore(s => s.openProject)
	const formatOnSave = useSettingsStore(s => s.formatOnSave)
	const setFormatOnSave = useSettingsStore(s => s.setFormatOnSave)
	const viewMode = useLayoutStore(s => s.viewMode)
	// Subscribe to language changes so menus re-render
	useSettingsStore(s => s.appLanguage)

	const inEditor = viewMode === 'editor'

	// ── Global menus (all views) ─────────────────────────────────

	const fileMenu: MenuDef = {
		id: 'file',
		label: t('menu.file'),
		items() {
			const list: ContextMenuItem[] = []
			list.push({
				label: t('menu.openFolder'), hint: 'Ctrl+O', async action() {
					try {
						const { open } = await import('@tauri-apps/plugin-dialog')
						const selected = await open({ directory: true, multiple: false, title: t('common.selectProjectDir') })
						if (selected) await openProject(String(selected))
					} catch { }
				}
			})
			if (inEditor) {
				const noEditor = !hasEditor()
				const noFiles = !hasOpenFiles()
				list.push(sep())
				list.push({ label: t('menu.save'), hint: 'Ctrl+S', disabled: noEditor, action() { bridgeRun('tmcode.save') } })
				list.push({
					label: t('menu.saveAll'), hint: 'Ctrl+Alt+S', disabled: noFiles, action() {
						const ed = MonacoBridge.getInstance().getCurrentEditor()
						const { activeFile } = useEditorRepository.getState()
						if (ed && activeFile) {
							const content = ed.getValue()
							useEditorRepository.setState(s => {
								const idx = s.openFiles.findIndex(f => f.path === activeFile)
								if (idx === -1 || s.openFiles[idx].content === content) return s
								const files = [...s.openFiles]
								files[idx] = { ...files[idx], content, isDirty: true }
								return { openFiles: files }
							})
						}
						useEditorRepository.getState().saveAllFiles().catch(() => { })
					}
				})
				list.push(sep())
				list.push({
					label: t('menu.closeTab'), hint: 'Ctrl+W', disabled: noFiles, action() {
						const { activeFile, closeFile } = useEditorRepository.getState()
						if (activeFile) closeFile(activeFile)
					}
				})
				list.push({
					label: t('menu.closeAllTabs'), disabled: noFiles, action() {
						useEditorRepository.getState().closeAllFiles()
					}
				})
				list.push(sep())
				list.push({
					label: formatOnSave ? t('menu.autoFormatOnSave') + '  ✓' : t('menu.autoFormatOnSave'),
					action() { setFormatOnSave(!formatOnSave) }
				})
			}
			list.push(sep())
			list.push({ label: t('menu.settings'), hint: 'Ctrl+,', action() { useLayoutStore.getState().setViewMode('settings') } })
			return list
		},
	}

	const viewMenu: MenuDef = {
		id: 'view',
		label: t('menu.view'),
		items() {
			const list: ContextMenuItem[] = [
				{ label: t('menu.commandPalette'), hint: 'Ctrl+Shift+P', action() { dispatch('command:palette') } },
				{ label: t('menu.quickOpen'), hint: 'Ctrl+P', action() { dispatch('quickopen:toggle') } },
				sep(),
				{ label: t('menu.chat'), action() { useLayoutStore.getState().setViewMode('chat') } },
				{ label: t('menu.editorView'), action() { useLayoutStore.getState().setViewMode('editor') } },
				{ label: t('menu.preview'), action() { useLayoutStore.getState().setViewMode('preview') } },
				sep(),
				{ label: t('menu.toggleSidebar'), hint: 'Ctrl+B', action() { dispatch('sidebar:toggle') } },
				{ label: t('menu.toggleBottomPanel'), hint: 'Ctrl+`', action() { dispatch('panel:toggle-bottom') } },
			]
			if (inEditor) {
				const noEditor = !hasEditor()
				list.push(sep())
				list.push({ label: t('menu.splitEditor'), hint: 'Ctrl+\\', action() { dispatch('editor:split') } })
				list.push(sep())
				list.push({ label: t('menu.toggleWordWrap'), hint: 'Alt+Z', disabled: noEditor, action() { bridgeRun('editor.action.toggleWordWrap') } })
				list.push({ label: t('menu.toggleMinimap'), disabled: noEditor, action() { MonacoBridge.getInstance().toggleOption('minimap') } })
				list.push({ label: t('menu.toggleStickyScroll'), disabled: noEditor, action() { MonacoBridge.getInstance().toggleOption('stickyScroll') } })
				list.push(sep())
				list.push({ label: t('menu.zoomIn'), hint: 'Ctrl+=', disabled: noEditor, action() { bridgeRun('editor.action.fontZoomIn') } })
				list.push({ label: t('menu.zoomOut'), hint: 'Ctrl+-', disabled: noEditor, action() { bridgeRun('editor.action.fontZoomOut') } })
				list.push({ label: t('menu.resetZoom'), hint: 'Ctrl+0', disabled: noEditor, action() { bridgeRun('editor.action.fontZoomReset') } })
			}
			return list
		},
	}

	const terminalMenu: MenuDef = {
		id: 'terminal',
		label: t('menu.terminal'),
		items() {
			return [
				{ label: t('menu.toggleTerminal'), hint: 'Ctrl+`', action() { dispatch('panel:toggle-bottom') } },
			]
		},
	}

	const helpMenu: MenuDef = {
		id: 'help',
		label: t('menu.help'),
		items() {
			return [
				{ label: t('menu.commandPalette'), hint: 'Ctrl+Shift+P', action() { dispatch('command:palette') } },
				sep(),
				{
					label: t('menu.documentation'), async action() {
						try {
							const opener = await import('@tauri-apps/plugin-opener')
							await opener.openUrl('https://toquemedia.com/docs')
						} catch { }
					}
				},
				{
					label: t('menu.reportIssue'), async action() {
						window.dispatchEvent(new CustomEvent('app:report-issue'))
					}
				},
			]
		},
	}

	// ── Editor-only menus ────────────────────────────────────────

	if (!inEditor) {
		return [fileMenu, viewMenu, terminalMenu, helpMenu]
	}

	const editMenu: MenuDef = {
		id: 'edit',
		label: t('menu.edit'),
		items() {
			const noEditor = !hasEditor()
			return [
				{ label: t('menu.undo'), hint: 'Ctrl+Z', disabled: noEditor, action() { bridgeTrigger('undo') } },
				{ label: t('menu.redo'), hint: 'Ctrl+Y', disabled: noEditor, action() { bridgeTrigger('redo') } },
				sep(),
				{ label: t('menu.cut'), hint: 'Ctrl+X', disabled: noEditor, action() { bridgeTrigger('editor.action.clipboardCutAction') } },
				{ label: t('menu.copy'), hint: 'Ctrl+C', disabled: noEditor, action() { bridgeTrigger('editor.action.clipboardCopyAction') } },
				{ label: t('menu.paste'), hint: 'Ctrl+V', disabled: noEditor, action() { bridgeTrigger('editor.action.clipboardPasteAction') } },
				sep(),
				{ label: t('menu.find'), hint: 'Ctrl+F', disabled: noEditor, action() { bridgeRun('actions.find') } },
				{ label: t('menu.replace'), hint: 'Ctrl+H', disabled: noEditor, action() { bridgeRun('editor.action.startFindReplaceAction') } },
				{ label: t('menu.findInFiles'), hint: 'Ctrl+Shift+F', action() { dispatch('search:open') } },
				sep(),
				{ label: t('menu.toggleLineComment'), hint: 'Ctrl+/', disabled: noEditor, action() { bridgeRun('editor.action.commentLine') } },
				{ label: t('menu.toggleBlockComment'), hint: 'Shift+Alt+A', disabled: noEditor, action() { bridgeRun('editor.action.blockComment') } },
				sep(),
				{ label: t('menu.formatDocument'), hint: 'Shift+Alt+F', disabled: noEditor, action() { bridgeRun('editor.action.formatDocument') } },
			]
		},
	}

	const goMenu: MenuDef = {
		id: 'go',
		label: t('menu.go'),
		items() {
			const noEditor = !hasEditor()
			return [
				{ label: t('menu.goToFile'), hint: 'Ctrl+P', action() { dispatch('quickopen:toggle') } },
				{ label: t('menu.goToLine'), hint: 'Ctrl+G', disabled: noEditor, action() { dispatch('editor:go-to-line') } },
				sep(),
				{ label: t('menu.goToDefinition'), hint: 'F12', disabled: noEditor, action() { bridgeRun('editor.action.revealDefinition') } },
				{ label: t('menu.peekDefinition'), hint: 'Alt+F12', disabled: noEditor, action() { bridgeRun('editor.action.peekDefinition') } },
				{ label: t('menu.goToReferences'), hint: 'Shift+F12', disabled: noEditor, action() { bridgeRun('editor.action.goToReferences') } },
				{ label: t('menu.goToTypeDefinition'), disabled: noEditor, action() { bridgeRun('editor.action.goToTypeDefinition') } },
				{ label: t('menu.goToImplementation'), hint: 'Ctrl+F12', disabled: noEditor, action() { bridgeRun('editor.action.goToImplementation') } },
				sep(),
				{ label: t('menu.goToSymbol'), hint: 'Ctrl+Shift+O', disabled: noEditor, action() { bridgeRun('editor.action.quickOutline') } },
			]
		},
	}

	return [fileMenu, editMenu, viewMenu, goMenu, terminalMenu, helpMenu]
}

// ── Platform detection ────────────────────────────────────────────────

const isMacOS = navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac')

// ── MenuBar Component ────────────────────────────────────────────────
// On macOS, native menus are used (set up in Rust). This component only renders on Windows/Linux.

function MenuBar() {
	// macOS uses native menu bar — don't render in-window menus
	if (isMacOS) return null

	const [openMenuId, setOpenMenuId] = useState<string | null>(null)
	const [dropdownPos, setDropdownPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
	const menus = useMenuDefinitions()

	// While a dropdown is open, mask the native preview webview so the dropdown
	// (pure DOM) is visible above it on Windows/Linux, where the wry child
	// webview otherwise sits above CSS z-index.
	useEffect(() => {
		if (!openMenuId) return
		useLayoutStore.getState().pushOverlay()
		return () => {
			useLayoutStore.getState().popOverlay()
		}
	}, [openMenuId])

	const openMenu = useCallback(function open(id: string, el: HTMLElement) {
		const rect = el.getBoundingClientRect()
		setDropdownPos({ x: rect.left, y: rect.bottom + 2 })
		setOpenMenuId(id)
	}, [])

	const closeMenu = useCallback(function close() {
		setOpenMenuId(null)
	}, [])

	function handleMenuClick(id: string, e: React.MouseEvent<HTMLElement>) {
		if (openMenuId === id) {
			closeMenu()
		} else {
			openMenu(id, e.currentTarget)
		}
	}

	function handleMenuHover(id: string, e: React.MouseEvent<HTMLElement>) {
		if (openMenuId && openMenuId !== id) {
			openMenu(id, e.currentTarget)
		}
	}

	const activeMenu = menus.find(m => m.id === openMenuId)

	return (
		<>
			<Flex
				align="center"
				gap={0}
				data-tauri-drag-region="false"
			>
				{menus.map(function renderTrigger(menu) {
					const isActive = openMenuId === menu.id
					return (
						<Box
							key={menu.id}
							px="8px"
							py="3px"
							cursor="default"
							borderRadius="4px"
							bg={isActive ? tokens.colors.menu.hover : 'transparent'}
							_hover={{ bg: tokens.colors.bg.hoverSubtle }}
							onClick={e => handleMenuClick(menu.id, e)}
							onMouseEnter={e => handleMenuHover(menu.id, e)}
							data-tauri-drag-region="false"
							userSelect="none"
						>
							<Text
								fontSize="13px"
								color={isActive ? tokens.colors.text.primary : tokens.colors.text.secondary}
								lineHeight="1.2"
								transition={`color ${tokens.transition.fast}`}
								_hover={{ color: tokens.colors.text.primary }}
							>
								{menu.label}
							</Text>
						</Box>
					)
				})}
			</Flex>

			{openMenuId && activeMenu && (
				<ContextMenuOverlay
					items={activeMenu.items()}
					x={dropdownPos.x}
					y={dropdownPos.y}
					onClose={closeMenu}
				/>
			)}
		</>
	)
}

export default memo(MenuBar)
