import { Flex } from '@chakra-ui/react'
import { LoadingSpinner } from '../ui/LoadingSpinner'

const EditorSkeleton = () => (
	<Flex
		flex={1}
		align="center"
		justify="center"
	>
		<LoadingSpinner size="lg" label="Loading editor..." />
	</Flex>
)

export default EditorSkeleton
