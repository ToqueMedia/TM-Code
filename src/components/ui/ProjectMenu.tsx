import { Box, HStack, Text, Menu, Button } from '@chakra-ui/react'
import { FiFolder, FiGitBranch, FiClock, FiHome } from 'react-icons/fi'
import { VscChevronDown } from "react-icons/vsc";
import type { RecentProject } from '../../types/project'
import { useProjectStore } from '../../stores/projectStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

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
					color={tokens.colors.text.primary}
					px={2}
					height="24px"
					borderRadius="8px"
					_hover={{ bg: 'whiteAlpha.100' }}
					data-tauri-drag-region="false"
				>
					<HStack gap={2}>
						<Text fontSize="13px" color={tokens.colors.text.primary}>{currentProjectName || 'Select project'}</Text>
						<VscChevronDown />
					</HStack>
				</Button>
			</Menu.Trigger>
			<Menu.Positioner className="no-drag" style={{ zIndex: 30000 }}>
				<Menu.Content
					className="no-drag"
					style={{ zIndex: 30000, minWidth: '380px' }}
					bg={tokens.colors.bg.app}
					border={`1px solid ${tokens.colors.border.subtle}`}
					borderRadius="10px"
					boxShadow={`0 16px 48px ${tokens.colors.bg.blackOverlayStrong}`}
					data-tauri-drag-region="false"
				>
					<Box px={3} py={2}>
						<HStack gap={2}>
							<Button
								size="sm"
								variant="outline"
								onClick={() => useProjectStore.getState().closeProject()}
								borderColor={tokens.colors.border.default}
								_hover={{ bg: 'whiteAlpha.100' }}
							>
								<FiHome /><span>{t("explorer.home")}</span>
							</Button>
							<Button size="sm" variant="outline" onClick={onOpenFolder} borderColor={tokens.colors.border.default} _hover={{ bg: 'whiteAlpha.100' }}>
								<FiFolder /><span>{t("menu.openFolder")}</span>
							</Button>
							<Button size="sm" variant="outline" onClick={onCloneRepo} borderColor={tokens.colors.border.default} _hover={{ bg: 'whiteAlpha.100' }}>
								<FiGitBranch /><span>{t("menu.openFolder")}</span>
							</Button>
						</HStack>
					</Box>
					<Menu.Separator />
					<Box px={3} py={2} color={tokens.colors.text.muted} fontSize="12px" textTransform="uppercase" letterSpacing="0.08em">
						<HStack gap={2}><FiClock /><Text>{t("explorer.recentProjects")}</Text></HStack>
					</Box>
					{recentProjects.slice(0, 8).map(function rp(item) {
						const name = item.name || item.path.split('/').pop() || item.path
						const monogram = name.trim().slice(0, 2).toUpperCase()
						return (
							<Menu.Item value={item.path} key={item.path} onClick={function onClick() { onOpenRecent(item.path) }} _hover={{ bg: tokens.colors.bg.hover }}>
								<HStack gap={3} alignItems="center" px={2} py={2}>
									<Box width="24px" height="24px" borderRadius="6px" bg={tokens.colors.bg.overlay} display="flex" alignItems="center" justifyContent="center" fontSize="12px" color={tokens.colors.text.primary} border={`1px solid ${tokens.colors.border.default}`}>{monogram}</Box>
									<Box>
										<Text fontSize="13px" color={tokens.colors.text.primary}>{name}</Text>
										<Text fontSize="11px" color={tokens.colors.text.muted}>{item.path}</Text>
									</Box>
								</HStack>
							</Menu.Item>
						)
					})}
					{recentProjects.length === 0 && (
						<Box px={3} py={3} color={tokens.colors.text.muted} fontSize="13px">{t("explorer.noRecent")}</Box>
					)}
				</Menu.Content>
			</Menu.Positioner>
		</Menu.Root>
	</HStack>
)

export default ProjectMenu