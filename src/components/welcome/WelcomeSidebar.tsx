import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  Box,
  Flex,
  Heading,
  Text,
  VStack,
  HStack,
  Icon,
} from '@chakra-ui/react'
import {
  LuFolderOpen,
  LuGitBranch,
  LuClock,
  LuSettings,
  LuEraser,
  LuPlus,
  LuCheck,
  LuLayers,
  LuExternalLink,
  LuX,
  LuMessagesSquare,
} from 'react-icons/lu'
import { FiAlertCircle, FiLogOut } from 'react-icons/fi'
import { getVersion } from '@tauri-apps/api/app'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { showProjectContextMenu } from '@/components/projectContextMenu'
import { useProjectAgentStatuses, type ProjectAgentStatus } from '@/hooks/useProjectAgentStatuses'
import {
  getCommandQueueSnapshot,
  remove as removeFromQueue,
  subscribeToCommandQueue,
} from '@/services/agent/messageQueue'
import { invoke } from '@/utils/invokeMetrics'
import { useAuthStore } from '@/stores/authStore'
import { useProjectStore } from '@/stores/projectStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { useChatStore } from '@/stores/chatStore'
import { useParallelTaskRows, openParallelTaskChat, closeParallelTask, openMainSessionChat } from '@/hooks/useParallelTaskRows'
import { requestTaskStop } from '@/services/agent/parallelTasks/taskStopRequestService'
import { useBillingStore, isTeamCollabActive } from '@/stores/billingStore'
import { useCollabStore } from '@/stores/collabStore'
import { getQueryGuard } from '@/services/agent/queryGuard'
import { signOutWithGuard } from '@/services/auth/signOutFlow'
import type { PromptValue, QueuedCommand } from '@/types/messageQueueTypes'
import type { RecentProject } from '@/types/project'

// Cache the version promise — it never changes during the session.
let versionPromise: Promise<string> | null = null
function getAppVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = getVersion()
      .then(v => `v${v}`)
      .catch(() => '')
  }
  return versionPromise
}

// ─── Time helpers ───────────────────────────────────────────────────────
function relativeTime(dateStr?: string): string | null {
  if (!dateStr) return null
  const now = new Date()
  // Rust stores last_opened as unix seconds (e.g. "1748112000")
  const then = /^\d+$/.test(dateStr)
    ? new Date(Number(dateStr) * 1000)
    : new Date(dateStr)
  const diffMs = now.getTime() - then.getTime()
  if (diffMs < 0) return null

  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return t('welcome.today')
  if (diffMin < 60) return null // don't show minutes

  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return t('welcome.today')

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return t('welcome.yesterday')
  if (diffDays <= 30) return t('welcome.daysAgo').replace('{n}', String(diffDays))

  // Older than 30 days: show short date
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Compact "2m / 3h / 5d" for task rows (image-style timestamps). */
function shortAgo(epochMs: number): string | null {
  const diff = Date.now() - epochMs
  if (!Number.isFinite(diff) || diff < 0) return null
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('welcome.justNow')
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Single-line preview of a queued command's value (text + attachment count). */
function queuedPreview(value: PromptValue): string {
  if (typeof value === 'string') return value
  const texts: string[] = []
  let attachments = 0
  for (const block of value) {
    if (block.type === 'text') texts.push(block.text)
    else attachments++
  }
  const joined = texts.join(' ')
  return attachments > 0 ? `${joined} [${attachments}]`.trim() : joined
}

function getInitials(email: string | null, displayName: string | null): string {
  if (displayName) {
    const parts = displayName.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return parts[0].substring(0, 2).toUpperCase()
  }
  if (email) {
    const local = email.split('@')[0]
    const parts = local.split(/[._-]/)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return local.substring(0, 2).toUpperCase()
  }
  return '?'
}

interface WelcomeSidebarProps {
  recentProjects: RecentProject[]
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepository: () => void
  onOpenProject: (path?: string) => void
  activeProjectPath?: string | null
  /** Clear the recent projects list. The caller handles the confirmation
   *  dialog; this component just surfaces the button. */
  onClearRecent?: () => void
}

const WelcomeSidebar: React.FC<WelcomeSidebarProps> = ({
  recentProjects,
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onOpenProject,
  activeProjectPath,
  onClearRecent,
}) => {
  const [appVersion, setAppVersion] = useState('')

  // Cross-window agent activity for every project in the list. Polling-based
  // on purpose: each window is a separate OS process, disk is the only
  // shared channel (see useProjectAgentStatuses).
  const agentStatuses = useProjectAgentStatuses(recentProjects.map(p => p.path))

  // Queued TASKS of the project open in THIS window — they render as
  // children of its folder, alongside the running row (the "features em
  // paralelo" tree from the reference design). Steering entries stay in the
  // composer strip: they are course corrections, not units of work.
  const queuedCommands = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
  const queuedTasks = queuedCommands.filter(c => c.asTask === true)

  // Live agent busy flag for THIS window — drives "+ Nova tarefa" under the
  // active project (QueryGuard is the same source the composer uses).
  const queryGuard = getQueryGuard()
  const isAgentBusy = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)
  // Tarefas paralelas vivas mantêm o "+ Nova tarefa" disponível com o main
  // idle — lançar mais uma tarefa não exige um run principal (Fase 2).
  const anyLiveTask = useParallelTaskStore(s => {
    for (const r of s.runs.values()) {
      if (r.status === 'running' || r.status === 'queued') return true
    }
    return false
  })

  useEffect(() => {
    getAppVersion().then(setAppVersion)
  }, [])

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, project: RecentProject) => {
    e.preventDefault()
    e.stopPropagation()
    showProjectContextMenu(project).catch(() => {})
  }, [])

  return (
    <Box
      width="clamp(200px, 30vw, 300px)"
      minWidth="clamp(200px, 30vw, 300px)"
      maxWidth="300px"
      h="100%"
      minH={0}
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(24px)"
      borderRight="1px solid"
      borderColor="rgba(255, 255, 255, 0.05)"
      display="flex"
      flexDirection="column"
      py={{ base: 4, md: 6 }}
      px={{ base: 3, md: 4 }}
      pt={{ base: 6, md: 8 }}
      data-no-drag
      position="relative"
      overflow="hidden"
      css={{
        '@media (max-width: 520px)': {
          '& [data-sidebar-logo]': {
            marginBottom: '14px',
          },
          '& [data-sidebar-logo-mark]': {
            width: '26px',
            height: '26px',
            marginRight: '8px',
          },
          '& [data-sidebar-logo-title]': {
            fontSize: '15px',
          },
          '& [data-sidebar-actions]': {
            marginBottom: '18px',
          },
          '& [data-sidebar-clear-label], & [data-sidebar-task-time], & [data-sidebar-footer-version]': {
            display: 'none',
          },
          '& [data-sidebar-section-label]': {
            fontSize: '10px',
            letterSpacing: '0.08em',
          },
        },
      }}
    >
      {/* Logo */}
      <Flex data-sidebar-logo alignItems="center" mb={5} position="relative">
        <Box
          data-sidebar-logo-mark
          width="30px"
          height="30px"
          mr={2.5}
          flexShrink={0}
          filter="drop-shadow(0 4px 12px rgba(254, 16, 99, 0.35))"
        >
          <img
            src="/isologo.svg"
            alt="TM Code"
            style={{ width: '100%', height: '100%' }}
          />
        </Box>
        <Heading
          data-sidebar-logo-title
          fontSize="16px"
          fontWeight="800"
          color="white"
          letterSpacing="-0.3px"
        >
          TM Code
        </Heading>
      </Flex>

      {/* Primary actions — flat rows (reference design), no cards */}
      <VStack data-sidebar-actions align="stretch" gap="2px" mb={6} position="relative">
        {[
          { icon: LuPlus, label: t('welcome.newProject'), onClick: onNewProject },
          { icon: LuFolderOpen, label: t('welcome.openProject'), onClick: onOpenFolder },
          { icon: LuGitBranch, label: t('welcome.cloneRepo'), onClick: onCloneRepository },
        ].map(action => (
          <Flex
            key={action.label}
            as="button"
            alignItems="center"
            gap={2.5}
            w="100%"
            px={2}
            py="7px"
            borderRadius="8px"
            color={tokens.colors.text.secondary}
            cursor="pointer"
            transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}`}
            textAlign="left"
            _hover={{ bg: 'rgba(255, 255, 255, 0.05)', color: tokens.colors.text.primary }}
            onClick={action.onClick}
          >
            <Icon as={action.icon} fontSize="15px" flexShrink={0} />
            <Text fontSize="13px" fontWeight="500" flex={1} lineClamp={1}>
              {action.label}
            </Text>
          </Flex>
        ))}
      </VStack>

      {/* Recent projects — folder groups with the parallel work nested inside */}
      <VStack align="stretch" flex={1} overflow="hidden" minH={0}>
        <HStack data-sidebar-section-row px={2} mb={2} justify="space-between">
          <HStack gap={2}>
            <Icon color={tokens.colors.text.muted} fontSize="12px">
              <LuClock />
            </Icon>
            <Text
              data-sidebar-section-label
              fontSize="11px"
              fontWeight="700"
              textTransform="uppercase"
              color={tokens.colors.text.muted}
              letterSpacing="1px"
            >
              {t('welcome.recent')}
            </Text>
          </HStack>

          {/* Clear-all button */}
          {onClearRecent && recentProjects.length > 0 && (
            <Flex
              as="button"
              alignItems="center"
              justifyContent="center"
              gap={1}
              px={2}
              h="22px"
              borderRadius="6px"
              bg="transparent"
              border="1px solid transparent"
              cursor="pointer"
              transition="all 0.15s ease"
              _hover={{
                bg: 'rgba(254, 16, 99, 0.08)',
                borderColor: 'rgba(254, 16, 99, 0.25)',
              }}
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClearRecent() }}
              title={t('welcome.clearRecentTitle')}
              aria-label={t('welcome.clearRecentTitle')}
            >
              <Icon color={tokens.colors.text.muted} fontSize="11px">
                <LuEraser />
              </Icon>
              <Text
                data-sidebar-clear-label
                fontSize="9px"
                fontWeight="700"
                textTransform="uppercase"
                letterSpacing="0.08em"
                color={tokens.colors.text.muted}
              >
                {t('welcome.clearRecent')}
              </Text>
            </Flex>
          )}
        </HStack>

        <VStack
          align="stretch"
          gap="2px"
          flex={1}
          overflowY="auto"
          minH={0}
          css={{
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '4px',
            },
          }}
        >
          {recentProjects.length === 0 && (
            <Text fontSize="12px" color={tokens.colors.text.muted} px={3} py={4} textAlign="center">
              {t('welcome.noRecent')}
            </Text>
          )}

          {recentProjects.map((project, index) => (
            <ProjectGroup
              key={project.id || `project-${index}`}
              project={project}
              isActive={activeProjectPath === project.path}
              isAgentBusyHere={activeProjectPath === project.path && (isAgentBusy || anyLiveTask)}
              agentStatus={agentStatuses[project.path] ?? null}
              queuedTasks={activeProjectPath === project.path ? queuedTasks : []}
              onOpen={() => project.path && onOpenProject(project.path)}
              onContextMenu={(e) => handleProjectContextMenu(e, project)}
            />
          ))}
        </VStack>
      </VStack>

      {/* Team section — project-INDEPENDENT (v1.0.1). Shows only while the team
          plan is active; the team indicator + team chat are reachable from the
          Welcome screen, no project required. */}
      <TeamSection />

      {/* Footer — avatar + name + settings (reference layout) */}
      <UserFooter appVersion={appVersion} />
    </Box>
  )
}

/** Team indicator + Team Chat entry point on the Welcome screen. Self-contained:
 *  reads the team-plan gate + collab presence directly. Hidden unless the team
 *  plan is active (membership AND non-expired term). The chat button opens the
 *  TeamChatPanel, which WelcomeScreen mounts while no project is open. */
function TeamSection() {
  const teamActive = useBillingStore(isTeamCollabActive)
  const connected = useCollabStore(s => s.connected)
  const peers = useCollabStore(s => s.peers)
  const chatUnread = useCollabStore(s => s.chatUnread)
  const setChatOpen = useCollabStore(s => s.setChatOpen)

  if (!teamActive) return null

  return (
    <VStack align="stretch" gap="2px" mt={3} pt={3} borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
      <Flex align="center" gap={2} px={1} mb={1}>
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={connected ? tokens.colors.accent.greenBright : tokens.colors.text.muted}
          flexShrink={0}
        />
        <Text fontSize="10px" fontWeight="700" letterSpacing="0.06em" textTransform="uppercase" color={tokens.colors.text.muted}>
          {t('settings.teamTitle')}
        </Text>
        {connected && (
          <Text fontSize="10px" color={tokens.colors.text.disabled}>
            {t('team.peersOnline').replace('{count}', String(peers.length))}
          </Text>
        )}
      </Flex>
      <Flex
        as="button"
        align="center"
        gap={2}
        px={2}
        py={1.5}
        borderRadius="6px"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255,255,255,0.05)' }}
        onClick={() => setChatOpen(true)}
      >
        <LuMessagesSquare size={14} color={tokens.colors.text.secondary} />
        <Text fontSize="12px" color={tokens.colors.text.secondary}>{t('team.chatTitle')}</Text>
        {chatUnread > 0 && (
          <Box
            ml="auto"
            px={1.5}
            minW="16px"
            textAlign="center"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            color={tokens.colors.badge.notificationText}
            fontSize="9px"
            fontWeight="700"
          >
            {chatUnread}
          </Box>
        )}
      </Flex>
    </VStack>
  )
}

// ─── Project group (folder + nested parallel work) ──────────────────────

interface ProjectGroupProps {
  project: RecentProject
  isActive: boolean
  /** Agent is busy in THIS window on this project (drives "+ Nova tarefa"). */
  isAgentBusyHere: boolean
  agentStatus: ProjectAgentStatus | null
  queuedTasks: QueuedCommand[]
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function ProjectGroup({
  project,
  isActive,
  isAgentBusyHere,
  agentStatus,
  queuedTasks,
  onOpen,
  onContextMenu,
}: ProjectGroupProps) {
  const timeLabel = relativeTime(project.lastOpened)
  // A sessão ATIVA é a principal (não-tarefa)? Controla o highlight da row do
  // chat principal — antes o highlight marcava o PROJECTO e ficava "presa"
  // com o chat de uma tarefa aberto (feedback do user 2026-07-17).
  const activeIsMainSession = useChatStore(s => {
    const id = s.activeSessionId
    if (!id) return true
    return s.sessions.get(id)?.isParallelTask !== true
  })
  const hasChildren =
    !!agentStatus || queuedTasks.length > 0 || isAgentBusyHere

  const openInNewWindow = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!project.path) return
    void invoke('open_new_instance', { projectPath: project.path }).catch(() => {})
  }, [project.path])

  const requestNewTask = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    window.dispatchEvent(new CustomEvent('app:new-task'))
  }, [])

  return (
    <Box
      role="group"
      css={{
        // Hover actions on the folder row stay invisible until the group is
        // hovered — keeps the tree calm at rest (reference rhythm).
        '& [data-sidebar-hover-action]': { opacity: 0 },
        '&:hover [data-sidebar-hover-action]': { opacity: 1 },
        '& [data-sidebar-hover-action]:focus-visible': { opacity: 1 },
      }}
    >
      {/* Folder row */}
      <Flex
        alignItems="center"
        gap={2}
        px={2}
        py="6px"
        borderRadius="8px"
        cursor="pointer"
        transition={`background ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        title={project.path}
      >
        <Icon
          as={LuFolderOpen}
          fontSize="15px"
          flexShrink={0}
          color={isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
        />
        <Text
          fontSize="13px"
          fontWeight={isActive ? '650' : '500'}
          color={isActive ? tokens.colors.text.primary : tokens.colors.text.secondary}
          lineClamp={1}
          flex={1}
          minW={0}
        >
          {project.name}
        </Text>
        {/* Open in another window — hidden for the project THIS window owns
            (same project in two windows collides on the shared state dir). */}
        {!isActive && project.path && (
          <Flex
            as="button"
            data-sidebar-hover-action
            alignItems="center"
            justifyContent="center"
            w="22px"
            h="22px"
            borderRadius="6px"
            flexShrink={0}
            color={tokens.colors.text.muted}
            cursor="pointer"
            transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}, opacity ${tokens.transition.fast}`}
            _hover={{ bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary }}
            onClick={openInNewWindow}
            title={t('welcome.openInNewWindowTitle')}
            aria-label={t('welcome.openInNewWindowTitle')}
          >
            <LuExternalLink size={12} />
          </Flex>
        )}
        {!hasChildren && timeLabel && (
          <Text data-sidebar-task-time fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0} opacity={0.7}>
            {timeLabel}
          </Text>
        )}
      </Flex>

      {/* Children: the parallel work under this project */}
      {agentStatus?.state === 'running' && (
        <TaskRow
          highlight={isActive && activeIsMainSession}
          dot={{ color: tokens.colors.accent.primary, pulse: true }}
          label={agentStatus.label || t('welcome.agentWorking')}
          description={agentStatus.description}
          // startedAt → "· 12m"; falls back to nothing on pre-field files.
          time={agentStatus.startedAt ? shortAgo(agentStatus.startedAt) : null}
          onClick={() => {
            onOpen()
            if (isActive) openMainSessionChat(project.path)
          }}
        />
      )}
      {agentStatus?.state === 'done' && (
        <TaskRow
          highlight={isActive && activeIsMainSession}
          icon={<Icon as={LuCheck} fontSize="12px" color={tokens.colors.status.running} />}
          label={agentStatus.label || t('welcome.agentDone')}
          description={agentStatus.description}
          time={shortAgo(agentStatus.updatedAt)}
          onClick={() => {
            onOpen()
            if (isActive) openMainSessionChat(project.path)
          }}
        />
      )}
      {agentStatus?.state === 'error' && (
        <TaskRow
          highlight={isActive && activeIsMainSession}
          dot={{ color: tokens.colors.status.error, pulse: false }}
          label={agentStatus.label || t('welcome.agentError')}
          description={agentStatus.description}
          time={shortAgo(agentStatus.updatedAt)}
          onClick={() => {
            onOpen()
            if (isActive) openMainSessionChat(project.path)
          }}
        />
      )}
      {/* Parallel tasks of THIS window ("Nova tarefa" → start immediately,
          up to 4 at once) — nested right below the main run's row, per the
          user's design (2026-07-16). They live in parallelTaskStore, which
          is process-local, so only the ACTIVE project can have them. */}
      <ParallelTaskSidebarRows projectPath={project.path} isActiveProject={isActive} onOpenProject={onOpen} />
      {queuedTasks.map((task, index) => (
        <TaskRow
          key={task.uuid ?? `queued-${index}`}
          icon={<Icon as={LuLayers} fontSize="12px" color={tokens.colors.accent.purple} />}
          label={queuedPreview(task.value)}
          time={t('welcome.taskQueued')}
          onClick={onOpen}
          onRemove={() => removeFromQueue([task])}
        />
      ))}
      {/* Shortcut: focus composer already in "Nova tarefa" mode. Only for
          the project open in THIS window while a run is live. */}
      {isAgentBusyHere && (
        <Flex
          as="button"
          alignItems="center"
          gap={2}
          pl="26px"
          pr={2}
          py="5px"
          w="100%"
          borderRadius="8px"
          cursor="pointer"
          color={tokens.colors.text.muted}
          transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(255, 255, 255, 0.04)', color: tokens.colors.text.secondary }}
          onClick={requestNewTask}
          title={t('welcome.newTaskTitle')}
          aria-label={t('welcome.newTaskTitle')}
        >
          <LuPlus size={12} />
          <Text fontSize="12px" fontWeight="500">
            {t('welcome.newTask')}
          </Text>
        </Flex>
      )}
    </Box>
  )
}

/** Estado → texto curto da coluna direita da row (par do "agora"/"hoje"). */
const PARALLEL_STATE_LABEL: Record<'running' | 'queued' | 'completed' | 'error' | 'aborted', () => string> = {
  running: () => t('welcome.agentWorking'),
  queued: () => t('parallel.queued'),
  completed: () => t('welcome.agentDone'),
  error: () => t('welcome.agentError'),
  aborted: () => t('parallel.taskStopped'),
}

/**
 * Rows das tarefas paralelas do projecto, aninhadas sob a row do run
 * principal. Fonte única: useParallelTaskRows (vivas do parallelTaskStore ∪
 * sessões-tarefa persistidas) — as tarefas NUNCA desaparecem; o chat de cada
 * uma fica consultável mesmo depois de reload (pedido do user 2026-07-16).
 *
 * Clique no NOME → abre o chat da tarefa (seguro mid-run: o streaming do
 * agente principal escreve na sessão captada em startAssistantMessage, não
 * na sessão visível). X só nas VIVAS = Stop; rows históricas não têm remoção.
 * `needsAuth` → badge âmbar "Autorização" a pulsar: um pedido de permissão
 * desta tarefa espera resposta — clicar leva ao chat onde o diálogo vive.
 */
function ParallelTaskSidebarRows({
  projectPath,
  isActiveProject,
  onOpenProject,
}: {
  projectPath: string
  /** Projecto aberto NESTA janela — cliques abrem o chat da tarefa; para
   *  projetos de outras janelas o clique abre o projecto (fluxo existente). */
  isActiveProject: boolean
  onOpenProject: () => void
}) {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  // Projetos de outras janelas: o disco é o canal (limitação #3 eliminada) —
  // poll lento do índice de sumários; o heartbeat 30s do runner mantém o
  // 'running' fidedigno.
  // refreshTick força re-fetch do índice após um fecho (a sessão apagada
  // desaparece da lista sem esperar pelo próximo poll).
  const [refreshTick, setRefreshTick] = React.useState(0)
  const rows = useParallelTaskRows(
    projectPath,
    true,
    isActiveProject ? { refreshKey: refreshTick } : { pollMs: 7000, refreshKey: refreshTick },
  )
  const abort = useParallelTaskStore(s => s.abort)
  if (rows.length === 0) return null

  return (
    <>
      {rows.map(row => (
        <TaskRow
          key={row.key}
          dot={
            row.needsAuth
              ? { color: tokens.colors.status.warning, pulse: true }
              : row.status === 'completed'
                ? undefined
                : {
                    color:
                      row.status === 'running'
                        ? tokens.colors.accent.primary
                        : row.status === 'error'
                          ? tokens.colors.status.error
                          : tokens.colors.text.muted,
                    pulse: row.status === 'running',
                  }
          }
          icon={
            !row.needsAuth && row.status === 'completed'
              ? <Icon as={LuCheck} fontSize="12px" color={tokens.colors.status.running} />
              : undefined
          }
          label={row.worktreeBranch ? `⎇ ${row.label}` : row.label}
          description={row.needsAuth
            ? t('parallel.authNeededHint')
            : row.worktreeBranch
              ? `${row.prompt ?? ''}\n⎇ ${row.worktreeBranch}`.trim()
              : row.prompt}
          time={
            row.attentionKind === 'question'
              ? t('parallel.questionNeeded')
              : row.attentionKind === 'credentials'
                ? t('parallel.credentialsNeeded')
                : row.needsAuth
                  ? t('parallel.authNeeded')
                  : PARALLEL_STATE_LABEL[row.status]()
          }
          highlight={row.needsAuth || (isActiveProject && !!row.sessionId && row.sessionId === activeSessionId)}
          onClick={() => {
            onOpenProject()
            if (isActiveProject && row.sessionId) void openParallelTaskChat(projectPath, row.sessionId)
          }}
          onRemove={row.status === 'running' || row.status === 'queued'
            // Viva NESTA janela: X = Stop direto. Noutra janela: PEDIDO de stop
            // por disco (o runner dono consome no turn boundary/heartbeat) —
            // nunca fechar/apagar o chat debaixo do runner do outro processo.
            ? (row.live
                ? () => abort(row.runId!)
                : row.sessionId
                  ? () => { void requestTaskStop(projectPath, row.sessionId!) }
                  : undefined)
            : row.sessionId
              ? () => { void closeParallelTask(projectPath, row.sessionId!).then(closed => { if (closed) setRefreshTick(x => x + 1) }) }
              : undefined}
        />
      ))}
    </>
  )
}

function TaskRow({
  label,
  description,
  time,
  dot,
  icon,
  highlight = false,
  onClick,
  onRemove,
}: {
  label: string
  /** Descrição escrita pelo user — junta-se ao título no tooltip nativo. */
  description?: string | null
  time?: string | null
  dot?: { color: string; pulse: boolean }
  icon?: React.ReactNode
  highlight?: boolean
  onClick: () => void
  onRemove?: () => void
}) {
  return (
    <Flex
      alignItems="center"
      gap={2}
      pl="26px"
      pr={2}
      py="5px"
      borderRadius="8px"
      cursor="pointer"
      bg={highlight ? 'rgba(255, 255, 255, 0.06)' : 'transparent'}
      transition={`background ${tokens.transition.fast}`}
      role="group"
      css={{
        '& [data-sidebar-task-remove]': { opacity: 0 },
        '&:hover [data-sidebar-task-remove]': { opacity: 1 },
        '& [data-sidebar-task-remove]:focus-visible': { opacity: 1 },
      }}
      _hover={{ bg: highlight ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.04)' }}
      onClick={onClick}
      title={description ? `${label}\n\n${description}` : label}
    >
      {dot && (
        <Box
          w="7px"
          h="7px"
          borderRadius="full"
          bg={dot.color}
          flexShrink={0}
          css={dot.pulse ? {
            '@keyframes tmSidebarTaskPulse': {
              '0%, 100%': { opacity: 1 },
              '50%': { opacity: 0.35 },
            },
            animation: 'tmSidebarTaskPulse 1.2s ease-in-out infinite',
          } : undefined}
        />
      )}
      {icon}
      <Text fontSize="12px" color={tokens.colors.text.secondary} lineClamp={1} flex={1} minW={0}>
        {label}
      </Text>
      {onRemove && (
        <Flex
          as="button"
          data-sidebar-task-remove
          alignItems="center"
          justifyContent="center"
          w="18px"
          h="18px"
          borderRadius="4px"
          flexShrink={0}
          color={tokens.colors.text.muted}
          cursor="pointer"
          transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}, opacity ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(254, 16, 99, 0.12)', color: tokens.colors.accent.primary }}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation()
            onRemove()
          }}
          title={t('welcome.removeQueuedTask')}
          aria-label={t('welcome.removeQueuedTask')}
        >
          <LuX size={11} />
        </Flex>
      )}
      {time && (
        <Text data-sidebar-task-time fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
          {time}
        </Text>
      )}
    </Flex>
  )
}

// ─── User footer (avatar + menu, reference layout) ──────────────────────

function UserFooter({ appVersion }: { appVersion: string }) {
  const user = useAuthStore(s => s.user)
  const [menuOpen, setMenuOpen] = useState(false)

  const initials = user ? getInitials(user.email, user.displayName) : '?'
  // Fallback to the email's local part, capitalized (e.g. "kwanzaonline" →
  // "Kwanzaonline"), matching the Settings profile so both surfaces agree.
  const emailName = user?.email?.split('@')[0] ?? ''
  const displayName = user?.displayName?.trim()
    || (emailName ? emailName.charAt(0).toUpperCase() + emailName.slice(1) : '')

  // Mesma lógica dual do antigo menu do titlebar: sem projecto → ecrã de
  // settings do Welcome; com projecto → viewMode settings do workspace.
  const openSettings = useCallback(() => {
    setMenuOpen(false)
    const project = useProjectStore.getState()
    if (!project.currentProject) {
      project.setWelcomeScreen(project.welcomeScreen === 'settings' ? 'hero' : 'settings')
      return
    }
    const layout = useLayoutStore.getState()
    if (layout.viewMode === 'settings') {
      layout.goBack()
    } else {
      layout.setViewMode('settings')
    }
  }, [])

  return (
    <Box
      pt={3}
      mt={3}
      borderTop="1px solid rgba(255,255,255,0.05)"
      flexShrink={0}
      position="relative"
    >
      {/* Dropdown-up menu */}
      {menuOpen && (
        <>
          {/* Overlay para fechar com clique fora */}
          <Box position="fixed" inset={0} zIndex={999} onClick={() => setMenuOpen(false)} />
          <Box
            position="absolute"
            bottom="calc(100% + 6px)"
            left={0}
            right={0}
            zIndex={1000}
            bg={tokens.colors.dialog.bg}
            border={`1px solid ${tokens.colors.border.panel}`}
            borderRadius="10px"
            boxShadow="0 -8px 28px rgba(0,0,0,0.4)"
            py={1}
          >
            {[
              {
                icon: <LuSettings size={13} />,
                label: t('menu.settings'),
                onClick: openSettings,
              },
              {
                icon: <FiAlertCircle size={13} />,
                label: t('issueReporter.menuItem'),
                onClick: () => {
                  setMenuOpen(false)
                  // O dialog global vive no MinimalTitleBar; este evento
                  // já era o canal usado pelo menu nativo.
                  window.dispatchEvent(new CustomEvent('app:report-issue'))
                },
              },
              {
                icon: <FiLogOut size={13} />,
                label: t('common.signOut'),
                onClick: () => {
                  setMenuOpen(false)
                  void signOutWithGuard()
                },
              },
            ].map(item => (
              <Flex
                key={item.label}
                align="center"
                gap={2}
                px={3}
                py="7px"
                cursor="pointer"
                role="button"
                color={tokens.colors.text.secondary}
                transition={`background ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
                css={{ '& *': { pointerEvents: 'none' } }}
                onClick={item.onClick}
              >
                {item.icon}
                <Text fontSize="12px">{item.label}</Text>
              </Flex>
            ))}
          </Box>
        </>
      )}

      <Flex alignItems="center" gap={2.5} px={1}>
        {/* Avatar + nome → abre o menu */}
        <Flex
          as="button"
          alignItems="center"
          gap={2.5}
          flex={1}
          minW={0}
          cursor="pointer"
          borderRadius="8px"
          px={1}
          py="4px"
          transition={`background ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
          onClick={() => setMenuOpen(open => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Flex
            w="26px"
            h="26px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            align="center"
            justify="center"
            flexShrink={0}
            overflow="hidden"
          >
            {user?.photoURL ? (
              <img src={user.photoURL} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <Text fontSize="10px" fontWeight="700" color="#fff" lineHeight="1">
                {initials}
              </Text>
            )}
          </Flex>
          <Text
            fontSize="12.5px"
            fontWeight="600"
            color={tokens.colors.text.primary}
            lineClamp={1}
            flex={1}
            minW={0}
            textAlign="left"
          >
            {displayName}
          </Text>
        </Flex>

        <Text data-sidebar-footer-version fontSize="10px" color={tokens.colors.text.disabled} opacity={0.6} flexShrink={0}>
          {appVersion}
        </Text>

        <Flex
          as="button"
          width="26px"
          height="26px"
          alignItems="center"
          justifyContent="center"
          borderRadius="6px"
          cursor="pointer"
          flexShrink={0}
          color={tokens.colors.text.muted}
          transition={`all ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(255, 255, 255, 0.06)', color: tokens.colors.text.primary }}
          onClick={openSettings}
          title={t('menu.settings')}
          aria-label={t('menu.settings')}
        >
          <LuSettings size={14} />
        </Flex>
      </Flex>
    </Box>
  )
}

export default WelcomeSidebar
