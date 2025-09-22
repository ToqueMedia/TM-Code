import { Box, HStack, Text, Menu, Button } from '@chakra-ui/react'
import { FiFolder, FiGitBranch, FiClock } from 'react-icons/fi'
import { VscChevronDown } from "react-icons/vsc";
import type { RecentProject } from '../../types/project'

interface ProjectMenuProps {
	currentProjectName: string | undefined
	recentProjects: RecentProject[]
	onOpenFolder: () => void
	onCloneRepo: () => void
	onOpenRecent: (path: string) => void
}

const ProjectMenu = ({ 
	currentProjectName, 
	recentProjects, 
	onOpenFolder, 
	onCloneRepo, 
	onOpenRecent 
}: ProjectMenuProps) => (
	<HStack gap={2} pl={2} data-tauri-drag-region="false">
		<Menu.Root>
			<Menu.Trigger asChild>
				<Button
					size="xs"
					variant="ghost"
					color="#e6e6e6"
					px={2}
					height="24px"
					borderRadius="8px"
					_hover={{ bg: 'whiteAlpha.100' }}
					data-tauri-drag-region="false"
				>
					<HStack gap={2}>
						<Text fontSize="13px" color="#dcdcdc">{currentProjectName || 'Select project'}</Text>
						<VscChevronDown />
					</HStack>
				</Button>
			</Menu.Trigger>
			<Menu.Positioner className="no-drag" style={{ zIndex: 30000 }}>
				<Menu.Content
					className="no-drag"
					style={{ zIndex: 30000, minWidth: '380px' }}
					bg="#1e1e1e"
					border="1px solid #2b2b2c"
					borderRadius="10px"
					boxShadow="0 16px 48px rgba(0,0,0,0.6)"
					data-tauri-drag-region="false"
				>
					<Box px={3} py={2}>
						<HStack gap={2}>
							<Button size="sm" variant="outline" onClick={onOpenFolder} borderColor="#3c3c3c" _hover={{ bg: 'whiteAlpha.100' }}>
								<FiFolder /><span>Open Folder…</span>
							</Button>
							<Button size="sm" variant="outline" onClick={onCloneRepo} borderColor="#3c3c3c" _hover={{ bg: 'whiteAlpha.100' }}>
								<FiGitBranch /><span>Clone Repository…</span>
							</Button>
						</HStack>
					</Box>
					<Menu.Separator />
					<Box px={3} py={2} color="#7d8590" fontSize="12px" textTransform="uppercase" letterSpacing="0.08em">
						<HStack gap={2}><FiClock /><Text>Recent Projects</Text></HStack>
					</Box>
					{recentProjects.slice(0, 8).map(function rp(item) {
						const name = item.name || item.path.split('/').pop() || item.path
						const monogram = name.trim().slice(0, 2).toUpperCase()
						return (
							<Menu.Item value={item.path} key={item.path} onClick={function onClick() { onOpenRecent(item.path) }} _hover={{ bg: '#0b2a4a' }}>
								<HStack gap={3} alignItems="center" px={2} py={2}>
									<Box width="24px" height="24px" borderRadius="6px" bg="#2b2b2c" display="flex" alignItems="center" justifyContent="center" fontSize="12px" color="#d1d1d1" border="1px solid #3c3c3c">{monogram}</Box>
									<Box>
										<Text fontSize="13px" color="#e6e6e6">{name}</Text>
										<Text fontSize="11px" color="#7d8590">{item.path}</Text>
									</Box>
								</HStack>
							</Menu.Item>
						)
					})}
					{recentProjects.length === 0 && (
						<Box px={3} py={3} color="#7d8590" fontSize="13px">No recent projects</Box>
					)}
				</Menu.Content>
			</Menu.Positioner>
		</Menu.Root>
	</HStack>
)

export default ProjectMenu