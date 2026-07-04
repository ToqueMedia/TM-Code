import React, { memo, useCallback } from 'react'
import { Flex, Text, Box, IconButton, HStack } from '@chakra-ui/react'
import { VscClose } from 'react-icons/vsc'
import { Reorder } from 'framer-motion'
import { getFileIconByExtension } from '../../utils/iconMapper'
import { tokens } from '@/theme/tokens'

export interface EditorTabProps {
	path: string
	name: string
	isDirty: boolean
	isActive: boolean
	isPreview?: boolean
	onClick: () => void
	onDoubleClick: () => void
	onClose: (e: React.MouseEvent) => void
	onDragStart: () => void
	onDragEnd: () => void
}

const EditorTab = memo<EditorTabProps>(({ path, name, isDirty, isActive, isPreview, onClick, onDoubleClick, onClose, onDragStart, onDragEnd }) => {
	const handleClose = useCallback((e: React.MouseEvent) => {
		e.stopPropagation()
		onClose(e)
	}, [onClose])

	const ext = name.split('.').pop()?.toLowerCase()
	const iconUrl = getFileIconByExtension(ext, name)

	return (
		<Reorder.Item
			value={path}
			dragListener={true}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			style={{
				listStyle: 'none',
				display: 'flex',
				position: 'relative',
				userSelect: 'none',
			}}
			initial={false}
			transition={{
				type: 'spring',
				stiffness: 500,
				damping: 35,
				mass: 0.6,
			}}
			whileDrag={{
				scale: 1.03,
				boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
				zIndex: 50,
			}}
		>
			<Flex
				className={`vscode-tab ${isActive ? 'active' : ''}`}
				alignItems="center"
				px={2.5}
				py={0}
				bg={isActive ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.025)'}
				border={isActive ? '1px solid rgba(255,255,255,0.105)' : '1px solid rgba(255,255,255,0.045)'}
				fontSize="12px"
				cursor="pointer"
				onClick={onClick}
				onDoubleClick={onDoubleClick}
				position="relative"
				overflow="hidden"
				_hover={{
					bg: isActive ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.055)',
					borderColor: isActive ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)',
					'& .tab-close': {
						opacity: 0.7
					}
				}}
				transition="background 0.14s ease, border-color 0.14s ease, color 0.14s ease"
				role="tab"
				aria-selected={isActive}
				data-path={path}
				borderRadius="8px"
				height="28px"
				minW="0"
				maxW="200px"
				color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
				_after={{
					content: '""',
					position: 'absolute',
					bottom: '3px',
					left: '10px',
					right: '10px',
					height: '2px',
					borderRadius: '999px',
					bg: isActive ? tokens.colors.accent.primary : 'transparent',
				}}
			>
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
								pointerEvents: 'none',
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
						fontWeight={isActive ? '650' : '500'}
						fontStyle={isPreview ? 'italic' : 'normal'}
						maxW="140px"
						whiteSpace="nowrap"
						overflow="hidden"
						textOverflow="ellipsis"
						fontFamily={tokens.fontFamily.ui}
						letterSpacing="0"
						pointerEvents="none"
					>
						{name}
					</Text>
					{isDirty && (
						<Box
							w="6px"
							h="6px"
							borderRadius="full"
							bg={tokens.colors.accent.primary}
							boxShadow="0 0 0 3px rgba(254,16,99,0.12)"
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
						<VscClose size={11} />
					</IconButton>
				</HStack>
			</Flex>
		</Reorder.Item>
	)
}, (prevProps, nextProps) => {
	return (
		prevProps.path === nextProps.path &&
		prevProps.name === nextProps.name &&
		prevProps.isDirty === nextProps.isDirty &&
		prevProps.isActive === nextProps.isActive &&
		prevProps.isPreview === nextProps.isPreview
	)
})

EditorTab.displayName = 'EditorTab'

export default EditorTab
