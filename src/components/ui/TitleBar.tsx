import { useEffect } from 'react'
import { Box, HStack, Flex } from '@chakra-ui/react'
import { useProjectStore } from '../../stores/projectStore'
import WindowControls from './WindowControls'
import ProjectMenu from './ProjectMenu'
import MenuBar from './titlebar/MenuBar'
import QuickOpen from './QuickOpen'
import { tokens } from '@/theme/tokens'
import { handleClose, handleMinimize, handleFullToggle, handleMouseDown } from './titlebar/useWindowControls'
import { useQuickOpen } from './titlebar/useQuickOpen'
import { IS_MAC } from '../../utils/platform'

// NOTE: this is the legacy full title bar. MainLayout actually renders
// MinimalTitleBar — that's where the Publish button + Cmd+Shift+D shortcut
// live. Keep this file in sync with MinimalTitleBar's affordances if the
// product ever re-introduces the wide title bar.

function TitleBar() {
	const { currentProject, recentProjects, loadRecentProjects, openProject } = useProjectStore()

	const {
		query,
		focused,
		highlightIndex,
		visibleResults,
		handleQueryChange,
		handleInputFocus,
		handleInputBlur,
		handleKeyDown,
		openPath,
	} = useQuickOpen(currentProject?.path)

	useEffect(function loadRecents() {
		loadRecentProjects().catch(function () { })
	}, [loadRecentProjects])

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

	return (
		<Flex
			className="vscode-titlebar drag-region"
			height="38px"
			bg={tokens.colors.bg.titlebar}
			borderBottom={`1px solid ${tokens.colors.border.default}`}
			alignItems="center"
			px={3}
			userSelect="none"
			backdropFilter="blur(12px)"
			data-tauri-drag-region
			onMouseDown={handleMouseDown}
		>
			{/* Left: traffic lights (macOS) + project + menus */}
			<HStack
				gap={2}
				flexShrink={0}
				align="center"
				data-tauri-drag-region="false"
			>
				{IS_MAC && (
					<WindowControls
						onClose={handleClose}
						onMinimize={handleMinimize}
						onMaximize={handleFullToggle}
					/>
				)}
				<ProjectMenu
					currentProjectName={currentProject?.name}
					recentProjects={recentProjects}
					onOpenFolder={handleOpenFolder}
					onCloneRepo={handleCloneRepo}
					onOpenRecent={handleOpenRecent}
				/>
				<MenuBar />
			</HStack>

			{/* Center: Quick Open — takes remaining space */}
			<Flex
				flex={1}
				justifyContent="center"
				alignItems="center"
				px={2}
				minW={0}
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

			{/* Right: window controls (Windows/Linux) or spacer (macOS) */}
			{IS_MAC ? (
				<Box width="70px" flexShrink={0} />
			) : (
				<HStack flexShrink={0} data-tauri-drag-region="false">
					<WindowControls
						onClose={handleClose}
						onMinimize={handleMinimize}
						onMaximize={handleFullToggle}
					/>
				</HStack>
			)}
		</Flex>
	)
}

export default TitleBar
