import React, { useEffect, useMemo, useRef, useState } from 'react'
import QuickOpenService, { QuickOpenItem } from '../../../services/quickOpenService'
import { useEditorRepository } from '../../../stores/editorStore'

export function useQuickOpen(projectPath: string | undefined) {
	const editorRepo = useEditorRepository()

	const [query, setQuery] = useState('')
	const [focused, setFocused] = useState(false)
	const [highlightIndex, setHighlightIndex] = useState(0)
	const [results, setResults] = useState<QuickOpenItem[]>([])
	const debounceRef = useRef<number | null>(null)
	const searchRef = useRef<HTMLInputElement | null>(null)

	useEffect(function onProjectChange() {
		if (projectPath) {
			QuickOpenService.getInstance().initialize(projectPath).catch(function () { })
		} else {
			QuickOpenService.getInstance().reset().catch(function () { })
		}
		// Clear debounce timer on unmount
		return () => {
			if (debounceRef.current) {
				window.clearTimeout(debounceRef.current)
				debounceRef.current = null
			}
		}
	}, [projectPath])

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

	const visibleResults = useMemo(function pick() {
		const list = Array.isArray(results) ? results : []
		return list.slice(0, 20)
	}, [results])

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

	return {
		query,
		focused,
		highlightIndex,
		visibleResults,
		searchRef,
		handleQueryChange,
		handleInputFocus,
		handleInputBlur,
		handleKeyDown,
		openPath,
	}
}
