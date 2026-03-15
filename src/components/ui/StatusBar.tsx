import React, { memo, Suspense } from 'react'
import { Flex, Text, Box, Separator, HStack } from '@chakra-ui/react'
import { FiGitBranch, FiAlertCircle } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import LanguageSelector from './LanguageSelector'
import IndentationMenu from './IndentationMenu'

// Lazy load PerformanceStatus
const PerformanceStatus = React.lazy(() => import('./PerformanceStatus'))

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
	languages,
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
			height="26px"
			bg={tokens.colors.bg.statusbar}
			color={tokens.colors.text.statusbar}
			alignItems="center"
			fontSize="xs"
			fontWeight="medium"
			px={6}
			gap={2}
			borderTop={`1px solid ${tokens.colors.border.statusbar}`}
			boxShadow={tokens.shadow.statusbar}
			letterSpacing="0.02em"
			userSelect="none"
		>
			<HStack gap={0} height="100%">
				<StatusBarItem tooltip="Git branch">
					<FiGitBranch size={12} />
					<Text>main</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				<LanguageSelector activeFile={activeFile} openFiles={openFiles} />

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Line and column">
					<Text>Ln {cursorPosition.line}, Col {cursorPosition.column}</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				<IndentationMenu
					tabSizeSetting={tabSizeSetting}
					insertSpacesSetting={insertSpacesSetting}
					detectIndentationSetting={detectIndentationSetting}
					setTabSizeSetting={setTabSizeSetting}
					setInsertSpacesSetting={setInsertSpacesSetting}
					setDetectIndentationSetting={setDetectIndentationSetting}
				/>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Encoding">
					<Text>UTF-8</Text>
				</StatusBarItem>
			</HStack>

			<HStack gap={0} height="100%" marginLeft="auto">
				<Suspense fallback={null}>
					<PerformanceStatus compact />
				</Suspense>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Errors and warnings">
					<FiAlertCircle size={12} />
					<Text>0</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Monaco languages supported">
					<Text>Langs: {languages.length}</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Current project">
					<Text>{currentProject?.name}</Text>
				</StatusBarItem>
			</HStack>
		</Flex>
	)
})

StatusBar.displayName = 'StatusBar'

export default StatusBar
