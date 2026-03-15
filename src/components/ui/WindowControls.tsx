import { HStack, Box } from '@chakra-ui/react'
import { tokens } from '../../theme/tokens'

interface WindowControlsProps {
	onClose: () => void
	onMinimize: () => void
	onMaximize: () => void
}

const WindowControls = ({ onClose, onMinimize, onMaximize }: WindowControlsProps) => (
	<HStack gap={2} className="no-drag">
		<Box
			width="12px"
			height="12px"
			borderRadius="full"
			bg={tokens.colors.windowControl.close}
			cursor="pointer"
			onClick={onClose}
			transition="filter 0.2s"
			_hover={{ filter: 'brightness(1.1)' }}
		/>
		<Box
			width="12px"
			height="12px"
			borderRadius="full"
			bg={tokens.colors.windowControl.minimize}
			cursor="pointer"
			onClick={onMinimize}
			transition="filter 0.2s"
			_hover={{ filter: 'brightness(1.1)' }}
		/>
		<Box
			width="12px"
			height="12px"
			borderRadius="full"
			bg={tokens.colors.windowControl.maximize}
			cursor="pointer"
			onClick={onMaximize}
			transition="filter 0.2s"
			_hover={{ filter: 'brightness(1.1)' }}
		/>
	</HStack>
)

export default WindowControls