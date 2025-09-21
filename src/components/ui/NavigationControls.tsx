import { memo } from 'react'
import { HStack, IconButton } from '@chakra-ui/react'
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi'

// Enhanced Navigation Controls with smooth transitions
const NavigationControls = memo(() => (
	<HStack gap={1} ml={4}>
		<IconButton
			aria-label="Go back"
			variant="ghost"
			size="sm"
			color="#8e8e93"
			position="relative"
			overflow="hidden"
			_hover={{
				color: "#ffffff",
				bg: "whiteAlpha.100",
				transform: 'translateX(-2px)',
				_before: {
					transform: 'translateX(0)',
				}
			}}
			_active={{
				transform: 'translateX(-4px) scale(0.95)',
			}}
			borderRadius="6px"
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_before={{
				content: '""',
				position: 'absolute',
				top: '50%',
				left: '50%',
				transform: 'translate(-50%, -50%) translateX(-100%)',
				width: '100%',
				height: '100%',
				bg: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
				transition: 'transform 0.6s',
			}}
		>
			<FiChevronLeft size={16} />
		</IconButton>
		<IconButton
			aria-label="Go forward"
			variant="ghost"
			size="sm"
			color="#8e8e93"
			position="relative"
			overflow="hidden"
			_hover={{
				color: "#ffffff",
				bg: "whiteAlpha.100",
				transform: 'translateX(2px)',
				_before: {
					transform: 'translateX(0)',
				}
			}}
			_active={{
				transform: 'translateX(4px) scale(0.95)',
			}}
			borderRadius="6px"
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_before={{
				content: '""',
				position: 'absolute',
				top: '50%',
				left: '50%',
				transform: 'translate(-50%, -50%) translateX(-100%)',
				width: '100%',
				height: '100%',
				bg: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
				transition: 'transform 0.6s',
			}}
		>
			<FiChevronRight size={16} />
		</IconButton>
	</HStack>
))

NavigationControls.displayName = 'NavigationControls'

export default NavigationControls