import React, { memo } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const StatusBarItem = memo<{ children: React.ReactNode; tooltip?: string }>(({
	children,
	tooltip
}) => (
	<Box
		px={2}
		py={0.5}
		fontSize="11px"
		fontWeight="medium"
		cursor="pointer"
		borderRadius="3px"
		_hover={{
			bg: tokens.colors.bg.hoverSubtle,
			color: tokens.colors.text.primary,
		}}
		transition={`all ${tokens.transition.fast}`}
		display="flex"
		alignItems="center"
		gap={1}
		title={tooltip}
		color={tokens.colors.text.secondary}
	>
		{children}
	</Box>
))

StatusBarItem.displayName = 'StatusBarItem'

export default StatusBarItem
