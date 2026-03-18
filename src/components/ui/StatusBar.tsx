import React, { memo, Suspense } from 'react'
import { Flex, Text, Box, HStack } from '@chakra-ui/react'
import { FiGitBranch, FiAlertCircle, FiZap, FiBox, FiShield } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useMcpStore } from '@/stores/mcpStore'
import { useContainerStore } from '@/stores/containerStore'
import LanguageSelector from './LanguageSelector'
import IndentationMenu from './IndentationMenu'

// Lazy load PerformanceStatus
const PerformanceStatus = React.lazy(() => import('./PerformanceStatus'))

const StatusBarDivider = () => (
	<Box
		width="1px"
		height="14px"
		bg={tokens.colors.border.glass}
		mx={1}
		flexShrink={0}
	/>
)

const StatusBarItem = memo<{ children: React.ReactNode; tooltip?: string; onClick?: () => void }>(({
	children,
	tooltip,
	onClick,
}) => (
	<Box
		px={2}
		py={0.5}
		fontSize="11px"
		fontWeight="medium"
		cursor="pointer"
		position="relative"
		borderRadius="3px"
		_hover={{
			bg: tokens.colors.bg.hoverSubtle,
			color: tokens.colors.text.primary,
		}}
		transition={`all ${tokens.transition.fast}`}
		display="flex"
		alignItems="center"
		gap={1}
		title={tooltip}
		color={tokens.colors.text.secondary}
		letterSpacing="0.01em"
		onClick={onClick}
	>
		{children}
	</Box>
))

StatusBarItem.displayName = 'StatusBarItem'

// ─── MCP Status Pill ────────────────────────────────────────────────────────

const McpStatusPill = memo(() => {
	const servers = useMcpStore(s => s.servers)
	const isInitializing = useMcpStore(s => s.isInitializing)

	const running = servers.filter(s => s.status === 'running')
	const errored = servers.filter(s => s.status === 'error')
	const totalTools = running.reduce((sum, s) => sum + s.tools.length, 0)

	if (!isInitializing && running.length === 0 && errored.length === 0) {
		return null
	}

	let color: string = tokens.colors.accent.green
	let label = `MCP ${running.length}`

	if (isInitializing) {
		color = tokens.colors.accent.orange
		label = 'MCP...'
	} else if (errored.length > 0 && running.length === 0) {
		color = tokens.colors.accent.red
		label = `MCP ${errored.length}`
	} else if (running.length > 0) {
		label = `MCP ${running.length} (${totalTools})`
	}

	return (
		<>
			<StatusBarDivider />
			<HStack
				gap={1}
				px={2}
				py="2px"
				borderRadius={tokens.radius.full}
				bg="rgba(255, 255, 255, 0.04)"
				cursor="default"
				title={`${running.length} server(s) running, ${totalTools} tools`}
			>
				<FiZap size={10} color={color} />
				<Text fontSize="10px" color={color} fontWeight="600" fontFamily={tokens.fontFamily.mono}>
					{label}
				</Text>
			</HStack>
		</>
	)
})

McpStatusPill.displayName = 'McpStatusPill'

// ─── Container Status Pill ──────────────────────────────────────────────────

const ContainerStatusPill = memo(() => {
	const isolationMode = useContainerStore(s => s.isolationMode)
	const devcontainerName = useContainerStore(s => s.devcontainerName)

	if (isolationMode === 'none') return null

	const isDocker = isolationMode === 'docker'
	const Icon = isDocker ? FiBox : FiShield
	const color = isDocker ? tokens.colors.accent.greenBright : '#58a6ff'
	const label = isDocker
		? (devcontainerName ? `${devcontainerName}` : 'Docker')
		: (devcontainerName || 'Isolated')

	return (
		<>
			<StatusBarDivider />
			<HStack
				gap={1}
				px={2}
				py="2px"
				borderRadius={tokens.radius.full}
				bg="rgba(255, 255, 255, 0.04)"
				cursor="default"
				title={isDocker ? 'Running in Docker container' : 'App-level isolation'}
			>
				<Icon size={10} color={color} />
				<Text fontSize="10px" color={color} fontWeight="600" fontFamily={tokens.fontFamily.mono}>
					{label}
				</Text>
			</HStack>
		</>
	)
})

ContainerStatusPill.displayName = 'ContainerStatusPill'

// ─── StatusBar ──────────────────────────────────────────────────────────────

interface StatusBarProps {
	currentProject: { name: string; path: string } | null
	activeFile: string | null
	openFiles: Array<{ path: string; language: string; isDirty: boolean }>
	cursorPosition: { line: number; column: number }
	languages: string[]
	tabSizeSetting: number
	insertSpacesSetting: boolean
	detectIndentationSetting: boolean
	setTabSizeSetting: (size: number) => void
	setInsertSpacesSetting: (value: boolean) => void
	setDetectIndentationSetting: (value: boolean) => void
}

const StatusBar = memo<StatusBarProps>(({
	currentProject,
	activeFile,
	openFiles,
	cursorPosition,
	languages: _languages,
	tabSizeSetting,
	insertSpacesSetting,
	detectIndentationSetting,
	setTabSizeSetting,
	setInsertSpacesSetting,
	setDetectIndentationSetting
}) => {
	return (
		<Flex
			role="status"
			aria-live="polite"
			height="24px"
			bg={tokens.colors.bg.statusbar}
			color={tokens.colors.text.secondary}
			alignItems="center"
			fontSize="11px"
			fontWeight="medium"
			px={3}
			gap={0}
			borderTop={`1px solid ${tokens.colors.border.subtle}`}
			letterSpacing="0.01em"
			userSelect="none"
		>
			<HStack gap={0} height="100%">
				<StatusBarItem tooltip="Git branch">
					<FiGitBranch size={12} />
					<Text fontFamily={tokens.fontFamily.mono} fontSize="11px">main</Text>
				</StatusBarItem>

				<StatusBarDivider />

				<LanguageSelector activeFile={activeFile} openFiles={openFiles} />

				<StatusBarDivider />

				<StatusBarItem tooltip="Cursor position">
					<Text fontFamily={tokens.fontFamily.mono} fontSize="11px">
						Ln {cursorPosition.line}, Col {cursorPosition.column}
					</Text>
				</StatusBarItem>

				<StatusBarDivider />

				<IndentationMenu
					tabSizeSetting={tabSizeSetting}
					insertSpacesSetting={insertSpacesSetting}
					detectIndentationSetting={detectIndentationSetting}
					setTabSizeSetting={setTabSizeSetting}
					setInsertSpacesSetting={setInsertSpacesSetting}
					setDetectIndentationSetting={setDetectIndentationSetting}
				/>

				<StatusBarDivider />

				<StatusBarItem tooltip="File encoding">
					<Text fontFamily={tokens.fontFamily.mono} fontSize="11px">UTF-8</Text>
				</StatusBarItem>
			</HStack>

			<HStack gap={0} height="100%" marginLeft="auto">
				{/* Container isolation indicator */}
				<ContainerStatusPill />

				{/* MCP servers indicator */}
				<McpStatusPill />

				<StatusBarDivider />

				<Suspense fallback={null}>
					<PerformanceStatus compact />
				</Suspense>

				<StatusBarDivider />

				<StatusBarItem tooltip="Diagnostics">
					<FiAlertCircle size={11} />
					<Text fontFamily={tokens.fontFamily.mono} fontSize="11px">0</Text>
				</StatusBarItem>

				<StatusBarDivider />

				<StatusBarItem tooltip="Current project">
					<Box
						w="5px"
						h="5px"
						borderRadius="full"
						bg={tokens.colors.accent.primary}
						flexShrink={0}
					/>
					<Text fontSize="11px" fontWeight="500">
						{currentProject?.name}
					</Text>
				</StatusBarItem>
			</HStack>
		</Flex>
	)
})

StatusBar.displayName = 'StatusBar'

export default StatusBar
