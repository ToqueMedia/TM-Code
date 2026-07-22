import { useState } from 'react'
import { Box, HStack, Text, Menu, Button } from '@chakra-ui/react'
import { FiFolder, FiGitBranch, FiClock, FiHome, FiExternalLink, FiX } from 'react-icons/fi'
import { VscChevronDown } from "react-icons/vsc";
import type { RecentProject } from '../../types/project'
import { useProjectStore } from '../../stores/projectStore'
import { useParallelTaskStore, type ParallelTaskStatus } from '../../stores/parallelTaskStore'
import { useParallelTaskRows, openParallelTaskChat, closeParallelTask, openMainSessionChat } from '../../hooks/useParallelTaskRows'
import { requestTaskStop } from '../../services/agent/parallelTasks/taskStopRequestService'
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

const TASK_DOT_COLOR: Record<ParallelTaskStatus, string> = {
	running: tokens.colors.accent.primary,
	completed: tokens.colors.status.running,
	error: tokens.colors.status.error,
	queued: tokens.colors.text.muted,
	aborted: tokens.colors.text.muted,
}

const TASK_STATE_LABEL: Record<ParallelTaskStatus, () => string> = {
	running: () => t('welcome.agentWorking'),
	completed: () => t('welcome.agentDone'),
	error: () => t('welcome.agentError'),
	queued: () => t('parallel.queued'),
	aborted: () => t('parallel.taskStopped'),
}

const taskPulseCss = {
	'@keyframes tmAgentPulseMenu': {
		'0%, 100%': { opacity: 1 },
		'50%': { opacity: 0.3 },
	},
	animation: 'tmAgentPulseMenu 1.2s ease-in-out infinite',
}

/** Indented task row nested under a project folder in the dropdown. */
function TaskRow({
	value,
	dotColor,
	pulse,
	label,
	stateLabel,
	disabled,
	title,
	onSelect,
	onStop,
}: {
	value: string
	dotColor: string
	pulse: boolean
	label: string
	stateLabel: string
	disabled?: boolean
	title?: string
	onSelect: () => void
	onStop?: () => void
}) {
	return (
		<Menu.Item
			value={value}
			onClick={function onClick() { if (!disabled) onSelect() }}
			_hover={{ bg: tokens.colors.bg.hover }}
			title={title}
		>
			{/* pl aligns under the folder name (24px monogram + 12px gap). */}
			<HStack gap={2} alignItems="center" pl="44px" pr={2} py="4px" width="100%" opacity={disabled ? 0.55 : 1}>
				<Box
					width="7px"
					height="7px"
					borderRadius="full"
					bg={dotColor}
					flexShrink={0}
					css={pulse ? taskPulseCss : undefined}
				/>
				<Text fontSize="12px" color={tokens.colors.text.primary} lineClamp={1} flex={1} minW={0}>
					{label}
				</Text>
				<Text fontSize="10px" color={tokens.colors.text.muted} flexShrink={0} textTransform="uppercase" letterSpacing="0.04em">
					{stateLabel}
				</Text>
				{onStop && (
					<Box
						as="button"
						title={t('parallel.stopTask')}
						aria-label={t('parallel.stopTask')}
						display="flex"
						alignItems="center"
						justifyContent="center"
						width="20px"
						height="20px"
						borderRadius="6px"
						color={tokens.colors.text.muted}
						flexShrink={0}
						_hover={{ bg: 'whiteAlpha.200', color: tokens.colors.status.error }}
						onClick={(e: React.MouseEvent) => {
							// Keep the Menu.Item select (= open the task chat) from firing.
							e.stopPropagation()
							onStop()
						}}
					>
						<FiX size={12} />
					</Box>
				)}
			</HStack>
		</Menu.Item>
	)
}

/**
 * The CURRENT project's parallel tasks, nested under its folder row. Mounted
 * only while the dropdown is open (useParallelTaskRows subscribes to the live
 * store, which updates per tool event — a permanent subscription would
 * re-render the titlebar continuously).
 *
 * Single source with the Welcome sidebar (useParallelTaskRows): live runs ∪
 * persisted task sessions — tasks never vanish; each one's chat stays
 * consultable after reload. Clicking opens the task's chat (safe mid-run:
 * streaming writes are bound to streamingSessionId, not the visible session).
 * needsAuth → amber "authorization" state; the dialog names the task too.
 */
function CurrentProjectTaskRows({
	projectPath,
	isCurrent,
	onOpenRecent,
}: {
	projectPath: string
	isCurrent: boolean
	onOpenRecent: (path: string) => void
}) {
	// Projetos de outras janelas leem do disco com poll lento (limitação #3).
	const rows = useParallelTaskRows(projectPath, true, isCurrent ? undefined : { pollMs: 7000 })
	const abort = useParallelTaskStore(s => s.abort)
	if (rows.length === 0) return null

	return (
		<>
			{rows.map(row => (
				<TaskRow
					key={row.key}
					value={`task:${row.key}`}
					dotColor={row.needsAuth ? tokens.colors.status.warning : TASK_DOT_COLOR[row.status]}
					pulse={row.needsAuth || row.status === 'running'}
					label={row.worktreeBranch ? `⎇ ${row.label}` : row.label}
					stateLabel={row.needsAuth ? t('parallel.authNeeded') : TASK_STATE_LABEL[row.status]()}
					disabled={!row.sessionId}
					title={row.needsAuth
						? t('parallel.authNeededHint')
						: row.worktreeBranch
							? `${row.prompt ?? ''}\n⎇ ${row.worktreeBranch}`.trim()
							: row.prompt}
					onSelect={() => {
						if (isCurrent && row.sessionId) void openParallelTaskChat(projectPath, row.sessionId)
						else if (!isCurrent) onOpenRecent(projectPath)
					}}
					onStop={row.status === 'running' || row.status === 'queued'
						// Viva NESTA janela: X = Stop direto. Noutra janela: pedido de
						// stop por disco (runner dono consome; nunca apagar o chat dele).
						? (row.live
							? () => abort(row.runId!)
							: row.sessionId
								? () => { void requestTaskStop(projectPath, row.sessionId!) }
								: undefined)
						: row.sessionId && isCurrent
							? () => { void closeParallelTask(projectPath, row.sessionId!) }
							: undefined}
				/>
			))}
		</>
	)
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
							const isCurrent = item.path === currentProjectPath
							return (
								// Folder row + nested task rows — the parallel-work tree lives
								// INSIDE this menu (user decision 2026-07-16; the floating dock
								// under the composer was removed). display:contents keeps the
								// wrapper out of the menu layout flow.
								<Box key={item.path} display="contents">
								<Menu.Item value={item.path} onClick={function onClick() { onOpenRecent(item.path) }} _hover={{ bg: tokens.colors.bg.hover }}>
									<HStack gap={3} alignItems="center" px={2} py={2} width="100%">
										<Box width="24px" height="24px" borderRadius="6px" bg={tokens.colors.bg.overlay} display="flex" alignItems="center" justifyContent="center" fontSize="12px" color={tokens.colors.text.primary} border={`1px solid ${tokens.colors.border.default}`} flexShrink={0}>{monogram}</Box>
										<Box flex="1" minW={0}>
											<Text fontSize="13px" color={tokens.colors.text.primary}>{name}</Text>
											<Text fontSize="11px" color={tokens.colors.text.muted} lineClamp={1}>{item.path}</Text>
										</Box>
										{!isCurrent && (
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
								{/* Agent run of this project (cross-window badge file): clicking
								    the TASK NAME shows that task's chat — current window: switch to
								    the chat view (the run streams into the active session); other
								    project: open it, which restores its running session. */}
								{agentStatus && AGENT_DOT_COLOR[agentStatus.state] && (
									<TaskRow
										value={`agent:${item.path}`}
										dotColor={AGENT_DOT_COLOR[agentStatus.state]}
										pulse={agentStatus.state === 'running'}
										label={agentStatus.label || t('welcome.agentWorking')}
										stateLabel={
											agentStatus.state === 'running'
												? t('welcome.agentWorking')
												: agentStatus.state === 'done'
													? t('welcome.agentDone')
													: t('welcome.agentError')
										}
										title={agentStatus.description || agentStatus.label || undefined}
										onSelect={() => {
											if (isCurrent) {
												// Volta ao chat PRINCIPAL (a porta) — só mudar a vista
												// deixava o user preso no chat de uma tarefa.
												openMainSessionChat(item.path)
											} else {
												onOpenRecent(item.path)
											}
										}}
									/>
								)}
								{/* This window's parallel tasks, nested under its project. Mounted
								    only while the menu is open (see CurrentProjectTaskRows). */}
								{menuOpen && <CurrentProjectTaskRows projectPath={item.path} isCurrent={isCurrent} onOpenRecent={onOpenRecent} />}
								</Box>
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
