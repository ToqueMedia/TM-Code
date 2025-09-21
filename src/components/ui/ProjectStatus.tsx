import { memo } from 'react'
import { Flex, Text, Box, Separator, HStack } from '@chakra-ui/react'

// Xcode Project Status
const ProjectStatus = memo<{ projectName: string; isRunning: boolean }>(({ projectName, isRunning }: { projectName: string; isRunning: boolean }) => (
	<Flex align="center" gap={3}>
		<Text fontSize="sm" fontWeight="600" color="#ffffff">
			{projectName}
		</Text>
		<Text fontSize="xs" color="#8e8e93">v1.0.4</Text>
		<Separator orientation="vertical" height="16px" />
		<HStack gap={1}>
			<Box
				w="8px"
				h="8px"
				borderRadius="full"
				bg={isRunning ? "#28ca42" : "#8e8e93"}
			/>
			<Text fontSize="xs" color="#8e8e93">
				{isRunning ? "Running 1 of 2 tasks" : "Ready"}
			</Text>
		</HStack>
		<HStack gap={1}>
			<Box w="8px" h="8px" borderRadius="full" bg="#ff9500" />
			<Text fontSize="xs" color="#8e8e93">4</Text>
		</HStack>
		<HStack gap={1}>
			<Box w="8px" h="8px" borderRadius="full" bg="#ff3b30" />
			<Text fontSize="xs" color="#8e8e93">12</Text>
		</HStack>
	</Flex>
))

ProjectStatus.displayName = 'ProjectStatus'

export default ProjectStatus