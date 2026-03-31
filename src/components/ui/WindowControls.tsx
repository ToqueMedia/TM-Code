import { HStack, Box, Text } from '@chakra-ui/react'
import { tokens } from '../../theme/tokens'
import { IS_MAC } from '../../utils/platform'

// macOS traffic-light icon styles — icons hidden by default, shown on group hover
const macDotBase = {
	width: '12px',
	height: '12px',
	borderRadius: '9999px',
	cursor: 'pointer',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	transition: 'all 0.15s',
	position: 'relative' as const,
}

interface WindowControlsProps {
	onClose: () => void
	onMinimize: () => void
	onMaximize: () => void
}

const WindowControls = ({ onClose, onMinimize, onMaximize }: WindowControlsProps) => {
	if (IS_MAC) {
		// macOS: traffic-light circles with Finder-style icons on hover
		return (
			<HStack
				gap={2}
				data-tauri-drag-region="false"
				role="group"
				css={{
					'& .mac-dot-icon': { opacity: 0, transition: 'opacity 0.15s' },
					'&:hover .mac-dot-icon': { opacity: 1 },
				}}
			>
				<Box
					{...macDotBase}
					bg={tokens.colors.windowControl.close}
					onClick={onClose}
					_active={{ transform: 'scale(0.85)' }}
				>
					<Text className="mac-dot-icon" fontSize="9px" lineHeight="1" color="rgba(80,0,0,0.8)" fontWeight="700" mt="-1px">
						&#x2715;
					</Text>
				</Box>
				<Box
					{...macDotBase}
					bg={tokens.colors.windowControl.minimize}
					onClick={onMinimize}
					_active={{ transform: 'scale(0.85)' }}
				>
					<Text className="mac-dot-icon" fontSize="12px" lineHeight="1" color="rgba(120,70,0,0.8)" fontWeight="700" mt="-2px">
						&#x2013;
					</Text>
				</Box>
				<Box
					{...macDotBase}
					bg={tokens.colors.windowControl.maximize}
					onClick={onMaximize}
					_active={{ transform: 'scale(0.85)' }}
				>
					{/* Diagonal arrows like Finder fullscreen icon */}
					<Box className="mac-dot-icon" position="relative" w="7px" h="7px">
						<Box
							position="absolute" top="0" left="0"
							w="0" h="0"
							borderLeft="3.5px solid rgba(0,80,0,0.8)"
							borderBottom="3.5px solid transparent"
						/>
						<Box
							position="absolute" bottom="0" right="0"
							w="0" h="0"
							borderRight="3.5px solid rgba(0,80,0,0.8)"
							borderTop="3.5px solid transparent"
						/>
					</Box>
				</Box>
			</HStack>
		)
	}

	// Windows/Linux: icon-based buttons
	return (
		<HStack gap={0} data-tauri-drag-region="false">
			<Box
				display="flex"
				alignItems="center"
				justifyContent="center"
				width="36px"
				height="28px"
				cursor="pointer"
				color={tokens.colors.text.secondary}
				transition="all 0.15s"
				_hover={{ bg: 'rgba(255,255,255,0.08)', color: tokens.colors.text.primary }}
				onClick={onMinimize}
			>
				<Text fontSize="16px" lineHeight="1" mt="-2px" fontWeight="300">&#x2013;</Text>
			</Box>
			<Box
				display="flex"
				alignItems="center"
				justifyContent="center"
				width="36px"
				height="28px"
				cursor="pointer"
				color={tokens.colors.text.secondary}
				transition="all 0.15s"
				_hover={{ bg: 'rgba(255,255,255,0.08)', color: tokens.colors.text.primary }}
				onClick={onMaximize}
			>
				<Box
					width="9px"
					height="9px"
					border="1px solid currentColor"
					borderRadius="1px"
				/>
			</Box>
			<Box
				display="flex"
				alignItems="center"
				justifyContent="center"
				width="36px"
				height="28px"
				cursor="pointer"
				color={tokens.colors.text.secondary}
				transition="all 0.15s"
				_hover={{ bg: '#e81123', color: '#fff' }}
				onClick={onClose}
			>
				<Text fontSize="16px" lineHeight="1" fontWeight="300">&#x2715;</Text>
			</Box>
		</HStack>
	)
}

export default WindowControls