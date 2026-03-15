import { memo } from 'react'
import { HStack, IconButton } from '@chakra-ui/react'
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi'
import { tokens } from '../../theme/tokens'

// Enhanced Navigation Controls with smooth transitions
const NavigationControls = memo(() => (
	<HStack gap={1} ml={4}>
		<IconButton
			aria-label="Go back"
			variant="ghost"
			size="sm"
			disabled
			color={tokens.colors.nav.icon}
			opacity={0.4}
			borderRadius="6px"
		>
			<FiChevronLeft size={16} />
		</IconButton>
		<IconButton
			aria-label="Go forward"
			variant="ghost"
			size="sm"
			disabled
			color={tokens.colors.nav.icon}
			opacity={0.4}
			borderRadius="6px"
		>
			<FiChevronRight size={16} />
		</IconButton>
	</HStack>
))

NavigationControls.displayName = 'NavigationControls'

export default NavigationControls