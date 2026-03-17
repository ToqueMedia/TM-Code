import { Flex, Text, Box } from '@chakra-ui/react'
import { FiCode } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

const EditorEmptyState = () => (
	<Flex
		flex="1"
		alignItems="center"
		justifyContent="center"
		bg="bg.editor"
		direction="column"
		p={8}
		position="relative"
		overflow="hidden"
	>
		<Box
			position="relative"
			transform="translateY(0px)"
			transition="transform 0.3s ease"
			_hover={{
				transform: 'translateY(-10px)',
			}}
		>
			<FiCode
				size={64}
				color={tokens.colors.accent.primary}
				style={{
					filter: tokens.shadow.accentDrop,
				}}
			/>
		</Box>
		<Text
			mt={4}
			fontSize="xl"
			color="text.primary"
			fontWeight="600"
			opacity={0}
			animation="fadeIn 0.8s ease-out forwards"
			animationDelay="0.2s"
		>
			Welcome to TM Code
		</Text>
		<Text
			mt={2}
			fontSize="sm"
			color="text.muted"
			textAlign="center"
			maxW="400px"
			opacity={0}
			animation="fadeIn 1s ease-out forwards"
			animationDelay="0.4s"
		>
			Open a file from the explorer or create a new file to start coding.
		</Text>
		<Box
			position="absolute"
			top="50%"
			left="50%"
			transform="translate(-50%, -50%)"
			width="200%"
			height="200%"
			opacity={0.03}
			pointerEvents="none"
			bg={`radial-gradient(circle at center, ${tokens.colors.accent.primary} 0%, transparent 70%)`}
		/>
	</Flex>
)

EditorEmptyState.displayName = 'EditorEmptyState'

export default EditorEmptyState
