import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { autoSaveProjectState, useProjectStore } from '../../stores/projectStore'
import { useEditorRepository } from '../../stores/editorStore'
import { useCurrentProject } from '../../hooks/useProjectState'
import { useCodeEditorState } from '../../hooks/useEditorState'
import { useSettingsStore } from '../../stores/settingsStore'
import TypeScriptLspService from '../../services/typescriptLspService'
import RecoveryService from '../../services/recoveryService'
import WindowService from '../../services/windowService'
import { logger } from '../../utils/logger'

const STORAGE_KEY_BOTTOM_VISIBLE = 'panel-visible-bottom-panel'
const STORAGE_KEY_EXPLORER_WIDTH = 'panel-size-explorer-panel'

export function useCodeEditorLayout() {
	const currentProject = useCurrentProject()
	const {
		openFiles,
		activeFile,
		handleFileSelect,
		handleCloseFile,
		handleSetActiveFile
	} = useCodeEditorState()

	// Singletons com ref para evitar re-criacoes
	const lspServiceRef = useMemo(() => TypeScriptLspService.getInstance(), [])
	const recoveryServiceRef = useMemo(() => RecoveryService.getInstance(), [])
	const windowServiceRef = useMemo(() => WindowService.getInstance(), [])

	// Estados locais da UI
	const [activeActivity, setActiveActivity] = useState('chat')
	const [showChatPanel, setShowChatPanel] = useState(true)
	const [showEditorPanel, setShowEditorPanel] = useState(false)

	// Editor indentation settings
	const tabSizeSetting = useSettingsStore(function (s) { return s.editor.tabSize })
	const insertSpacesSetting = useSettingsStore(function (s) { return s.editor.insertSpaces })
	const setInsertSpacesSetting = useSettingsStore(function (s) { return s.setInsertSpaces })
	const setTabSizeSetting = useSettingsStore(function (s) { return s.setTabSize })
	const detectIndentationSetting = useSettingsStore(function (s) { return s.editor.detectIndentation })
	const setDetectIndentationSetting = useSettingsStore(function (s) { return s.setDetectIndentation })

	const [isBottomPanelVisible, setIsBottomPanelVisible] = useState<boolean>(() => {
		try {
			const v = localStorage.getItem(STORAGE_KEY_BOTTOM_VISIBLE)
			return v === null ? true : v === 'true'
		} catch {
			return true
		}
	})
	const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 })
	const [languages, setLanguages] = useState<string[]>([])
	const [windowHeight, setWindowHeight] = useState(window.innerHeight)
	const [explorerWidth, setExplorerWidth] = useState<number>(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY_EXPLORER_WIDTH)
			const screen = window.innerWidth
			const min = 40
			const max = Math.max(100, screen - 360)
			const def = Math.min(300, Math.max(Math.floor(screen * 0.25), min))
			const initial = saved ? parseInt(saved, 10) : def
			return Math.min(Math.max(initial, min), max)
		} catch {
			return 300
		}
	})
	const [, setIsResizingExplorer] = useState(false)

	// Refs para elementos DOM
	const editorRef = useRef<HTMLDivElement>(null)
	const sidebarRef = useRef<HTMLDivElement>(null)
	const sidebarHandleRef = useRef<HTMLDivElement>(null)

	// Show editor panel when a file is opened
	useEffect(() => {
		if (activeFile && !showEditorPanel) {
			setShowEditorPanel(true)
		}
	}, [activeFile])

	// Handlers memoizados
	const handleCursorPositionChange = useCallback((line: number, column: number) => {
		setCursorPosition({ line, column })
		// Persist to store for cursor restoration on tab switch
		if (activeFile) {
			useEditorRepository.getState().setCursorPosition(activeFile, line, column)
		}
	}, [activeFile])

	// Toggle bottom panel visibility
	const toggleBottomPanel = useCallback(() => {
		setIsBottomPanelVisible(prev => {
			const newValue = !prev
			try {
				localStorage.setItem(STORAGE_KEY_BOTTOM_VISIBLE, String(newValue))
			} catch { }
			return newValue
		})
	}, [])

	// Close bottom panel
	const closeBottomPanel = useCallback(() => {
		setIsBottomPanelVisible(false)
		try {
			localStorage.setItem(STORAGE_KEY_BOTTOM_VISIBLE, 'false')
		} catch { }
	}, [])

	// Handle activity change
	const handleActivityChange = useCallback((activity: string) => {
		if (activity === 'toggle-bottom-panel') {
			toggleBottomPanel()
			return
		}
		if (activity === 'chat') {
			setShowChatPanel(prev => !prev)
			setActiveActivity('chat')
			return
		}
		if (activity === 'editor') {
			setShowEditorPanel(prev => !prev)
			setActiveActivity('editor')
			return
		}
		setActiveActivity(activity)
	}, [toggleBottomPanel])

	// Initialize services when project is opened
	useEffect(() => {
		if (!currentProject) {
			lspServiceRef.reset()
			recoveryServiceRef.stopRecoveryMonitoring()
			windowServiceRef.reset()
			return
		}

		const abortController = new AbortController()
		const { signal } = abortController

		const initializeServices = async () => {
			try {
				await lspServiceRef.initialize(currentProject.path)
				recoveryServiceRef.startRecoveryMonitoring()
				await windowServiceRef.initialize()
			} catch (error) {
				logger.error('editor', 'Failed to initialize services:', error)
			}
		}

		initializeServices()

		const handleWindowStateChange = (event: CustomEvent) => {
			if (!signal.aborted) {
				useProjectStore.getState().setWindowState(event.detail)
			}
		}

		window.addEventListener('windowStateChange', handleWindowStateChange as EventListener, { signal })

		return () => {
			abortController.abort()
			lspServiceRef.reset()
			recoveryServiceRef.stopRecoveryMonitoring()
			windowServiceRef.reset()
		}
	}, [currentProject, lspServiceRef, recoveryServiceRef, windowServiceRef])

	useEffect(() => {
		function onLanguages(e: Event) {
			const ce = e as CustomEvent<string[]>
			if (Array.isArray(ce.detail)) setLanguages(ce.detail)
		}
		window.addEventListener('monaco:languages', onLanguages)
		return () => window.removeEventListener('monaco:languages', onLanguages)
	}, [])

	// Window resize listener for responsive panel sizing
	useEffect(() => {
		function handleResize() {
			setWindowHeight(window.innerHeight)
			const min = 40
			const max = Math.max(100, window.innerWidth - 360)
			setExplorerWidth(prev => Math.min(Math.max(prev, min), max))
		}

		window.addEventListener('resize', handleResize)
		return () => window.removeEventListener('resize', handleResize)
	}, [])

	// Save project state periodically
	useEffect(() => {
		if (!currentProject) return

		const unsubscribe = useEditorRepository.subscribe(() => {
			autoSaveProjectState()
		})

		return unsubscribe
	}, [currentProject])

	// Handle window close event
	useEffect(() => {
		const abortController = new AbortController()

		const handleBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault()
			e.returnValue = ''
			return ''
		}

		window.addEventListener('beforeunload', handleBeforeUnload, {
			signal: abortController.signal
		})

		return () => {
			abortController.abort()
		}
	}, [])

	useEffect(() => {
		function onToggleEvent() {
			toggleBottomPanel()
		}
		window.addEventListener('panel:toggle-bottom', onToggleEvent)
		return () => {
			window.removeEventListener('panel:toggle-bottom', onToggleEvent)
		}
	}, [toggleBottomPanel])

	// Calculate dynamic bottom panel sizes (15% - 60% of screen height)
	const bottomMinSize = Math.floor(windowHeight * 0.15)
	const bottomDefaultSize = Math.min(250, Math.max(bottomMinSize, Math.floor(windowHeight * 0.25)))

	function handleExplorerResizeStart(e: React.PointerEvent) {
		e.preventDefault()
		const handleEl = sidebarHandleRef.current
		const sidebarLeft = sidebarRef.current ? sidebarRef.current.getBoundingClientRect().left : 0
		let current = explorerWidth

		const pid = e.pointerId
		try { handleEl?.setPointerCapture(pid) } catch { }

		const body = document.body
		const prevCursor = body.style.cursor
		const prevUserSelect = body.style.userSelect
		body.style.cursor = 'col-resize'
		body.style.userSelect = 'none'
		setIsResizingExplorer(true)

		function onPointerMove(pe: PointerEvent) {
			const min = 40
			const max = Math.max(100, window.innerWidth - 360)
			let next = pe.clientX - sidebarLeft
			if (next < min) next = min
			if (next > max) next = max
			current = next
			setExplorerWidth(next)
		}

		function onPointerUp() {
			try { localStorage.setItem(STORAGE_KEY_EXPLORER_WIDTH, String(current)) } catch { }
			try { handleEl?.releasePointerCapture(pid) } catch { }
			handleEl?.removeEventListener('pointermove', onPointerMove)
			handleEl?.removeEventListener('pointerup', onPointerUp)
			body.style.cursor = prevCursor
			body.style.userSelect = prevUserSelect
			setIsResizingExplorer(false)
		}

		handleEl?.addEventListener('pointermove', onPointerMove)
		handleEl?.addEventListener('pointerup', onPointerUp)
	}

	return {
		currentProject,
		openFiles,
		activeFile,
		handleFileSelect,
		handleCloseFile,
		handleSetActiveFile,
		activeActivity,
		showChatPanel,
		showEditorPanel,
		isBottomPanelVisible,
		cursorPosition,
		languages,
		explorerWidth,
		bottomDefaultSize,
		editorRef,
		sidebarRef,
		sidebarHandleRef,
		handleCursorPositionChange,
		toggleBottomPanel,
		closeBottomPanel,
		handleActivityChange,
		handleExplorerResizeStart,
		tabSizeSetting,
		insertSpacesSetting,
		detectIndentationSetting,
		setTabSizeSetting,
		setInsertSpacesSetting,
		setDetectIndentationSetting,
	}
}
