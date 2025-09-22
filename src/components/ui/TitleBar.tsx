import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, HStack, Flex } from '@chakra-ui/react'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useProjectStore } from '../../stores/projectStore'
import { useEditorRepository } from '../../stores/editorStore'
import QuickOpenService, { QuickOpenItem } from '../../services/quickOpenService'
import WindowControls from './WindowControls'
import ProjectMenu from './ProjectMenu'
import QuickOpen from './QuickOpen'

function TitleBar() {
	const { currentProject, recentProjects, loadRecentProjects, openProject } = useProjectStore()
	const editorRepo = useEditorRepository()

	const [query, setQuery] = useState('')
	const [focused, setFocused] = useState(false)
	const [highlightIndex, setHighlightIndex] = useState(0)
	const [results, setResults] = useState<QuickOpenItem[]>([])
	const debounceRef = useRef<number | null>(null)
	const searchRef = useRef<HTMLInputElement | null>(null)

	useEffect(function onProjectChange() {
		if (currentProject && currentProject.path) {
			QuickOpenService.getInstance().initialize(currentProject.path).catch(function () { })
		} else {
			QuickOpenService.getInstance().reset().catch(function () { })
		}
	}, [currentProject])

	useEffect(function loadRecents() {
		loadRecentProjects().catch(function () { })
	}, [loadRecentProjects])

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
			// navigator.platform is more reliable for detecting macOS UI behavior
			// Fallback to userAgent if needed
			// @ts-ignore
			const plat = (navigator && (navigator.platform || navigator.userAgent)) || ''
			return /Mac/.test(String(plat))
		} catch {
			return false
		}
	}

	async function handleClose(): Promise<void> {
		try {
			const w2 = getCurrentWinV2()
			if (w2) { await w2.close(); return }
			await getCurrentWin().close()
		} catch { }
	}

	async function handleMinimize(): Promise<void> {
		try {
			const w2 = getCurrentWinV2()
			if (w2) { await w2.minimize(); return }
			await getCurrentWin().minimize()
		} catch { }
	}

	async function handleFullToggle(): Promise<void> {
		try {
			const w2 = getCurrentWinV2()
			if (isMacOS()) {
				if (w2) {
					const cur = await w2.isFullscreen()
					await w2.setFullscreen(!cur)
					return
				}
				const w = getCurrentWin() as any
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

	function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>): void {
		const v = e.target.value
		setQuery(v)
		if (debounceRef.current) {
			window.clearTimeout(debounceRef.current)
			debounceRef.current = null
		}
		debounceRef.current = window.setTimeout(function run() {
			if (v.trim().length === 0) {
				setResults([])
				setHighlightIndex(0)
				return
			}
			const svc = QuickOpenService.getInstance()
			const list = svc.search(v, 100)
			setResults(list)
		}, 150)
	}

	function handleInputFocus(): void {
		setFocused(true)
	}

	function handleInputBlur(e: React.FocusEvent<HTMLInputElement>): void {
		const related = e.relatedTarget as HTMLElement | null
		const inOverlay = related && related.dataset && related.dataset.quickOpenItem === 'true'
		if (!inOverlay) {
			setFocused(false)
		}
	}

	function openPath(path: string): void {
		editorRepo.openFile(path).catch(function () { })
		setQuery('')
		setResults([])
		setFocused(false)
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
		if (!results || results.length === 0) return
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setHighlightIndex(Math.min(highlightIndex + 1, Math.min(results.length, 20) - 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setHighlightIndex(Math.max(highlightIndex - 1, 0))
		} else if (e.key === 'Enter') {
			const visible = visibleResults
			if (visible.length > 0) {
				const item = visible[Math.max(0, Math.min(highlightIndex, visible.length - 1))]
				openPath(item.path)
			}
		} else if (e.key === 'Escape') {
			setQuery('')
			setResults([])
			setFocused(false)
		}
	}

	async function handleOpenFolder(): Promise<void> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog')
			const selected = await open({ directory: true, multiple: false, title: 'Select project directory' })
			if (selected) {
				await openProject(String(selected))
			}
		} catch { }
	}

	function handleCloneRepo(): void {

	}

	function handleOpenRecent(path: string): void {
		openProject(path).catch(() => { })
	}

	const visibleResults = useMemo(function pick() {
		const list = Array.isArray(results) ? results : []
		return list.slice(0, 20)
	}, [results])

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

	async function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
		try {
			if (e.button !== 0) return
			const t = e.target as HTMLElement
			if (!shouldStartDrag(t)) return
			const win = getCurrentWindow()
			await win.startDragging()
		} catch { }
	}

	useEffect(function quickOpenToggleListener() {
		function onToggle() {
			try {
				setFocused(true)
				const el = searchRef.current
				if (el) {
					el.focus()
					try { el.select() } catch { }
				}
			} catch { }
		}
		window.addEventListener('quickopen:toggle', onToggle)
		return () => window.removeEventListener('quickopen:toggle', onToggle)
	}, [])

	return (
		<Box
			className="vscode-titlebar drag-region"
			height="35px"
			bg="rgba(50, 50, 51, 0.95)"
			borderBottom="1px solid #1e1f22"
			display="flex"
			alignItems="center"
			px={2}
			position="relative"
			userSelect="none"
			backdropFilter="blur(10px)"
			data-tauri-drag-region
			onMouseDown={handleMouseDown}
		>
			<HStack
				gap={3}
				position="absolute"
				left={8}
			>
				<WindowControls 
					onClose={handleClose}
					onMinimize={handleMinimize}
					onMaximize={handleFullToggle}
				/>
				<ProjectMenu
					currentProjectName={currentProject?.name}
					recentProjects={recentProjects}
					onOpenFolder={handleOpenFolder}
					onCloneRepo={handleCloneRepo}
					onOpenRecent={handleOpenRecent}
				/>
			</HStack>

			<Flex
				flex={1}
				justifyContent="center"
				alignItems="center"
				px={2}
			>
				<QuickOpen
					query={query}
					focused={focused}
					highlightIndex={highlightIndex}
					visibleResults={visibleResults}
					onQueryChange={handleQueryChange}
					onInputFocus={handleInputFocus}
					onInputBlur={handleInputBlur}
					onKeyDown={handleKeyDown}
					onOpenPath={openPath}
					placeholder={currentProject ? `Search in ${currentProject.name}` : 'Search'}
				/>
			</Flex>

			<Box position="absolute" right={3} width="120px" />
		</Box>
	)
}

export default TitleBar
