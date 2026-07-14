import { useState } from 'react'
import { Box, HStack, Text, Menu, Button } from '@chakra-ui/react'
import { FiFolder, FiGitBranch, FiClock, FiHome, FiExternalLink } from 'react-icons/fi'
import { VscChevronDown } from "react-icons/vsc";
import type { RecentProject } from '../../types/project'
import { useProjectStore } from '../../stores/projectStore'
import { useProjectAgentStatuses } from '@/hooks/useProjectAgentStatuses'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface ProjectMenuProps {
	currentProjectName: string | undefined
	recentProjects: RecentProject[]
	onOpenFolder: () => void
	onCloneRepo: () => void
	onOpenRecent: (path: string) => void
}

// Dot colour for the cross-window agent-run badge (same semantics as the
// Welcome sidebar badge — see services/projectAgentStatusService.ts).
const AGENT_DOT_COLOR: Record<string, string> = {
	running: tokens.colors.accent.primary,
	done: tokens.colors.status.running,
	error: tokens.colors.status.error,
}

const ProjectMenu = ({
	currentProjectName,
	recentProjects,
	onOpenFolder,
	onCloneRepo,
	onOpenRecent
}: ProjectMenuProps) => {
	const [menuOpen, setMenuOpen] = useState(false)
	const currentProjectPath = useProjectStore(s => s.currentProject?.path)
	const visibleRecents = recentProjects.slice(0, 8)
	// Poll only while the dropdown is open — the titlebar menu is mounted for
	// the whole session and shouldn't tick IPC in the background.
	const agentStatuses = useProjectAgentStatuses(
		visibleRecents.map(p => p.path),
		menuOpen,
	)

	return (
	<HStack gap={2} pl={2} data-tauri-drag-region="false">
		<Menu.Root onOpenChange={(e) => setMenuOpen(e.open)}>
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
					{visibleRecents.map(function rp(item) {
						const name = item.name || item.path.split('/').pop() || item.path
						const monogram = name.trim().slice(0, 2).toUpperCase()
						const agentStatus = agentStatuses[item.path]
						const dotColor = agentStatus ? AGENT_DOT_COLOR[agentStatus.state] : undefined
						return (
							<Menu.Item value={item.path} key={item.path} onClick={function onClick() { onOpenRecent(item.path) }} _hover={{ bg: tokens.colors.bg.hover }}>
								<HStack gap={3} alignItems="center" px={2} py={2} width="100%">
									<Box width="24px" height="24px" borderRadius="6px" bg={tokens.colors.bg.overlay} display="flex" alignItems="center" justifyContent="center" fontSize="12px" color={tokens.colors.text.primary} border={`1px solid ${tokens.colors.border.default}`} flexShrink={0}>{monogram}</Box>
									<Box flex="1" minW={0}>
										<Text fontSize="13px" color={tokens.colors.text.primary}>{name}</Text>
										<Text fontSize="11px" color={tokens.colors.text.muted} lineClamp={1}>{item.path}</Text>
									</Box>
									{dotColor && (
										// Cross-window agent activity: pulsing = working now,
										// solid green/red = finished/failed since last visit.
										<Box
											title={agentStatus?.label || t('welcome.agentWorking')}
											width="7px"
											height="7px"
											borderRadius="full"
											bg={dotColor}
											flexShrink={0}
											css={{
												'@keyframes tmAgentPulseMenu': {
													'0%, 100%': { opacity: 1 },
													'50%': { opacity: 0.3 },
												},
												animation:
													agentStatus?.state === 'running'
														? 'tmAgentPulseMenu 1.2s ease-in-out infinite'
														: undefined,
											}}
										/>
									)}
									{item.path !== currentProjectPath && (
										// Parallel-work affordance: open this project in ANOTHER
										// window instead of switching (which cancels a running
										// agent). stopPropagation keeps the Menu.Item select
										// (= switch in place) from also firing.
										<Box
											as="button"
											title={t('misc.openInNewWindow')}
											aria-label={t('misc.openInNewWindow')}
											display="flex"
											alignItems="center"
											justifyContent="center"
											width="22px"
											height="22px"
											borderRadius="6px"
											color={tokens.colors.text.muted}
											flexShrink={0}
											_hover={{ bg: 'whiteAlpha.200', color: tokens.colors.text.primary }}
											onClick={(e: React.MouseEvent) => {
												e.stopPropagation()
												void invoke('open_new_instance', { projectPath: item.path }).catch(() => {})
											}}
										>
											<FiExternalLink size={12} />
										</Box>
									)}
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
}

export default ProjectMenu
