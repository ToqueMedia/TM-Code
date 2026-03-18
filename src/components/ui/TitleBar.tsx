import { useEffect } from 'react'
import { Box, HStack, Flex } from '@chakra-ui/react'
import { useProjectStore } from '../../stores/projectStore'
import WindowControls from './WindowControls'
import ProjectMenu from './ProjectMenu'
import QuickOpen from './QuickOpen'
import { tokens } from '@/theme/tokens'
import { handleClose, handleMinimize, handleFullToggle, handleMouseDown } from './titlebar/useWindowControls'
import { useQuickOpen } from './titlebar/useQuickOpen'

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
		<Box
			className="vscode-titlebar drag-region"
			height="38px"
			bg={tokens.colors.bg.titlebar}
			borderBottom={`1px solid ${tokens.colors.border.default}`}
			display="flex"
			alignItems="center"
			px={3}
			position="relative"
			userSelect="none"
			backdropFilter="blur(12px)"
			data-tauri-drag-region
			onMouseDown={handleMouseDown}
		>
			<HStack
				gap={3}
				position="absolute"
				left={10}
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
