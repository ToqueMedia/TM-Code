import React, { memo } from 'react'
import { Flex, ScrollArea, Text } from '@chakra-ui/react'
import { FiCode } from 'react-icons/fi'
import EditorTab from './EditorTab'
import { tokens } from '@/theme/tokens'

interface EditorTabsProps {
	openFiles: Array<{ path: string; isDirty: boolean }>
	activeFile: string | null
	onSetActiveFile: (path: string) => void
	onCloseFile: (path: string, e: React.MouseEvent) => void
}

const EditorTabs = memo<EditorTabsProps>(({ openFiles, activeFile, onSetActiveFile, onCloseFile }) => {
	return (
		<ScrollArea.Root
			bg={tokens.colors.bg.panel}
			borderBottom={`1px solid ${tokens.colors.border.default}`}
			position="relative"
			h={'auto'}
		>
			<ScrollArea.Viewport>
				<ScrollArea.Content>
					<Flex
						className="vscode-tabs"
						role="tablist"
						align="center"
						onContextMenu={(e) => {
							e.preventDefault()
							const target = (e.target as HTMLElement).closest('[data-path]') as HTMLElement | null
							const path = target?.getAttribute('data-path') || activeFile || null
							window.dispatchEvent(new CustomEvent('tabs:contextmenu:open', { detail: { x: e.clientX, y: e.clientY, path } }))
						}}
					>
						{openFiles.map((file) => (
							<EditorTab
								key={file.path}
								path={file.path}
								name={file.path.split('/').pop() || 'Untitled'}
								isDirty={file.isDirty}
								isActive={activeFile === file.path}
								onClick={() => onSetActiveFile(file.path)}
								onClose={(e) => onCloseFile(file.path, e)}
							/>
						))}

						{openFiles.length === 0 && (
							<Flex
								alignItems="center"
								justifyContent="center"
								gap={2}
								flex="1"
								color={tokens.colors.text.muted}
								fontSize="12px"
								height="30px"
							>
								<FiCode size={11} />
								<Text fontSize="11px">No open tabs</Text>
							</Flex>
						)}
					</Flex>
				</ScrollArea.Content>
			</ScrollArea.Viewport>
		</ScrollArea.Root>
	)
})

EditorTabs.displayName = 'EditorTabs'

export default EditorTabs
