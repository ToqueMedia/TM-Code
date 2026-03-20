import React, { memo, useCallback, useState } from 'react'
import { Flex, Text, Box, IconButton, HStack } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import { getFileIconByExtension } from '../../utils/iconMapper'
import { tokens } from '@/theme/tokens'

export interface EditorTabProps {
	path: string
	name: string
	isDirty: boolean
	isActive: boolean
	index: number
	onClick: () => void
	onClose: (e: React.MouseEvent) => void
	onReorder: (fromIndex: number, toIndex: number) => void
}

const EditorTab = memo<EditorTabProps>(({ path, name, isDirty, isActive, index, onClick, onClose, onReorder }) => {
	const [dragOver, setDragOver] = useState<'left' | 'right' | null>(null)
	const [isDragging, setIsDragging] = useState(false)

	const handleClose = useCallback((e: React.MouseEvent) => {
		e.stopPropagation()
		onClose(e)
	}, [onClose])

	const handleDragStart = useCallback((e: React.DragEvent) => {
		e.dataTransfer.setData('tab-index', String(index))
		e.dataTransfer.effectAllowed = 'move'
		setIsDragging(true)
	}, [index])

	const handleDragEnd = useCallback(() => {
		setIsDragging(false)
	}, [])

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.dataTransfer.dropEffect = 'move'
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
		const midX = rect.left + rect.width / 2
		setDragOver(e.clientX < midX ? 'left' : 'right')
	}, [])

	const handleDragLeave = useCallback(() => {
		setDragOver(null)
	}, [])

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		setDragOver(null)
		const from = parseInt(e.dataTransfer.getData('tab-index'), 10)
		if (isNaN(from) || from === index) return
		onReorder(from, index)
	}, [index, onReorder])

	const ext = name.split('.').pop()?.toLowerCase()
	const iconUrl = getFileIconByExtension(ext, name)

	return (
		<Flex
			className={`vscode-tab ${isActive ? 'active' : ''}`}
			alignItems="center"
			px={2.5}
			py={0}
			bg={isActive ? tokens.colors.bg.app : 'transparent'}
			borderRight={`1px solid ${tokens.colors.border.subtle}`}
			fontSize="12px"
			cursor="pointer"
			onClick={onClick}
			position="relative"
			overflow="visible"
			_hover={{
				bg: isActive ? tokens.colors.bg.app : tokens.colors.bg.hoverSubtle,
				'& .tab-close': {
					opacity: 0.7
				}
			}}
			transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}, opacity ${tokens.transition.fast}`}
			role="tab"
			aria-selected={isActive}
			data-path={path}
			data-group
			borderRadius="0"
			height="30px"
			minW="0"
			maxW="200px"
			color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
			opacity={isDragging ? 0.4 : 1}
			draggable
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			_after={{
				content: '""',
				position: 'absolute',
				bottom: 0,
				left: 0,
				right: 0,
				height: '2px',
				bg: isActive ? tokens.colors.accent.primary : 'transparent',
				transition: `background ${tokens.transition.fast}`,
			}}
		>
			{/* Drop indicator — left */}
			{dragOver === 'left' && (
				<Box
					position="absolute"
					left="-1px"
					top="4px"
					bottom="4px"
					width="2px"
					bg={tokens.colors.accent.primary}
					borderRadius="1px"
					zIndex={10}
				/>
			)}
			{/* Drop indicator — right */}
			{dragOver === 'right' && (
				<Box
					position="absolute"
					right="-1px"
					top="4px"
					bottom="4px"
					width="2px"
					bg={tokens.colors.accent.primary}
					borderRadius="1px"
					zIndex={10}
				/>
			)}

			<HStack gap={2} align="center" minW="0">
				{iconUrl ? (
					<img
						src={iconUrl}
						alt={name}
						style={{
							width: 14,
							height: 14,
							opacity: isActive ? 1 : 0.6,
							flexShrink: 0,
						}}
					/>
				) : (
					<Box
						w="16px"
						h="16px"
						borderRadius="3px"
						bg={tokens.colors.bg.hoverSubtle}
						flexShrink={0}
					/>
				)}
				<Text
					fontSize="11.5px"
					fontWeight={isActive ? '500' : '400'}
					maxW="140px"
					whiteSpace="nowrap"
					overflow="hidden"
					textOverflow="ellipsis"
					fontFamily={tokens.fontFamily.ui}
					letterSpacing="-0.01em"
				>
					{name}
				</Text>
				{isDirty && (
					<Box
						w="6px"
						h="6px"
						borderRadius="full"
						bg={tokens.colors.accent.primary}
						flexShrink={0}
					/>
				)}
				<IconButton
					className="tab-close"
					aria-label={`Close ${name}`}
					onClick={handleClose}
					variant="ghost"
					color={tokens.colors.text.muted}
					size="xs"
					_hover={{ bg: tokens.colors.bg.whiteOverlay, color: tokens.colors.text.inverse }}
					opacity={isActive ? 0.5 : 0}
					transition={`opacity ${tokens.transition.fast}`}
					borderRadius="3px"
					width="18px"
					height="18px"
					minW="18px"
				>
					<FiX size={11} />
				</IconButton>
			</HStack>
		</Flex>
	)
}, (prevProps, nextProps) => {
	return (
		prevProps.path === nextProps.path &&
		prevProps.name === nextProps.name &&
		prevProps.isDirty === nextProps.isDirty &&
		prevProps.isActive === nextProps.isActive &&
		prevProps.index === nextProps.index
	)
})

EditorTab.displayName = 'EditorTab'

export default EditorTab
