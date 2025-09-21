import React, { memo, useCallback } from 'react'
import { Flex, Text, Box, IconButton, ScrollArea, HStack } from '@chakra-ui/react'
import { FiX, FiFile } from 'react-icons/fi'
import { SiJavascript, SiReact, SiCss3, SiHtml5, SiJson, SiMarkdown, SiPython, SiNpm, SiDocker } from 'react-icons/si'
import { FaFileImage, FaFilePdf, FaFileArchive } from 'react-icons/fa'
import TypeScriptIcon from '../icons/TypeScriptIcon'
import { getFileIconByExtension } from '../../utils/iconMapper'

// Xcode-style Editor Tab Component
interface EditorTabProps {
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

	const getFileIconComponent = (fileName: string) => {
		const ext = fileName.split('.').pop()?.toLowerCase()
		const name = fileName.toLowerCase()

		// Special files based on name
		if (name === 'package.json') {
			return { icon: SiNpm, color: '#cb3837' }
		}
		if (name === 'dockerfile') {
			return { icon: SiDocker, color: '#2496ed' }
		}

		// Extension based icons
		switch (ext) {
			case 'js':
				return { icon: SiJavascript, color: '#f7df1e' }
			case 'jsx':
				return { icon: SiReact, color: '#61dafb' }
			case 'ts':
				return { icon: TypeScriptIcon, color: '#3178c6' }
			case 'tsx':
				return { icon: TypeScriptIcon, color: '#3178c6' }
			case 'css':
				return { icon: SiCss3, color: '#1572b6' }
			case 'html':
				return { icon: SiHtml5, color: '#e34f26' }
			case 'json':
				return { icon: SiJson, color: '#ffff00' }
			case 'md':
				return { icon: SiMarkdown, color: '#0066cc' }
			case 'py':
				return { icon: SiPython, color: '#3776ab' }
			case 'png':
			case 'jpg':
			case 'jpeg':
			case 'gif':
			case 'svg':
			case 'webp':
				return { icon: FaFileImage, color: '#2ea043' }
			case 'pdf':
				return { icon: FaFilePdf, color: '#dc2626' }
			case 'zip':
			case 'rar':
			case 'tar':
			case 'gz':
				return { icon: FaFileArchive, color: '#d97706' }
			default:
				return { icon: FiFile, color: '#8b949e' }
		}
	}

	return (
		<Flex
			className={`vscode-tab ${isActive ? 'active' : ''}`}
			alignItems="center"
			px={3}
			py={0}
			bg={isActive ? '#1e1e1e' : '#2d2d30'}
			borderRight="1px solid #1e1f22"
			fontSize="13px"
			cursor="pointer"
			onClick={onClick}
			position="relative"
			overflow="hidden"
			_hover={{
				bg: isActive ? '#1e1e1e' : '#37373d',
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
			color={isActive ? '#ffffff' : '#969696'}
			borderTop={isActive ? '2px solid #007acc' : '2px solid transparent'}
			boxShadow={isActive ? 'inset 0 1px 0 rgba(0, 122, 204, 0.3)' : 'none'}
			_before={{
				content: '""',
				position: 'absolute',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				bg: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 100%)',
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
				bg: isActive ? 'linear-gradient(90deg, transparent, #007acc, transparent)' : 'transparent',
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
					fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif"
				>
					{name}
				</Text>
				{isDirty && (
					<Box
						w="8px"
						h="8px"
						borderRadius="full"
						bg={isActive ? '#ffffff' : '#969696'}
						flexShrink={0}
						ml={1}
					/>
				)}
				<IconButton
					className="tab-close"
					aria-label={`Close ${name}`}
					onClick={handleClose}
					variant="ghost"
					color={isActive ? '#ffffff' : '#969696'}
					size="xs"
					_hover={{
						bg: 'rgba(255, 255, 255, 0.1)',
						color: '#ffffff'
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

interface EditorTabsProps {
	openFiles: Array<{ path: string; isDirty: boolean }>
	activeFile: string | null
	onSetActiveFile: (path: string) => void
	onCloseFile: (path: string, e: React.MouseEvent) => void
}

const EditorTabs = memo<EditorTabsProps>(({ openFiles, activeFile, onSetActiveFile, onCloseFile }) => {
	return (
		<ScrollArea.Root
			bg="linear-gradient(180deg, #2d2d30 0%, #252526 100%)"
			borderBottom="1px solid #1e1f22"
			position="relative"
			boxShadow="0 1px 3px rgba(0,0,0,0.1)"
			h={'auto'}
		>
			<ScrollArea.Viewport>
				<ScrollArea.Content>
					<Flex
						className="vscode-tabs"
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
			{/* <ScrollArea.Scrollbar
				position="absolute"
				orientation="horizontal"
				bottom="2px"
				left="2px"
				right="2px"
				height="8px"
				borderRadius="4px"
				bg="transparent"
				_hover={{ bg: 'rgba(128, 128, 128, 0.2)' }}
				_active={{ bg: 'rgba(128, 128, 128, 0.4)' }}
				transition="background 0.2s"
				zIndex={1}
			>
				<ScrollArea.Thumb
					bg="rgba(128, 128, 128, 0.4)"
					borderRadius="4px"
					minW="20px"
					_hover={{ bg: 'rgba(128, 128, 128, 0.6)' }}
					_active={{ bg: 'rgba(128, 128, 128, 0.8)' }}
					transition="background 0.2s"
				/>
			</ScrollArea.Scrollbar> */}
		</ScrollArea.Root>
	)
})

EditorTabs.displayName = 'EditorTabs'

export default EditorTabs