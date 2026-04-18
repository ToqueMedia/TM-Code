import { Flex, Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

// UI components
import ActivityBar from './ui/ActivityBar'
import ExplorerPanel from './ui/ExplorerPanel'
import SearchPanel from './ui/SearchPanel'
import BottomPanel from './ui/BottomPanel'
import TitleBar from './ui/TitleBar'
import CommandPalette from './ui/CommandPalette'
import TabContextMenu from './ui/TabContextMenu'
import { EditorContextMenu } from './editor'
import PreferencesDialog from './dialogs/PreferencesDialog'
import StatusBar from './ui/StatusBar'
import NetworkStatusBanner from './ui/NetworkStatusBanner'
import ChatPanel from './chat/ChatPanel'
import { ErrorBoundary } from './ErrorBoundary'

// Editor sub-components
import {
	FallbackPanel,
	EditorWorkspace,
	SourceControlPanel,
	RunDebugPanel,
	ExtensionsPanel,
	useCodeEditorLayout,
} from './editor'

export function CodeEditorNew() {
	const {
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
	} = useCodeEditorLayout()

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
			bg={tokens.colors.bg.app}
			color={tokens.colors.text.primary}
			borderRadius={12}
			height="100vh"
			overflow="hidden"
			fontFamily={tokens.fontFamily.ui}
		>
			<TitleBar />
			<TabContextMenu />
			<EditorContextMenu />
			<PreferencesDialog />
			<NetworkStatusBanner />

			{/* Main Content Area */}
			<Flex flex="1" overflow="hidden" minW={0}>
				{/* Activity Bar */}
				<ActivityBar
					activeActivity={activeActivity}
					onActivityChange={handleActivityChange}
				/>

				{/* Sidebar Panel */}
				<Box
					width={`${explorerWidth}px`}
					bg={tokens.colors.bg.sidebar}
					height="100%"
					position="relative"
					borderRight={`1px solid ${tokens.colors.border.default}`}
					ref={sidebarRef}
				>
					{renderSidebarPanel()}
					{/* Resize handle */}
					<Box
						position="absolute"
						right="-2px"
						top="0"
						bottom="0"
						width="4px"
						cursor="col-resize"
						bg="transparent"
						_hover={{
							bg: tokens.colors.accent.primary,
							opacity: 0.5,
						}}
						onPointerDown={handleExplorerResizeStart}
						zIndex={10}
						ref={sidebarHandleRef}
						style={{ touchAction: 'none' }}
						transition={`background ${tokens.transition.fast}`}
					/>
				</Box>

				{/* Chat + Editor Area */}
				<Flex flex="1" overflow="hidden" minW={0}>
					{showChatPanel && (
						<ErrorBoundary>
							<ChatPanel />
						</ErrorBoundary>
					)}

					{showEditorPanel && (
						<ErrorBoundary>
							<EditorWorkspace
								openFiles={openFiles}
								activeFile={activeFile}
								projectPath={currentProject.path}
								editorRef={editorRef}
								onSetActiveFile={handleSetActiveFile}
								onCloseFile={handleCloseFile}
								onCursorPositionChange={handleCursorPositionChange}
							/>
						</ErrorBoundary>
					)}

					{!showChatPanel && !showEditorPanel && <FallbackPanel />}
				</Flex>
			</Flex>

			<CommandPalette />

			{/* Bottom Panel */}
			{isBottomPanelVisible && (
				<Box
					height={`${bottomDefaultSize}px`}
					bg={tokens.colors.bg.terminal}
					position="relative"
					borderTop={`1px solid ${tokens.colors.border.default}`}
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

export default CodeEditorNew
