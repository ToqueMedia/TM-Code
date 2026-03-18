import { Flex, Text, Box, VStack } from '@chakra-ui/react'
import { FiCode } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

const FallbackPanel = () => (
	<Flex
		flex="1"
		alignItems="center"
		justifyContent="center"
		bg={tokens.colors.bg.app}
		direction="column"
		p={8}
	>
		<VStack gap={3}>
			<Box
				p={4}
				borderRadius="12px"
				bg={tokens.colors.bg.hoverSubtle}
			>
				<FiCode size={28} color={tokens.colors.text.muted} />
			</Box>
			<Text fontSize="sm" color={tokens.colors.text.muted} textAlign="center" maxW="280px">
				Use the activity bar to show the Chat or Editor panel
			</Text>
		</VStack>
	</Flex>
)

FallbackPanel.displayName = 'FallbackPanel'

export default FallbackPanel
