import React, { memo, Suspense, useState, useCallback, useRef } from 'react'
import {
	VStack,
	Text,
	Box,
	Flex,
	HStack,
	Input,
	ScrollArea,
} from '@chakra-ui/react'
import { VscNewFile, VscNewFolder, VscRefresh, VscCollapseAll } from 'react-icons/vsc'
import { FiFolder } from 'react-icons/fi'
import { useCurrentProject } from '../../hooks/useProjectState'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import FileTreeSkeleton from './FileTreeSkeleton'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

const FileTree = React.lazy(() => import('./FileTree'))

interface ExplorerPanelProps {
	onFileSelect: (path: string) => void
}

function ExplorerPanel({ onFileSelect }: ExplorerPanelProps) {
	const currentProject = useCurrentProject()

	const refresh = useFileTreeRepository(s => s.refresh)
	const collapseAll = useFileTreeRepository(s => s.collapseAll)
	const createFileOrDirectory = useFileTreeRepository(s => s.createFileOrDirectory)
	const selectedPath = useFileTreeRepository(s => s.selectedPath)

	const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
	const [newName, setNewName] = useState('')
	const inputRef = useRef<HTMLInputElement>(null)

	// Determine parent path for new file/folder
	const getParentPath = useCallback(() => {
		if (selectedPath) {
			// If selected is a file, use its parent dir
			const parts = selectedPath.split('/')
			// Check if selected is a directory by looking at expandedPaths
			const expanded = useFileTreeRepository.getState().expandedPaths
			if (expanded.has(selectedPath)) return selectedPath
			parts.pop()
			return parts.join('/')
		}
		return currentProject?.path ?? ''
	}, [selectedPath, currentProject?.path])

	const handleStartCreate = useCallback((type: 'file' | 'folder') => {
		setCreating(type)
		setNewName('')
		requestAnimationFrame(() => inputRef.current?.focus())
	}, [])

	const handleConfirmCreate = useCallback(async () => {
		if (!newName.trim() || !creating) return
		const parentPath = getParentPath()
		const result = await createFileOrDirectory(parentPath, newName.trim(), creating === 'folder')
		if (result && creating === 'file') {
			onFileSelect(result)
		}
		setCreating(null)
		setNewName('')
	}, [newName, creating, getParentPath, createFileOrDirectory, onFileSelect])

	const handleCancelCreate = useCallback(() => {
		setCreating(null)
		setNewName('')
	}, [])

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault()
			handleConfirmCreate()
		} else if (e.key === 'Escape') {
			e.preventDefault()
			handleCancelCreate()
		}
	}, [handleConfirmCreate, handleCancelCreate])

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
					{t("explorer.noFolder")}
				</Text>
				<Text fontSize="xs" color={tokens.colors.text.muted} textAlign="center">
					{t("explorer.openFolder")}
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
			{/* Header with action buttons */}
			<Flex
				align="center"
				justify="space-between"
				px={3}
				height="34px"
				flexShrink={0}
				borderBottom={`1px solid ${tokens.colors.border.default}`}
				bg={tokens.colors.bg.panel}
			>
				<Text
					fontSize="11px"
					fontWeight="600"
					textTransform="uppercase"
					letterSpacing="0.06em"
					color={tokens.colors.text.muted}
				>
					Explorer
				</Text>
				<HStack gap={0}>
					<HeaderAction
						icon={<VscNewFile size={14} />}
						label="New File"
						onClick={() => handleStartCreate('file')}
					/>
					<HeaderAction
						icon={<VscNewFolder size={14} />}
						label="New Folder"
						onClick={() => handleStartCreate('folder')}
					/>
					<HeaderAction
						icon={<VscRefresh size={14} />}
						label="Refresh Explorer"
						onClick={refresh}
					/>
					<HeaderAction
						icon={<VscCollapseAll size={14} />}
						label="Collapse Folders in Explorer"
						onClick={collapseAll}
					/>
				</HStack>
			</Flex>

			{/* Inline create input */}
			{creating && (
				<Flex
					px={3}
					py={1.5}
					gap={2}
					align="center"
					bg={tokens.colors.bg.panelAlt}
					borderBottom={`1px solid ${tokens.colors.border.glass}`}
					flexShrink={0}
				>
					{creating === 'folder'
						? <VscNewFolder size={13} color={tokens.colors.accent.primary} />
						: <VscNewFile size={13} color={tokens.colors.accent.primary} />
					}
					<Input
						ref={inputRef}
						value={newName}
						onChange={e => setNewName(e.target.value)}
						onKeyDown={handleKeyDown}
						onBlur={handleCancelCreate}
						placeholder={creating === 'folder' ? 'Folder name' : 'File name'}
						autoComplete="off"
						autoCorrect="off"
						spellCheck={false}
						fontSize="12px"
						fontFamily={tokens.fontFamily.ui}
						bg={tokens.colors.bg.input}
						border={`1px solid ${tokens.colors.border.input}`}
						borderRadius="3px"
						color={tokens.colors.text.primary}
						_placeholder={{ color: tokens.colors.text.disabled }}
						_focus={{
							borderColor: tokens.colors.accent.primaryBorder,
							boxShadow: `0 0 0 1px ${tokens.colors.accent.primarySubtle}`,
						}}
						height="22px"
						px={1.5}
						flex={1}
					/>
				</Flex>
			)}

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

// ── Header Action Button ─────────────────────────────────────────────────

const HeaderAction = memo<{
	icon: React.ReactNode
	label: string
	onClick: () => void
}>(({ icon, label, onClick }) => (
	<Box
		as="button"
		display="flex"
		alignItems="center"
		justifyContent="center"
		w="22px"
		h="22px"
		borderRadius="3px"
		color={tokens.colors.text.muted}
		cursor="pointer"
		transition={`all ${tokens.transition.fast}`}
		_hover={{
			color: tokens.colors.text.primary,
			bg: tokens.colors.bg.hoverSubtle,
		}}
		onClick={onClick}
		title={label}
		flexShrink={0}
	>
		{icon}
	</Box>
))

HeaderAction.displayName = 'HeaderAction'

export default memo(ExplorerPanel)
