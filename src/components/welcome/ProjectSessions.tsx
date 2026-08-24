import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Input, Text } from '@chakra-ui/react'
import { LuChevronDown, LuChevronUp, LuMessageSquare, LuPenLine, LuTrash2, LuCheck, LuX } from 'react-icons/lu'
import { useChatStore } from '@/stores/chatStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useProjectStore } from '@/stores/projectStore'
import { focusForeignOrOpen } from '@/services/projectWindowFocusService'
import MarqueeText from '@/components/ui/MarqueeText'
import type { ProjectAgentStatus } from '@/hooks/useProjectAgentStatuses'
import type { SessionSummary } from '@/types/chat'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

/**
 * Número de sessões recentes mostradas por defeito antes de o utilizador
 * expandir a lista. As sessões chegam ordenadas por updatedAt desc (o disco
 * garante a ordem), por isso as primeiras N são SEMPRE as mais recentes —
 * cortar aqui não precisa de sort extra. O botão "Mais/Menos" revela ou
 * oculta o restante sem voltar a ler o disco.
 */
const SESSIONS_PREVIEW_LIMIT = 5

/** Compact "2m / 3h / 5d" for the session rows (same rhythm as the agent
 *  status badges above — one shared visual language for relative time). */
function sessionShortAgo(epochMs: number): string {
  const diff = Date.now() - epochMs
  if (!Number.isFinite(diff) || diff < 0) return ''
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('welcome.justNow')
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface ProjectSessionsProps {
  projectPath: string
  /** Project active in THIS window — rows switch sessions directly. */
  isActiveProject: boolean
  /** Cross-window owner probe result (foreign running agent → focus, not open). */
  agentStatus: ProjectAgentStatus | null
  /** Open the project in THIS window (ProjectGroup's onOpen). */
  onOpenHere: () => void
  /** Expanding the folder also selects the FIRST session (most recent) once
   *  the list loads — listSessions sorts updatedAt desc, so sessions[0] IS
   *  the first row the user sees. Cleared by onFirstSelected after use. */
  autoSelectFirst?: boolean
  onFirstSelected?: () => void
}

/**
 * Sessions nested under a project folder in the Welcome sidebar — replaces
 * the old SessionDropdown (titlebar). The folder is the project, the rows
 * inside are its chat sessions; clicking a row switches to it.
 *
 * Behaviour parity with the removed dropdown:
 *  - parallel-TASK chats stay hidden (doctrine: those live in the sidebar's
 *    task rows / ProjectMenu, not in the session list);
 *  - mid-run switching is VIEW-ONLY (setActiveSession / loadSessionFromDisk,
 *    never switchSession — it finalises the live bubble and drains the queue);
 *  - inline rename + description, delete with the same store calls.
 *
 * Sessions of a project that is NOT active in this window: focus the foreign
 * window that owns it, or open the project here with a pendingSessionOpen so
 * App.tsx lands on the clicked session instead of the most recent one.
 */
function ProjectSessions({ projectPath, isActiveProject, agentStatus, onOpenHere, autoSelectFirst = false, onFirstSelected }: ProjectSessionsProps) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')

  // Expansão da lista de sessões: collapsed mostra só as SESSIONS_PREVIEW_LIMIT
  // mais recentes; o botão "Mais/Menos" revela ou oculta o restante. Resetado
  // quando a lista muda (refresh) para não deixar um estado "expandido" a
  // apontar para rows que já não existem.
  const [showAllSessions, setShowAllSessions] = useState(false)

  // Active-project refresh signal: activeSessionId changes on create, on
  // switch and on delete-of-active — exactly the moments the list goes
  // stale. Foreign projects refresh on mount only (their index lives on
  // disk owned by their window).
  const activeSessionId = useChatStore((s) => (isActiveProject ? s.activeSessionId : null))

  const refresh = useCallback(async () => {
    try {
      const list = await useChatStore.getState().listProjectSessions(projectPath)
      // Doutrina multi-agent: chats de TAREFA vivem nas rows da sidebar/
      // ProjectMenu — o menu de sessões é dos chats principais (report
      // 2026-07-17, herdado do dropdown).
      setSessions(list.filter(s => s.isParallelTask !== true))
    } catch {
      setSessions([])
    }
    // A lista mudou — colapsa a expansão para não deixar o utilizador com
    // rows abertas que já não correspondem à realidade do disco.
    setShowAllSessions(false)
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh, activeSessionId])

  const handleSwitch = useCallback(async (sessionId: string) => {
    if (isActiveProject) {
      const chat = useChatStore.getState()
      if (chat.isStreaming) {
        // MID-RUN: troca só a VISTA — o streaming está preso à sessão do run
        // (streamingSessionId), por isso ver outra sessão é seguro. NÃO usar
        // switchSession aqui: ele finaliza a bolha viva e limpa a fila (é um
        // caminho de idle). Era este bloqueio que impedia alternar entre os
        // chats das tarefas com o main a trabalhar (feedback 2026-07-16).
        if (chat.activeSessionId === sessionId) {
          useLayoutStore.getState().setViewMode('chat')
          return
        }
        if (chat.sessions.has(sessionId)) {
          chat.setActiveSession(sessionId)
        } else {
          await chat.loadSessionFromDisk(projectPath, sessionId)
        }
      } else if (chat.activeSessionId !== sessionId) {
        await chat.switchSession(projectPath, sessionId)
      }
      useLayoutStore.getState().setViewMode('chat')
      return
    }

    // Non-active project: focus the foreign owner, or open here landing on
    // the clicked session (pendingSessionOpen is consumed by App's project
    // switch effect AFTER the wipe/park, BEFORE warm-restore).
    const focusedAtClick = useProjectStore.getState().currentProject?.path ?? null
    const openHereWithSession = () => {
      if ((useProjectStore.getState().currentProject?.path ?? null) !== focusedAtClick) return // stale click
      useChatStore.getState().setPendingSessionOpen({ projectPath, sessionId })
      onOpenHere()
    }
    focusForeignOrOpen(projectPath, agentStatus, openHereWithSession, {
      onFocusRequested: () => {
        // Parity with the old folder click: tell the user WHY nothing opened
        // here — another window owns the project (click again to force-open).
        try {
          useChatStore.getState().addSystemMessage(
            `${t('parallel.focusOtherWindow')} ${t('parallel.focusOtherWindowRetry')}`,
            'info',
          )
        } catch { /* mensagem é best-effort — o foco é o efeito principal */ }
      },
    }).catch(() => openHereWithSession())
  }, [isActiveProject, projectPath, agentStatus, onOpenHere])

  // Expandir a pasta = seleccionar a PRIMEIRA sessão (a mais recente). O id
  // só existe depois de a lista carregar, por isso a selecção corre aqui e
  // UMA vez por expansão — o ref descarta os refreshes subsequentes
  // (activeSessionId, delete/edit) que não são pedidos do utilizador.
  const autoSelectDoneRef = useRef(false)
  useEffect(() => {
    if (!autoSelectFirst || autoSelectDoneRef.current) return
    if (sessions === null) return // ainda a carregar
    autoSelectDoneRef.current = true
    onFirstSelected?.()
    const first = sessions[0]
    if (first) void handleSwitch(first.id)
  }, [autoSelectFirst, sessions, handleSwitch, onFirstSelected])

  const handleDelete = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    if (useChatStore.getState().isStreaming) return
    await useChatStore.getState().deleteSessionFromDisk(projectPath, sessionId)
    setSessions(prev => (prev ? prev.filter(s => s.id !== sessionId) : prev))
  }, [projectPath])

  const startEditing = useCallback((e: React.MouseEvent, s: SessionSummary) => {
    e.stopPropagation()
    setEditingId(s.id)
    setEditName(s.name ?? s.lastMessage ?? '')
    setEditDescription(s.description ?? '')
  }, [])

  const cancelEditing = useCallback(() => setEditingId(null), [])

  const saveEditing = useCallback(async () => {
    if (!editingId) return
    const name = editName.trim()
    const description = editDescription.trim()
    const ok = await useChatStore.getState().updateSessionMeta(projectPath, editingId, {
      // Título vazio não apaga o existente — sem título a row degradaria
      // para lastMessage e o "título estável" perdia-se.
      ...(name ? { name } : {}),
      description,
    })
    if (ok) {
      setSessions(prev => prev?.map(s =>
        s.id === editingId ? { ...s, ...(name ? { name } : {}), description } : s,
      ) ?? prev)
    }
    setEditingId(null)
  }, [editingId, projectPath, editName, editDescription])

  if (sessions !== null && sessions.length === 0) return null

  // Paginação local: por defeito mostra só as SESSIONS_PREVIEW_LIMIT mais
  // recentes (o disco entrega por updatedAt desc). O botão "Mais" revela o
  // resto; o "Menos" volta a colapsar. Sem fetch extra — tudo já está em
  // memória depois do refresh inicial.
  const visibleSessions = showAllSessions
    ? (sessions ?? [])
    : (sessions ?? []).slice(0, SESSIONS_PREVIEW_LIMIT)
  const hasMore = (sessions?.length ?? 0) > SESSIONS_PREVIEW_LIMIT

  return (
    <Box
      pl="30px"
      pr={1}
      pb="4px"
      css={{
        // Row-scoped hover actions — calmer than the group-wide pattern on
        // the folder row: with many sessions, lighting every row's actions
        // at once reads as noise.
        '& [data-session-action]': { opacity: 0 },
        '& [data-session-row]:hover [data-session-action]': { opacity: 1 },
        '& [data-session-row]:focus-within [data-session-action]': { opacity: 1 },
      }}
    >
      {sessions === null ? (
        <Text px={2} py="3px" fontSize="11px" color={tokens.colors.text.disabled}>
          …
        </Text>
      ) : (
        <>
          {visibleSessions.map(s => {
          const isActive = isActiveProject && s.id === activeSessionId
          if (editingId === s.id) {
            // Modo edição — dois inputs inline; Enter guarda, Esc cancela.
            return (
              <Box key={s.id} px={2} py={1.5} borderRadius="6px" bg="rgba(255,255,255,0.04)" mb="2px">
                <Input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={t('view.sessionTitlePlaceholder')}
                  size="sm"
                  fontSize="12px"
                  mb={1.5}
                  bg={tokens.colors.bg.panel}
                  borderColor={tokens.colors.border.panel}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveEditing()
                    if (e.key === 'Escape') cancelEditing()
                  }}
                />
                <Input
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder={t('view.sessionDescriptionPlaceholder')}
                  size="sm"
                  fontSize="11px"
                  mb={1.5}
                  bg={tokens.colors.bg.panel}
                  borderColor={tokens.colors.border.panel}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveEditing()
                    if (e.key === 'Escape') cancelEditing()
                  }}
                />
                <Flex gap={1.5} justify="flex-end">
                  <Box
                    as="button"
                    display="flex" alignItems="center" gap="4px"
                    px={2} h="22px" borderRadius="6px"
                    fontSize={tokens.fontSize.xs}
                    color={tokens.colors.text.muted}
                    cursor="pointer"
                    _hover={{ color: tokens.colors.text.primary }}
                    onClick={cancelEditing}
                    aria-label={t('view.cancelSessionMeta')}
                  >
                    <LuX size={12} /> {t('view.cancelSessionMeta')}
                  </Box>
                  <Box
                    as="button"
                    display="flex" alignItems="center" gap="4px"
                    px={2} h="22px" borderRadius="6px"
                    fontSize={tokens.fontSize.xs}
                    color={tokens.colors.accent.primary}
                    bg="rgba(254, 16, 99, 0.08)"
                    cursor="pointer"
                    _hover={{ bg: 'rgba(254, 16, 99, 0.16)' }}
                    onClick={() => void saveEditing()}
                    aria-label={t('view.saveSessionMeta')}
                  >
                    <LuCheck size={12} /> {t('view.saveSessionMeta')}
                  </Box>
                </Flex>
              </Box>
            )
          }
          return (
            <Flex
              key={s.id}
              data-session-row
              align="center"
              gap={2}
              px={2}
              py="3px"
              borderRadius="6px"
              cursor="pointer"
              role="button"
              aria-current={isActive ? 'true' : undefined}
              bg={isActive ? 'rgba(254, 16, 99, 0.10)' : 'transparent'}
              borderLeft={isActive ? '2px solid' : '2px solid transparent'}
              borderColor={isActive ? tokens.colors.accent.primary : 'transparent'}
              transition={`background ${tokens.transition.fast}`}
              _hover={{
                bg: isActive ? 'rgba(254, 16, 99, 0.16)' : 'rgba(255, 255, 255, 0.05)',
              }}
              onClick={() => void handleSwitch(s.id)}
              // A descrição continua em tooltip (não há row para ela); o
              // NOME já não precisa — o marquee do hover revela-o inteiro e
              // o tooltip nativo só o taparia.
              title={s.description || undefined}
            >
              <Box flexShrink={0} display="flex" alignItems="center" color={isActive ? tokens.colors.accent.primary : tokens.colors.text.muted}>
                <LuMessageSquare size={12} />
              </Box>
              <MarqueeText
                fontSize="12px"
                fontWeight={isActive ? '600' : '400'}
                color={isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              >
                {/* Título estável: primeira mensagem do user (ou rename
                    manual) — NUNCA a última mensagem, que derivava com
                    steering/segundas tarefas. lastMessage é só fallback
                    para sessões legadas sem name. */}
                {s.name || s.lastMessage || 'Empty session'}
              </MarqueeText>
              <Text fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
                {sessionShortAgo(s.updatedAt)}
              </Text>
              <Box
                as="button"
                data-session-action
                display="flex"
                alignItems="center"
                justifyContent="center"
                w="18px"
                h="18px"
                flexShrink={0}
                borderRadius="5px"
                color={tokens.colors.text.disabled}
                bg="transparent"
                cursor="pointer"
                transition={`opacity ${tokens.transition.fast}, color ${tokens.transition.fast}, background ${tokens.transition.fast}`}
                _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255, 255, 255, 0.08)' }}
                onClick={(e: React.MouseEvent) => startEditing(e, s)}
                aria-label={t('view.editSession')}
                title={t('view.editSession')}
              >
                <LuPenLine size={11} />
              </Box>
              <Box
                as="button"
                data-session-action
                display="flex"
                alignItems="center"
                justifyContent="center"
                w="18px"
                h="18px"
                flexShrink={0}
                borderRadius="5px"
                color={tokens.colors.text.disabled}
                bg="transparent"
                cursor="pointer"
                transition={`opacity ${tokens.transition.fast}, color ${tokens.transition.fast}, background ${tokens.transition.fast}`}
                _hover={{ color: tokens.colors.status.error, bg: 'rgba(248, 81, 73, 0.1)' }}
                onClick={(e: React.MouseEvent) => void handleDelete(e, s.id)}
                aria-label={t('view.deleteSession')}
                title={t('view.deleteSession')}
              >
                <LuTrash2 size={11} />
              </Box>
            </Flex>
          )
        })}

          {/* Botão Mais/Menos — só aparece quando há mais sessões do que o
              preview limit. Evita um round-trip ao disco: tudo já está em
              memória, o toggle apenas slice da array. */}
          {hasMore && (
            <Flex
              as="button"
              align="center"
              justify="center"
              gap="3px"
              px={2}
              py="4px"
              mt="2px"
              borderRadius="6px"
              cursor="pointer"
              color={tokens.colors.text.muted}
              fontSize="11px"
              fontWeight="500"
              bg="transparent"
              border="none"
              transition={`color ${tokens.transition.fast}, background ${tokens.transition.fast}`}
              _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255, 255, 255, 0.05)' }}
              onClick={() => setShowAllSessions(v => !v)}
            >
              {showAllSessions ? (
                <>
                  <LuChevronUp size={11} />
                  {t('welcome.showLess')}
                </>
              ) : (
                <>
                  <LuChevronDown size={11} />
                  {t('welcome.showMore')} {(sessions?.length ?? 0) - SESSIONS_PREVIEW_LIMIT}
                </>
              )}
            </Flex>
          )}
        </>
      )}
    </Box>
  )
}

export default ProjectSessions
