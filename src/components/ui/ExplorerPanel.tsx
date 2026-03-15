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
				color="text.muted"
			>
				<FiFolder size={48} />
				<Text fontSize="sm" textAlign="center">
					No folder opened
				</Text>
				<Text fontSize="xs" textAlign="center" mt={2}>
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
			<PanelHeader
				title="Explorer"
			/>


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
					width="8px"
					borderRadius="4px"
					bg="transparent"
					_hover={{ bg: tokens.colors.scrollbar.explorerTrackHover }}
					_active={{ bg: tokens.colors.scrollbar.explorerTrackActive }}
					transition="background 0.2s"
					zIndex={1}
				>
					<ScrollArea.Thumb
						bg={tokens.colors.scrollbar.explorerThumb}
						borderRadius="4px"
						minH="20px"
						_hover={{ bg: tokens.colors.scrollbar.explorerThumbHover }}
						_active={{ bg: tokens.colors.scrollbar.explorerThumbActive }}
						transition="background 0.2s"
					/>
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>

			{/* Footer Info */}
			<Box
				px={3}
				py={2}
				borderTop="1px solid"
				borderColor={tokens.colors.border.footer}
				bg={tokens.colors.bg.footerOverlay}
			>
				<Text
					fontSize="xs"
					color="text.muted"
					whiteSpace="nowrap"
					overflow="hidden"
					textOverflow="ellipsis"
				>
					{currentProject.path}
				</Text>
			</Box>
		</VStack>
	)
}

export default memo(ExplorerPanel)
