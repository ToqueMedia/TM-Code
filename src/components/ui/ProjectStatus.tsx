import { memo } from 'react'
import { Flex, Text, Box, Separator, HStack } from '@chakra-ui/react'
import { tokens } from '../../theme/tokens'

// Xcode Project Status
const ProjectStatus = memo<{ projectName: string; isRunning: boolean }>(({ projectName, isRunning }: { projectName: string; isRunning: boolean }) => (
	<Flex align="center" gap={3}>
		<Text fontSize="sm" fontWeight="600" color={tokens.colors.text.inverse}>
			{projectName}
		</Text>
		<Text fontSize="xs" color={tokens.colors.nav.icon}>v1.0.4</Text>
		<Separator orientation="vertical" height="16px" />
		<HStack gap={1}>
			<Box
				w="8px"
				h="8px"
				borderRadius="full"
				bg={isRunning ? tokens.colors.status.running : tokens.colors.nav.icon}
			/>
			<Text fontSize="xs" color={tokens.colors.nav.icon}>
				{isRunning ? "Running 1 of 2 tasks" : "Ready"}
			</Text>
		</HStack>
		<HStack gap={1}>
			<Box w="8px" h="8px" borderRadius="full" bg={tokens.colors.status.warning} />
			<Text fontSize="xs" color={tokens.colors.nav.icon}>4</Text>
		</HStack>
		<HStack gap={1}>
			<Box w="8px" h="8px" borderRadius="full" bg={tokens.colors.status.error} />
			<Text fontSize="xs" color={tokens.colors.nav.icon}>12</Text>
		</HStack>
	</Flex>
))

ProjectStatus.displayName = 'ProjectStatus'

export default ProjectStatus