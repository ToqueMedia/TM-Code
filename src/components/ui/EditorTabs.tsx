import React, { memo } from 'react'
import { Flex, ScrollArea } from '@chakra-ui/react'
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
			bg={tokens.gradient.tabBar}
			borderBottom={`1px solid ${tokens.colors.border.activitybar}`}
			position="relative"
			boxShadow={tokens.shadow.tabBar}
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
								flex="1"
								color="text.secondary"
								fontSize="sm"
								height="35px"
							>
								No tabs open
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
