import React, { memo, useCallback } from 'react'
import { Flex, Text, Box, IconButton, HStack } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import { getFileIconByExtension } from '../../utils/iconMapper'
import { tokens } from '@/theme/tokens'

export interface EditorTabProps {
	path: string
	name: string
	isDirty: boolean
	isActive: boolean
	onClick: () => void
	onClose: (e: React.MouseEvent) => void
}

const EditorTab = memo<EditorTabProps>(({ path, name, isDirty, isActive, onClick, onClose }) => {
	const handleClose = useCallback((e: React.MouseEvent) => {
		e.stopPropagation()
		onClose(e)
	}, [onClose])

	const ext = name.split('.').pop()?.toLowerCase()
	const iconUrl = getFileIconByExtension(ext, name)

	return (
		<Flex
			className={`vscode-tab ${isActive ? 'active' : ''}`}
			alignItems="center"
			px={3}
			py={0}
			bg={isActive ? tokens.colors.bg.app : 'transparent'}
			borderRight={`1px solid ${tokens.colors.border.subtle}`}
			fontSize="13px"
			cursor="pointer"
			onClick={onClick}
			position="relative"
			overflow="hidden"
			_hover={{
				bg: isActive ? tokens.colors.bg.app : tokens.colors.bg.hoverSubtle,
				'& .tab-close': {
					opacity: 1
				}
			}}
			transition={`all ${tokens.transition.normal}`}
			role="tab"
			aria-selected={isActive}
			data-path={path}
			data-group
			borderRadius="0"
			height="35px"
			minW="0"
			maxW="240px"
			color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
			/* Bottom accent line for active tab */
			_after={{
				content: '""',
				position: 'absolute',
				bottom: 0,
				left: '10%',
				right: '10%',
				height: '2px',
				bg: isActive ? tokens.colors.accent.primary : 'transparent',
				borderRadius: '2px 2px 0 0',
				transition: `all ${tokens.transition.normal}`,
				boxShadow: isActive ? `0 0 8px ${tokens.colors.accent.primaryGlow}` : 'none',
			}}
		>
			<HStack gap={2} align="center" minW="0">
				{iconUrl ? (
					<img
						src={iconUrl}
						alt={name}
						style={{
							width: 16,
							height: 16,
							opacity: isActive ? 1 : 0.75,
							transition: 'opacity 0.2s',
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
					fontSize="12px"
					fontWeight={isActive ? '500' : '400'}
					maxW="160px"
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
						w="7px"
						h="7px"
						borderRadius="full"
						bg={tokens.colors.accent.primary}
						flexShrink={0}
						ml={0.5}
						boxShadow={`0 0 4px ${tokens.colors.accent.primaryGlow}`}
					/>
				)}
				<IconButton
					className="tab-close"
					aria-label={`Close ${name}`}
					onClick={handleClose}
					variant="ghost"
					color={tokens.colors.text.muted}
					size="xs"
					_hover={{
						bg: tokens.colors.bg.whiteOverlay,
						color: tokens.colors.text.inverse
					}}
					opacity={isActive ? 0.7 : 0}
					_groupHover={{ opacity: 0.7 }}
					transition={`opacity ${tokens.transition.fast}`}
					borderRadius="4px"
					width="20px"
					height="20px"
					minW="20px"
				>
					<FiX size={13} />
				</IconButton>
			</HStack>
		</Flex>
	)
}, (prevProps, nextProps) => {
	return (
		prevProps.path === nextProps.path &&
		prevProps.name === nextProps.name &&
		prevProps.isDirty === nextProps.isDirty &&
		prevProps.isActive === nextProps.isActive
	)
})

EditorTab.displayName = 'EditorTab'

export default EditorTab
