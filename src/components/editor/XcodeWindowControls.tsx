import { memo } from 'react'
import { HStack, Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const XcodeWindowControls = memo(() => (
	<HStack gap={2} pl={4}>
		<Box
			w="12px"
			h="12px"
			borderRadius="full"
			bg={tokens.colors.windowControl.close}
			cursor="pointer"
			position="relative"
			boxShadow={`0 0 0 0 ${tokens.colors.windowControl.closeShadow}`}
			_hover={{
				bg: tokens.colors.windowControl.closeHover,
				transform: 'scale(1.2)',
				boxShadow: `0 0 8px ${tokens.colors.windowControl.closeHoverShadow}`,
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
			bg={tokens.colors.windowControl.minimize}
			cursor="pointer"
			position="relative"
			boxShadow={`0 0 0 0 ${tokens.colors.windowControl.minimizeShadow}`}
			_hover={{
				bg: tokens.colors.windowControl.minimizeHover,
				transform: 'scale(1.2)',
				boxShadow: `0 0 8px ${tokens.colors.windowControl.minimizeHoverShadow}`,
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
			bg={tokens.colors.windowControl.maximize}
			cursor="pointer"
			position="relative"
			boxShadow={`0 0 0 0 ${tokens.colors.windowControl.maximizeShadow}`}
			_hover={{
				bg: tokens.colors.windowControl.maximizeHover,
				transform: 'scale(1.2)',
				boxShadow: `0 0 8px ${tokens.colors.windowControl.maximizeHoverShadow}`,
			}}
			transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
			_active={{
				transform: 'scale(0.95)',
			}}
		/>
	</HStack>
))

XcodeWindowControls.displayName = 'XcodeWindowControls'

export default XcodeWindowControls
