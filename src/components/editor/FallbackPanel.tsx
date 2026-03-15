import { Flex, Text } from '@chakra-ui/react'
import { FiCode } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

const FallbackPanel = () => (
	<Flex
		flex="1"
		alignItems="center"
		justifyContent="center"
		bg="bg.editor"
		direction="column"
		p={8}
	>
		<FiCode size={48} color={tokens.colors.text.subtle} />
		<Text mt={4} fontSize="sm" color={tokens.colors.text.subtle}>
			Use the activity bar to show the Chat or Editor panel.
		</Text>
	</Flex>
)

FallbackPanel.displayName = 'FallbackPanel'

export default FallbackPanel
