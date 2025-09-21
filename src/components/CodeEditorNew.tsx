import React, { useState, useEffect, useRef, memo, useCallback, useMemo, Suspense, lazy } from 'react'
import {
	Flex,
	Text,
	HStack,
	IconButton,
	Box,
	Separator,
	Spinner
} from '@chakra-ui/react'
import {
	FiChevronLeft,
	FiChevronRight
} from 'react-icons/fi'

const STORAGE_KEY_BOTTOM_VISIBLE = 'panel-visible-bottom-panel'
const STORAGE_KEY_EXPLORER_WIDTH = 'panel-size-explorer-panel'

// Importar componentes
import ActivityBar from './ui/ActivityBar'
import ExplorerPanel from './ui/ExplorerPanel'
import SearchPanel from './ui/SearchPanel'
import BottomPanel from './ui/BottomPanel'
import Breadcrumbs from './ui/Breadcrumbs'
import DebuggerPanel from './DebuggerPanel'
import TitleBar from './ui/TitleBar'
import CommandPalette from './ui/CommandPalette'
import TabContextMenu from './ui/TabContextMenu'
import PreferencesDialog from './dialogs/PreferencesDialog'
import EditorTabs from './ui/EditorTabs'
import StatusBar from './ui/StatusBar'
import { autoSaveProjectState, useProjectStore } from '../stores/projectStore'
import { useEditorRepository } from '../stores/editorStore'
import { useCurrentProject } from '../hooks/useProjectState'
import { useCodeEditorState } from '../hooks/useEditorState'
import TypeScriptLspService from '../services/typescriptLspService'
import RecoveryService from '../services/recoveryService'
import WindowService from '../services/windowService'
import { useSettingsStore } from '../stores/settingsStore'
import MonacoBridge from '../utils/monacoBridge'
import { FiCode } from 'react-icons/fi'

// Lazy load componentes pesados
const MonacoEditor = lazy(() => import('./ui/MonacoEditor'))


// Loading fallbacks
const EditorSkeleton = () => (
	<Flex
		flex={1}
		align="center"
		justify="center"
		direction="column"
		gap={2}
	>
		<Spinner size="lg" />
		<Text fontSize="sm" color="text.muted">Loading editor...</Text>
	</Flex>
)

// Status bar item component - Enhanced with animations
const StatusBarItem = memo<{ children: React.ReactNode; tooltip?: string }>(({ 
	children,
	tooltip
}) => (
	<Box
		px={3}
		py={1}
		fontSize="xs"
		fontWeight="medium"
		cursor="pointer"
		position="relative"
		_hover={{
			bg: 'whiteAlpha.100',
			transform: 'translateY(-1px)',
			_after: {
				opacity: 1,
				transform: 'scaleX(1)',
			}
		}}
		transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
		display="flex"
		alignItems="center"
		gap={1}
		title={tooltip}
		_after={{
			content: '""',
			position: 'absolute',
			bottom: 0,
			left: '50%',
			transform: 'translateX(-50%) scaleX(0)',
			width: '80%',
			height: '2px',
			bg: 'blue.400',
			opacity: 0,
			transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
		}}
	>
		{children}
	</Box>
))

StatusBarItem.displayName = 'StatusBarItem'

// Enhanced Window Controls with glowing effects
const XcodeWindowControls = memo(() => (
	<HStack gap={2} pl={4}>
		<Box
			w="12px"
			h="12px"
			borderRadius="full"
			bg="#ff5f57"
			cursor="pointer"
			position="relative"
			boxShadow="0 0 0 0 rgba(255, 95, 87, 0.4)"
			_hover={{
				bg: "#ff4136",
				transform: 'scale(1.2)',
				boxShadow: '0 0 8px rgba(255, 95, 87, 0.6)',
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_active={{
				transform: 'scale(0.95)',
			}}
		/>
		<Box
			w="12px"
			h="12px"
			borderRadius="full"
			bg="#ffbd2e"
			cursor="pointer"
			position="relative"
			boxShadow="0 0 0 0 rgba(255, 189, 46, 0.4)"
			_hover={{
				bg: "#ff9500",
				transform: 'scale(1.2)',
				boxShadow: '0 0 8px rgba(255, 189, 46, 0.6)',
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_active={{
				transform: 'scale(0.95)',
			}}
		/>
		<Box
			w="12px"
			h="12px"
			borderRadius="full"
			bg="#28ca42"
			cursor="pointer"
			position="relative"
			boxShadow="0 0 0 0 rgba(40, 202, 66, 0.4)"
			_hover={{
				bg: "#00d600",
				transform: 'scale(1.2)',
				boxShadow: '0 0 8px rgba(40, 202, 66, 0.6)',
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_active={{
				transform: 'scale(0.95)',
			}}
		/>
	</HStack>
))

XcodeWindowControls.displayName = 'XcodeWindowControls'

// Enhanced Navigation Controls with smooth transitions
const XcodeNavigation = memo(() => (
	<HStack gap={1} ml={4}>
		<IconButton
			aria-label="Go back"
			variant="ghost"
			size="sm"
			color="#8e8e93"
			position="relative"
			overflow="hidden"
			_hover={{
				color: "#ffffff",
				bg: "whiteAlpha.100",
				transform: 'translateX(-2px)',
				_before: {
					transform: 'translateX(0)',
				}
			}}
			_active={{
				transform: 'translateX(-4px) scale(0.95)',
			}}
			borderRadius="6px"
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_before={{
				content: '""',
				position: 'absolute',
				top: '50%',
				left: '50%',
				transform: 'translate(-50%, -50%) translateX(-100%)',
				width: '100%',
				height: '100%',
				bg: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
				transition: 'transform 0.6s',
			}}
		>
			<FiChevronLeft size={16} />
		</IconButton>
		<IconButton
			aria-label="Go forward"
			variant="ghost"
			size="sm"
			color="#8e8e93"
			position="relative"
			overflow="hidden"
			_hover={{
				color: "#ffffff",
				bg: "whiteAlpha.100",
				transform: 'translateX(2px)',
				_before: {
					transform: 'translateX(0)',
				}
			}}
			_active={{
				transform: 'translateX(4px) scale(0.95)',
			}}
			borderRadius="6px"
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_before={{
				content: '""',
				position: 'absolute',
				top: '50%',
				left: '50%',
				transform: 'translate(-50%, -50%) translateX(-100%)',
				width: '100%',
				height: '100%',
				bg: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
				transition: 'transform 0.6s',
			}}
		>
			<FiChevronRight size={16} />
		</IconButton>
	</HStack>
))

XcodeNavigation.displayName = 'XcodeNavigation'

// Xcode Project Status
const XcodeProjectStatus = memo<{ projectName: string; isRunning: boolean }>(({ projectName, isRunning }) => (
	<Flex align="center" gap={3}>
		<Text fontSize="sm" fontWeight="600" color="#ffffff">
			{projectName}
		</Text>
		<Text fontSize="xs" color="#8e8e93">v1.0.4</Text>
		<Separator orientation="vertical" height="16px" />
		<HStack gap={1}>
			<Box
				w="8px"
				h="8px"
				borderRadius="full"
				bg={isRunning ? "#28ca42" : "#8e8e93"}
			/>
			<Text fontSize="xs" color="#8e8e93">
				{isRunning ? "Running 1 of 2 tasks" : "Ready"}
			</Text>
		</HStack>
		<HStack gap={1}>
			<Box w="8px" h="8px" borderRadius="full" bg="#ff9500" />
			<Text fontSize="xs" color="#8e8e93">4</Text>
		</HStack>
		<HStack gap={1}>
			<Box w="8px" h="8px" borderRadius="full" bg="#ff3b30" />
			<Text fontSize="xs" color="#8e8e93">12</Text>
		</HStack>
	</Flex>
))

XcodeProjectStatus.displayName = 'XcodeProjectStatus'

export function CodeEditorNew() {
	const currentProject = useCurrentProject()
	const {
		openFiles,
		activeFile,
		handleFileSelect,
		handleCloseFile,
		handleSetActiveFile
	} = useCodeEditorState()

	// Singletons com ref para evitar re-criações
	const lspServiceRef = useMemo(() => TypeScriptLspService.getInstance(), [])
	const recoveryServiceRef = useMemo(() => RecoveryService.getInstance(), [])
	const windowServiceRef = useMemo(() => WindowService.getInstance(), [])

	// Estados locais da UI
	const [activeActivity, setActiveActivity] = useState('explorer')
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

	// Handlers memoizados
	const handleCursorPositionChange = useCallback((line: number, column: number) => {
		setCursorPosition({ line, column })
	}, [])

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
				console.error('Failed to initialize services:', error)
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

	useEffect(() => {
		function onToggleEvent() {
			toggleBottomPanel()
		}
		window.addEventListener('panel:toggle-bottom', onToggleEvent)
		return () => {
			window.removeEventListener('panel:toggle-bottom', onToggleEvent)
		}
	}, [toggleBottomPanel])
	// Render sidebar panel based on active activity
	const renderSidebarPanel = () => {
		switch (activeActivity) {
			case 'explorer':
				return <ExplorerPanel onFileSelect={handleFileSelect} />
			case 'search':
				return <SearchPanel onFileSelect={handleFileSelect} />
			case 'source-control':
				return <SourceControlPanel />
			case 'run-debug':
				return <RunDebugPanel />
			case 'extensions':
				return <ExtensionsPanel />
			default:
				return <ExplorerPanel onFileSelect={handleFileSelect} />
		}
	}

	if (!currentProject) {
		return null
	}

	return (
		<Flex
			direction="column"
			flex="1"
			bg="#1e1e1e"
			color="#ffffff"
			borderRadius={12}
			height="100vh"
			overflow="hidden"
			fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif"
		>
			<TitleBar />
			<TabContextMenu />
			<PreferencesDialog />

			{/* Main Content Area */}
			<Flex flex="1" overflow="hidden" minW={0}>
				{/* Enhanced Activity Bar with glow effects */}
				<Box position="relative">
					<ActivityBar
						activeActivity={activeActivity}
						onActivityChange={handleActivityChange}
					/>
				</Box>

				{/* Enhanced Sidebar Panel with smooth transitions */}
				<Box
					width={`${explorerWidth}px`}
					bg="bg.sidebar"
					height="100%"
					position="relative"
					borderRight="1px solid"
					borderColor="gray.700"
					ref={sidebarRef}
				>
					{renderSidebarPanel()}
					<Box
						position="absolute"
						right="0"
						top="0"
						bottom="0"
						width="6px"
						cursor="col-resize"
						bg="transparent"
						_hover={{ bg: 'whiteAlpha.200' }}
						onPointerDown={handleExplorerResizeStart}
						zIndex={10}
						ref={sidebarHandleRef}
						style={{ touchAction: 'none' }}
					/>
				</Box>

				{/* Editor Area */}
				<Flex
					flex="1"
					bg="bg.editor"
					direction="column"
					ref={editorRef}
					minW={0}
				>
					<EditorTabs
						openFiles={openFiles}
						activeFile={activeFile}
						onSetActiveFile={handleSetActiveFile}
						onCloseFile={handleCloseFile}
					/>

					{/* Breadcrumbs */}
					<Breadcrumbs
						filePath={activeFile || undefined}
						projectRoot={currentProject.path}
						onNavigate={(path) => console.log('Navigate to:', path)}
					/>

					{/* Editor Content */}
					<Flex flex="1" overflow="hidden" onContextMenu={async (e) => {
						e.preventDefault()
						const items: { label: string, action: () => void }[] = []
						// Edit actions (Monaco)
						const bridge = (await import('../utils/monacoBridge')).default.getInstance()
						items.push({ label: 'Copy', action: () => bridge.trigger('editor.action.clipboardCopyAction') })
						items.push({ label: 'Cut', action: () => bridge.trigger('editor.action.clipboardCutAction') })
						items.push({ label: 'Paste', action: () => bridge.trigger('editor.action.clipboardPasteAction') })
						items.push({ label: 'Select All', action: () => bridge.trigger('editor.action.selectAll') })
						items.push({
							label: 'Format Document', action: () => {
								try { MonacoBridge.getInstance().trigger('editor.action.formatDocument') } catch { }
							}
						})
						items.push({ label: '—', action: () => { } })
						items.push({ label: 'Command Palette…', action: () => window.dispatchEvent(new CustomEvent('command:palette')) })
						items.push({ label: 'Quick Open', action: () => window.dispatchEvent(new CustomEvent('quickopen:toggle')) })
						items.push({ label: 'Toggle Bottom Panel', action: () => window.dispatchEvent(new CustomEvent('panel:toggle-bottom')) })
						if (activeFile) {
							const filePath = activeFile
							items.push({ label: '—', action: () => { } })
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
							if (currentProject) {
								const rel = filePath.startsWith(currentProject.path) ? filePath.slice(currentProject.path.length + 1) : filePath
								items.push({ label: 'Copy Relative Path', action: async () => { try { await navigator.clipboard.writeText(rel) } catch { } } })
							}
						}
						// Render menu overlay
						const menu = document.createElement('div')
						Object.assign(menu.style, {
							position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px', zIndex: '3000',
							background: '#2d2d30', border: '1px solid #3c3c3c', borderRadius: '8px', minWidth: '220px', boxShadow: '0 12px 40px rgba(0,0,0,0.5)'
						} as CSSStyleDeclaration)
						items.forEach(it => {
							const row = document.createElement('div')
							if (it.label === '—') {
								Object.assign(row.style, { height: '1px', background: '#3c3c3c', margin: '4px 0' } as CSSStyleDeclaration)
							} else {
								row.textContent = it.label
								Object.assign(row.style, { padding: '8px 12px', color: '#e6e6e6', cursor: 'default' } as CSSStyleDeclaration)
								row.onmouseenter = () => { row.style.background = '#094771' }
								row.onmouseleave = () => { row.style.background = 'transparent' }
								row.onclick = () => { try { it.action() } finally { document.body.removeChild(menu) } }
							}
							menu.appendChild(row)
						})
						const dismiss = () => { if (menu.parentNode) { document.body.removeChild(menu) } document.removeEventListener('mousedown', dismiss) }
						document.addEventListener('mousedown', dismiss)
						document.body.appendChild(menu)
					}}>
						{activeFile ? (
							<Suspense fallback={<EditorSkeleton />}>
								<MonacoEditor
									key={activeFile || 'no-file'}
									path={activeFile}
									onCursorPositionChange={handleCursorPositionChange}
								/>
							</Suspense>
						) : (
							<Flex
								flex="1"
								alignItems="center"
								justifyContent="center"
								bg="bg.editor"
								direction="column"
								p={8}
								position="relative"
								overflow="hidden"
							>
								<Box
									position="relative"
									transform="translateY(0px)"
									transition="transform 0.3s ease"
									_hover={{
										transform: 'translateY(-10px)',
									}}
								>
									<FiCode
										size={64}
										color="#58a6ff"
										style={{
											filter: 'drop-shadow(0 0 20px rgba(88, 166, 255, 0.3))',
										}}
									/>
								</Box>
								<Text
									mt={4}
									fontSize="xl"
									color="text.primary"
									fontWeight="600"
									opacity={0}
									animation="fadeIn 0.8s ease-out forwards"
									animationDelay="0.2s"
								>
									Welcome to ToqueMedia Studio
								</Text>
								<Text
									mt={2}
									fontSize="sm"
									color="text.muted"
									textAlign="center"
									maxW="400px"
									opacity={0}
									animation="fadeIn 1s ease-out forwards"
									animationDelay="0.4s"
								>
									Open a file from the explorer or create a new file to start coding.
								</Text>
								<Box
									position="absolute"
									top="50%"
									left="50%"
									transform="translate(-50%, -50%)"
									width="200%"
									height="200%"
									opacity={0.03}
									pointerEvents="none"
									bg="radial-gradient(circle at center, #58a6ff 0%, transparent 70%)"
								/>
							</Flex>
						)}
					</Flex>
				</Flex>
			</Flex>

			<CommandPalette />

			{/* Bottom Panel */}
			{isBottomPanelVisible && (
				<Box
					height={`${bottomDefaultSize}px`}
					bg="bg.terminal"
					position="relative"
					borderTop="1px solid"
					borderColor="gray.700"
				>
					<BottomPanel
						isVisible={isBottomPanelVisible}
						onToggle={toggleBottomPanel}
						onClose={closeBottomPanel}
					/>
				</Box>
			)}

			<StatusBar
				currentProject={currentProject}
				activeFile={activeFile}
				openFiles={openFiles}
				cursorPosition={cursorPosition}
				languages={languages}
				tabSizeSetting={tabSizeSetting}
				insertSpacesSetting={insertSpacesSetting}
				detectIndentationSetting={detectIndentationSetting}
				setTabSizeSetting={setTabSizeSetting}
				setInsertSpacesSetting={setInsertSpacesSetting}
				setDetectIndentationSetting={setDetectIndentationSetting}
			/>
		</Flex>
	)
}

// Placeholder components for missing panels

const SourceControlPanel = memo(() => (
	<Box p={4} color="text.muted">
		<Text fontSize="sm">Source control panel coming soon...</Text>
	</Box>
))

const RunDebugPanel = memo(() => {
	const [isDebuggerVisible, setIsDebuggerVisible] = useState(false)

	useEffect(() => {
		const handleOpenDebugger = () => {
			setIsDebuggerVisible(true)
		}

		window.addEventListener('debugger:open', handleOpenDebugger)

		return () => {
			window.removeEventListener('debugger:open', handleOpenDebugger)
		}
	}, [])

	return (
		<>
			<Box p={4} color="text.muted">
				<Text fontSize="sm" mb={3}>Debug panel</Text>
				<Text fontSize="xs" color="text.muted" mb={3}>
					Press Ctrl+Shift+D to open debugger
				</Text>
				<button
					onClick={() => setIsDebuggerVisible(true)}
					style={{
						padding: '8px 16px',
						backgroundColor: '#0969da',
						color: 'white',
						border: 'none',
						borderRadius: '6px',
						cursor: 'pointer'
					}}
				>
					Open Debugger
				</button>
			</Box>

			<DebuggerPanel
				isVisible={isDebuggerVisible}
				onClose={() => setIsDebuggerVisible(false)}
			/>
		</>
	)
})

const ExtensionsPanel = memo(() => (
	<Box p={4} color="text.muted">
		<Text fontSize="sm">Extensions panel coming soon...</Text>
	</Box>
))

SourceControlPanel.displayName = 'SourceControlPanel'
RunDebugPanel.displayName = 'RunDebugPanel'
ExtensionsPanel.displayName = 'ExtensionsPanel'

export default CodeEditorNew