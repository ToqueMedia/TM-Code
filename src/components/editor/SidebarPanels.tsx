import { memo, useState, useEffect } from 'react'
import { Box, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import DebuggerPanel from '../DebuggerPanel'

export const SourceControlPanel = memo(() => (
	<Box p={4} color="text.muted">
		<Text fontSize="sm">Source control panel coming soon...</Text>
	</Box>
))

SourceControlPanel.displayName = 'SourceControlPanel'

export const RunDebugPanel = memo(() => {
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
						backgroundColor: tokens.colors.accent.blue,
						color: tokens.colors.text.inverse,
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

RunDebugPanel.displayName = 'RunDebugPanel'

export const ExtensionsPanel = memo(() => (
	<Box p={4} color="text.muted">
		<Text fontSize="sm">Extensions panel coming soon...</Text>
	</Box>
))

ExtensionsPanel.displayName = 'ExtensionsPanel'
