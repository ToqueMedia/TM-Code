import React, { memo, useCallback } from 'react'
import { Flex, Text, Box, IconButton, HStack } from '@chakra-ui/react'
import { FiX, FiFile } from 'react-icons/fi'
import { SiJavascript, SiReact, SiCss3, SiHtml5, SiJson, SiMarkdown, SiPython, SiNpm, SiDocker } from 'react-icons/si'
import { FaFileImage, FaFilePdf, FaFileArchive } from 'react-icons/fa'
import TypeScriptIcon from '../icons/TypeScriptIcon'
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

const fe = tokens.colors.fileExtension

const getFileIconComponent = (fileName: string) => {
	const ext = fileName.split('.').pop()?.toLowerCase()
	const name = fileName.toLowerCase()

	if (name === 'package.json') {
		return { icon: SiNpm, color: fe.npm }
	}
	if (name === 'dockerfile') {
		return { icon: SiDocker, color: fe.docker }
	}

	switch (ext) {
		case 'js': return { icon: SiJavascript, color: fe.js }
		case 'jsx': return { icon: SiReact, color: fe.jsx }
		case 'ts': case 'tsx': return { icon: TypeScriptIcon, color: fe.ts }
		case 'css': return { icon: SiCss3, color: fe.css }
		case 'html': return { icon: SiHtml5, color: fe.html }
		case 'json': return { icon: SiJson, color: fe.json }
		case 'md': return { icon: SiMarkdown, color: fe.md }
		case 'py': return { icon: SiPython, color: fe.py }
		case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp':
			return { icon: FaFileImage, color: fe.image }
		case 'pdf': return { icon: FaFilePdf, color: fe.pdf }
		case 'zip': case 'rar': case 'tar': case 'gz':
			return { icon: FaFileArchive, color: fe.archive }
		default: return { icon: FiFile, color: fe.default }
	}
}

const EditorTab = memo<EditorTabProps>(({ path, name, isDirty, isActive, onClick, onClose }) => {
	const handleClose = useCallback((e: React.MouseEvent) => {
		e.stopPropagation()
		onClose(e)
	}, [onClose])

	return (
		<Flex
			className={`vscode-tab ${isActive ? 'active' : ''}`}
			alignItems="center"
			px={3}
			py={0}
			bg={isActive ? tokens.colors.bg.app : tokens.colors.bg.overlay}
			borderRight={`1px solid ${tokens.colors.border.activitybar}`}
			fontSize="13px"
			cursor="pointer"
			onClick={onClick}
			position="relative"
			overflow="hidden"
			_hover={{
				bg: isActive ? tokens.colors.bg.app : tokens.colors.bg.tabHover,
				_before: {
					opacity: isActive ? 0 : 0.5,
				},
				'& .tab-close': {
					opacity: 1
				}
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			role="tab"
			aria-selected={isActive}
			data-path={path}
			data-group
			borderRadius="0"
			height="35px"
			minW="0"
			maxW="240px"
			color={isActive ? tokens.colors.text.inverse : tokens.colors.text.dimmed}
			borderTop={isActive ? `2px solid ${tokens.colors.accent.blue}` : '2px solid transparent'}
			boxShadow={isActive ? tokens.shadow.tabActiveInset : 'none'}
			_before={{
				content: '""',
				position: 'absolute',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				bg: tokens.gradient.tabHoverOverlay,
				opacity: 0,
				transition: 'opacity 0.3s',
				pointerEvents: 'none',
			}}
			_after={{
				content: '""',
				position: 'absolute',
				bottom: 0,
				left: 0,
				right: 0,
				height: '1px',
				bg: isActive ? tokens.gradient.tabActiveBottom : 'transparent',
			}}
		>
			<HStack gap={2} align="center" minW="0">
				{(() => {
					const ext = name.split('.').pop()?.toLowerCase()
					const url = getFileIconByExtension(ext, name)
					if (url) {
						return (
							<img
								src={url}
								alt={name}
								style={{ width: 16, height: 16 }}
							/>
						)
					}
					const { icon: IconComponent, color } = getFileIconComponent(name)
					return <IconComponent size={16} color={color} />
				})()}
				<Text
					fontSize="13px"
					fontWeight="400"
					maxW="160px"
					whiteSpace="nowrap"
					overflow="hidden"
					textOverflow="ellipsis"
					fontFamily={tokens.fontFamily.ui}
				>
					{name}
				</Text>
				{isDirty && (
					<Box
						w="8px"
						h="8px"
						borderRadius="full"
						bg={isActive ? tokens.colors.text.inverse : tokens.colors.text.dimmed}
						flexShrink={0}
						ml={1}
					/>
				)}
				<IconButton
					className="tab-close"
					aria-label={`Close ${name}`}
					onClick={handleClose}
					variant="ghost"
					color={isActive ? tokens.colors.text.inverse : tokens.colors.text.dimmed}
					size="xs"
					_hover={{
						bg: tokens.colors.bg.whiteOverlay,
						color: tokens.colors.text.inverse
					}}
					opacity={isActive ? 1 : 0}
					_groupHover={{ opacity: 1 }}
					transition="opacity 0.1s ease"
					borderRadius="3px"
					width="22px"
					height="22px"
					minW="22px"
				>
					<FiX size={14} />
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
