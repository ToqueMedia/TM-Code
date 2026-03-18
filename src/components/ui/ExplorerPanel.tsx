import React, { memo, Suspense } from 'react'
import {
	VStack,
	Text,
	Box,
	ScrollArea,
} from '@chakra-ui/react'
import { FiFolder } from 'react-icons/fi'
import { useCurrentProject } from '../../hooks/useProjectState'
import { PanelHeader } from './PanelHeader'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import FileTreeSkeleton from './FileTreeSkeleton'
import { tokens } from '@/theme/tokens'

const FileTree = React.lazy(() => import('./FileTree'))

interface ExplorerPanelProps {
	onFileSelect: (path: string) => void
}

function ExplorerPanel({ onFileSelect }: ExplorerPanelProps) {
	const currentProject = useCurrentProject()
	useFileTreeRepository()

	if (!currentProject) {
		return (
			<VStack
				height="100%"
				justify="center"
				align="center"
				p={6}
				gap={3}
			>
				<Box
					p={4}
					borderRadius="12px"
					bg={tokens.colors.accent.primarySubtle}
				>
					<FiFolder
						size={32}
						color={tokens.colors.accent.primary}
						style={{ filter: `drop-shadow(0 0 8px ${tokens.colors.accent.primaryGlow})` }}
					/>
				</Box>
				<Text fontSize="sm" color={tokens.colors.text.primary} fontWeight="500" textAlign="center">
					No folder opened
				</Text>
				<Text fontSize="xs" color={tokens.colors.text.muted} textAlign="center">
					Open a folder to start exploring
				</Text>
			</VStack>
		)
	}

	return (
		<VStack
			height="100%"
			bg={tokens.colors.bg.sidebar}
			align="stretch"
			gap={0}
		>
			<PanelHeader title="Explorer" />

			{/* File Tree */}
			<ScrollArea.Root flex="1">
				<ScrollArea.Viewport className="explorer-viewport">
					<ScrollArea.Content>
						<Suspense fallback={<FileTreeSkeleton />}>
							<FileTree
								rootPath={currentProject.path}
								onFileSelect={onFileSelect}
							/>
						</Suspense>
					</ScrollArea.Content>
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar
					position="absolute"
					orientation="vertical"
					right="2px"
					top="2px"
					bottom="2px"
					width="6px"
					borderRadius="3px"
					bg="transparent"
					_hover={{ bg: tokens.colors.scrollbar.explorerTrackHover }}
					transition={`background ${tokens.transition.normal}`}
					zIndex={1}
				>
					<ScrollArea.Thumb
						bg={tokens.colors.scrollbar.explorerThumb}
						borderRadius="3px"
						minH="20px"
						_hover={{ bg: tokens.colors.scrollbar.explorerThumbHover }}
						_active={{ bg: tokens.colors.scrollbar.explorerThumbActive }}
						transition={`background ${tokens.transition.normal}`}
					/>
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>

			{/* Footer */}
			<Box
				px={3}
				py={1.5}
				borderTop={`1px solid ${tokens.colors.border.default}`}
			>
				<Text
					fontSize="10px"
					color={tokens.colors.text.disabled}
					whiteSpace="nowrap"
					overflow="hidden"
					textOverflow="ellipsis"
					fontFamily={tokens.fontFamily.mono}
				>
					{currentProject.path}
				</Text>
			</Box>
		</VStack>
	)
}

export default memo(ExplorerPanel)
