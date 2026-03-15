import React, { memo } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const StatusBarItem = memo<{ children: React.ReactNode; tooltip?: string }>(({
	children,
	tooltip
}) => (
	<Box
		px={3}
		py={1}
		fontSize="xs"
		fontWeight="medium"
		cursor="pointer"
		position="relative"
		_hover={{
			bg: tokens.colors.bg.hoverSubtle,
			transform: 'translateY(-1px)',
			_after: {
				opacity: 1,
				transform: 'scaleX(1)',
			}
		}}
		transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
		display="flex"
		alignItems="center"
		gap={1}
		title={tooltip}
		_after={{
			content: '""',
			position: 'absolute',
			bottom: 0,
			left: '50%',
			transform: 'translateX(-50%) scaleX(0)',
			width: '80%',
			height: '2px',
			bg: tokens.colors.accent.blue,
			opacity: 0,
			transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
		}}
	>
		{children}
	</Box>
))

StatusBarItem.displayName = 'StatusBarItem'

export default StatusBarItem
