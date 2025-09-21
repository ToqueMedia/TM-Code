import { memo } from 'react'
import { HStack, Box } from '@chakra-ui/react'

// Enhanced Window Controls with glowing effects
const WindowControls = memo(() => (
	<HStack gap={2} pl={4}>
		<Box
			w="12px"
			h="12px"
			borderRadius="full"
			bg="#ff5f57"
			cursor="pointer"
			position="relative"
			boxShadow="0 0 0 0 rgba(255, 95, 87, 0.4)"
			_hover={{
				bg: "#ff4136",
				transform: 'scale(1.2)',
				boxShadow: '0 0 8px rgba(255, 95, 87, 0.6)',
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_active={{
				transform: 'scale(0.95)',
			}}
		/>
		<Box
			w="12px"
			h="12px"
			borderRadius="full"
			bg="#ffbd2e"
			cursor="pointer"
			position="relative"
			boxShadow="0 0 0 0 rgba(255, 189, 46, 0.4)"
			_hover={{
				bg: "#ff9500",
				transform: 'scale(1.2)',
				boxShadow: '0 0 8px rgba(255, 189, 46, 0.6)',
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_active={{
				transform: 'scale(0.95)',
			}}
		/>
		<Box
			w="12px"
			h="12px"
			borderRadius="full"
			bg="#28ca42"
			cursor="pointer"
			position="relative"
			boxShadow="0 0 0 0 rgba(40, 202, 66, 0.4)"
			_hover={{
				bg: "#00d600",
				transform: 'scale(1.2)',
				boxShadow: '0 0 8px rgba(40, 202, 66, 0.6)',
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_active={{
				transform: 'scale(0.95)',
			}}
		/>
	</HStack>
))

WindowControls.displayName = 'WindowControls'

export default WindowControls