import { Flex, Text, Box, VStack } from '@chakra-ui/react'
import { FiCode } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

const EditorEmptyState = () => (
	<Flex
		flex="1"
		alignItems="center"
		justifyContent="center"
		bg={tokens.colors.bg.app}
		direction="column"
		p={8}
		position="relative"
		overflow="hidden"
	>
		<VStack gap={4}>
			<Box
				p={5}
				borderRadius="16px"
				bg={tokens.colors.accent.primarySubtle}
				transform="translateY(0px)"
				transition={`all ${tokens.transition.slow}`}
				_hover={{
					transform: 'translateY(-6px)',
					boxShadow: `0 12px 32px ${tokens.colors.accent.primaryGlow}`,
				}}
			>
				<FiCode
					size={40}
					color={tokens.colors.accent.primary}
					style={{
						filter: `drop-shadow(0 0 12px ${tokens.colors.accent.primaryGlow})`,
					}}
				/>
			</Box>
			<VStack gap={1}>
				<Text
					fontSize="lg"
					color={tokens.colors.text.primary}
					fontWeight="600"
					letterSpacing="-0.02em"
				>
					TM Code
				</Text>
				<Text
					fontSize="sm"
					color={tokens.colors.text.muted}
					textAlign="center"
					maxW="340px"
					lineHeight="1.6"
				>
					Open a file from the explorer to start editing
				</Text>
			</VStack>
		</VStack>

		{/* Background glow */}
		<Box
			position="absolute"
			top="50%"
			left="50%"
			transform="translate(-50%, -50%)"
			width="300px"
			height="300px"
			opacity={0.04}
			pointerEvents="none"
			bg={`radial-gradient(circle at center, ${tokens.colors.accent.primary} 0%, transparent 70%)`}
			borderRadius="full"
		/>
	</Flex>
)

EditorEmptyState.displayName = 'EditorEmptyState'

export default EditorEmptyState
