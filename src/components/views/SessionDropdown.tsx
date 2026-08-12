import { memo, useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { Flex, Box, Text, Input } from '@chakra-ui/react'
import { FiPlus, FiClock, FiChevronDown, FiTrash2, FiEdit2, FiCheck, FiX } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useParallelTaskStore } from '../../stores/parallelTaskStore'
import { useAgentStore } from '../../stores/agentStore'
import { isProjectAgentBusy } from '../../services/agent/parallelTasks/parallelTaskManager'
import { SessionSummary } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

interface SessionDropdownProps {
  projectPath: string
  activeSessionId: string | null
  isStreaming: boolean
  /** Icon-only mode — hides the New Chat / Sessions text labels (used by the
   *  titlebar's collision-based collapse when the bar runs out of room). */
  compact?: boolean
}

function SessionDropdown({ projectPath, activeSessionId, isStreaming, compact = false }: SessionDropdownProps) {
  const [showSessions, setShowSessions] = useState(false)
  const [sessionList, setSessionList] = useState<SessionSummary[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const sessionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showSessions) return
    function handleClick(e: MouseEvent) {
      if (sessionsRef.current && !sessionsRef.current.contains(e.target as Node)) {
        setShowSessions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSessions])

  // NOVO CHAT: BLOQUEIA POR PROJECTO, NÃO GLOBALMENTE (2026-08-10)
  // ─────────────────────────────────────────────────────────────
  // Bloqueava em `isStreaming`, que é uma flag GLOBAL do store. Com o pivot
  // multi-projecto isso passou a significar: basta o projecto A estar a correr
  // para "Novo Chat" ficar morto no projecto B — exactamente o passo de pôr o
  // segundo projecto a trabalhar.
  //
  // A regra certa é por projecto, porque outro projecto é outro contexto:
  //   A a correr, estou em A  → bloqueia (um agente por projecto)
  //   A a correr, estou em B idle → permite
  //   B começa a correr        → bloqueia em B
  //
  // `isProjectAgentBusy` é a MESMA verificação que a política "um agente por
  // projecto" (F3) já usa para recusar ou orientar um segundo agente: cobre o
  // loop principal preso a uma sessão deste projecto E os runs vivos do
  // parallelTaskStore. Reusá-la evita um segundo detector a divergir do
  // primeiro.
  // Subscreve os TRÊS stores que o `isProjectAgentBusy` consulta. A 1ª versão
  // só subscrevia o `parallelTaskStore`, e o run PRINCIPAL deste projecto
  // (que vive no chatStore/agentStore) não disparava re-render: o botão ficava
  // activo depois de o agente arrancar e só acertava por acaso, quando outra
  // coisa qualquer re-renderizasse o componente.
  const parallelRuns = useParallelTaskStore((s) => s.runs)
  const chatStreamingId = useChatStore((s) => s.streamingSessionId)
  const chatIsStreaming = useChatStore((s) => s.isStreaming)
  const agentStatus = useAgentStore((s) => s.status)
  const busyHere = useMemo(
    () => (projectPath ? isProjectAgentBusy(projectPath) : false),
    // As dependências são os SINAIS; o valor vem da função partilhada.
    [projectPath, parallelRuns, chatStreamingId, chatIsStreaming, agentStatus],
  )

  const handleNewChat = useCallback(async () => {
    if (!projectPath || isProjectAgentBusy(projectPath)) return
    await useChatStore.getState().createNewSession(projectPath)
  }, [projectPath])

  const handleToggleSessions = useCallback(async () => {
    if (!projectPath || loadingSessions) return
    if (!showSessions) {
      setLoadingSessions(true)
      try {
        const list = await useChatStore.getState().listProjectSessions(projectPath)
        // Doutrina multi-agent: chats de TAREFA vivem nas rows da sidebar/
        // ProjectMenu (com estado, Stop e fecho próprios) — o menu de Sessões
        // é dos chats principais. Listá-los aqui duplicava a superfície e
        // mantinha "acessível" o que o user acabara de fechar (report
        // 2026-07-17).
        setSessionList(list.filter(s => s.isParallelTask !== true))
      } finally {
        setLoadingSessions(false)
      }
    }
    setShowSessions(prev => !prev)
  }, [projectPath, showSessions, loadingSessions])

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    if (!projectPath) return
    setShowSessions(false)
    const chat = useChatStore.getState()
    if (isStreaming) {
      // MID-RUN: troca só a VISTA — o streaming está preso à sessão do run
      // (streamingSessionId), por isso ver outra sessão é seguro. NÃO usar
      // switchSession aqui: ele finaliza a bolha viva e limpa a fila (é um
      // caminho de idle). Era este bloqueio que impedia alternar entre os
      // chats das tarefas com o main a trabalhar (feedback 2026-07-16).
      if (chat.activeSessionId === sessionId) return
      if (chat.sessions.has(sessionId)) {
        chat.setActiveSession(sessionId)
      } else {
        await chat.loadSessionFromDisk(projectPath, sessionId)
      }
      return
    }
    await chat.switchSession(projectPath, sessionId)
  }, [projectPath, isStreaming])

  const handleDeleteSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    if (!projectPath || isStreaming) return
    await useChatStore.getState().deleteSessionFromDisk(projectPath, sessionId)
    setSessionList(prev => prev.filter(s => s.id !== sessionId))
  }, [projectPath, isStreaming])

  // ── Edição inline de título/descrição ──
  // O título nasce da primeira mensagem do user e NUNCA é reescrito
  // automaticamente; aqui o user pode renomeá-lo e acrescentar uma descrição
  // à sua vontade (pedido 2026-07-14). A edição funciona para qualquer
  // sessão da lista (ativa = em memória; outras = roundtrip via serviço).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')

  const startEditing = useCallback((e: React.MouseEvent, s: SessionSummary) => {
    e.stopPropagation()
    setEditingId(s.id)
    setEditName(s.name ?? s.lastMessage ?? '')
    setEditDescription(s.description ?? '')
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingId(null)
  }, [])

  const saveEditing = useCallback(async () => {
    if (!editingId || !projectPath) return
    const name = editName.trim()
    const description = editDescription.trim()
    const ok = await useChatStore.getState().updateSessionMeta(projectPath, editingId, {
      // Título vazio não apaga o existente — sem título a row degradaria
      // para lastMessage e o "título estável" perdia-se.
      ...(name ? { name } : {}),
      description,
    })
    if (ok) {
      setSessionList(prev => prev.map(s =>
        s.id === editingId ? { ...s, ...(name ? { name } : {}), description } : s,
      ))
    }
    setEditingId(null)
  }, [editingId, projectPath, editName, editDescription])

  return (
    // minW=0 + shrinkable children: when the toolbar gets squeezed (preview
    // sidebar open, narrow window) the labels truncate with an ellipsis and
    // eventually collapse to icon-only. flexShrink={0} here made the fixed
    // content overflow the flex-1 wrapper and paint OVER the neighbouring
    // toolbar buttons (Data Manager / billing pills).
    <Flex align="center" gap={2} minW={0} maxW="100%">
      {/* New Chat button — VISUAL PAR do chip de Projecto/Branch da titlebar
          (MinimalTitleBar/BranchMenu: h26 px9 radius8 bg white-5% border
          default, 12px/600, ícone 12). Estes botões vivem na MESMA fila que
          os chips; o estilo antigo (h34, transparente, 13px) vinha da
          toolbar do ChatView e destoava — report do user 2026-07-16. */}
      <Box
        as="button"
        aria-label={t("view.newChat")}
        display="flex"
        alignItems="center"
        flexShrink={1}
        minW="32px"
        overflow="hidden"
        gap="6px"
        h="26px"
        px="9px"
        bg="rgba(255, 255, 255, 0.05)"
        border={`1px solid ${tokens.colors.border.default}`}
        borderRadius="8px"
        color={tokens.colors.text.secondary}
        fontSize="12px"
        fontWeight="600"
        whiteSpace="nowrap"
        cursor={busyHere ? 'not-allowed' : 'pointer'}
        opacity={busyHere ? 0.5 : 1}
        title={busyHere ? t('parallel.oneAgentPerProject') : undefined}
        transition={`all ${tokens.transition.fast}`}
        _hover={!busyHere ? {
          bg: tokens.colors.bg.panel,
          borderColor: tokens.colors.accent.primary,
          color: tokens.colors.text.primary
        } : {}}
        onClick={handleNewChat}
      >
        <Box as="span" flexShrink={0} display="flex" alignItems="center"><FiPlus size={12} /></Box>
        {!compact && (
          <Text as="span" whiteSpace="nowrap" lineHeight="1" overflow="hidden" textOverflow="ellipsis" minW={0}>
            {t("view.newChat")}
          </Text>
        )}
      </Box>

      {/* Sessions dropdown */}
      <Box position="relative" ref={sessionsRef} flexShrink={1} minW="32px" maxW="100%">
        <Box
          as="button"
          aria-label={t("view.toggleSessions")}
          aria-expanded={showSessions}
          aria-haspopup="listbox"
          display="flex"
          alignItems="center"
          maxW="100%"
          overflow="hidden"
          gap="6px"
          h="26px"
          px="9px"
          bg="rgba(255, 255, 255, 0.05)"
          border={`1px solid ${tokens.colors.border.default}`}
          borderRadius="8px"
          color={tokens.colors.text.secondary}
          fontSize="12px"
          fontWeight="600"
          whiteSpace="nowrap"
          cursor="pointer"
          transition={`all ${tokens.transition.fast}`}
          _hover={{
            bg: tokens.colors.bg.panel,
            borderColor: tokens.colors.accent.primary,
            color: tokens.colors.text.primary
          }}
          onClick={handleToggleSessions}
        >
          <Box as="span" flexShrink={0} display="flex" alignItems="center"><FiClock size={12} /></Box>
          {!compact && (
            <Text as="span" whiteSpace="nowrap" lineHeight="1" overflow="hidden" textOverflow="ellipsis" minW={0}>
              {t('view.sessions')}
            </Text>
          )}
          <Box as="span" flexShrink={0} display="flex" alignItems="center"><FiChevronDown size={11} /></Box>
        </Box>

        {showSessions && (
          <Box
            role="listbox"
            aria-label={t("view.chatSessions")}
            position="absolute"
            top="100%"
            left={0}
            mt={1}
            minW="280px"
            maxH="300px"
            overflowY="auto"
            bg={tokens.colors.bg.panel}
            border={`1px solid ${tokens.colors.border.panel}`}
            borderRadius="10px"
            boxShadow={tokens.shadow.panel}
            zIndex={tokens.zIndex.dropdown}
            py={1}
            css={{
              '&::-webkit-scrollbar': { width: '4px' },
              '&::-webkit-scrollbar-thumb': { background: tokens.colors.border.panel, borderRadius: '2px' },
            }}
          >
            {sessionList.length === 0 ? (
              <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.disabled} px={3} py={2}>
                No sessions yet
              </Text>
            ) : (
              sessionList.map(s => (
                editingId === s.id ? (
                  // Modo edição — dois inputs inline; Enter guarda, Esc cancela.
                  <Box
                    key={s.id}
                    px={3}
                    py={2}
                    bg={tokens.colors.bg.panelAlt}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  >
                    <Input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder={t('view.sessionTitlePlaceholder')}
                      size="sm"
                      fontSize={tokens.fontSize.sm}
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
                      fontSize={tokens.fontSize.xs}
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
                        px={2} h="24px" borderRadius="6px"
                        fontSize={tokens.fontSize.xs}
                        color={tokens.colors.text.muted}
                        cursor="pointer"
                        _hover={{ color: tokens.colors.text.primary }}
                        onClick={cancelEditing}
                        aria-label={t('view.cancelSessionMeta')}
                      >
                        <FiX size={12} /> {t('view.cancelSessionMeta')}
                      </Box>
                      <Box
                        as="button"
                        display="flex" alignItems="center" gap="4px"
                        px={2} h="24px" borderRadius="6px"
                        fontSize={tokens.fontSize.xs}
                        color={tokens.colors.accent.primary}
                        bg="rgba(254, 16, 99, 0.08)"
                        cursor="pointer"
                        _hover={{ bg: 'rgba(254, 16, 99, 0.16)' }}
                        onClick={() => void saveEditing()}
                        aria-label={t('view.saveSessionMeta')}
                      >
                        <FiCheck size={12} /> {t('view.saveSessionMeta')}
                      </Box>
                    </Flex>
                  </Box>
                ) : (
                <Flex
                  key={s.id}
                  role="option"
                  aria-selected={s.id === activeSessionId}
                  w="100%"
                  align="center"
                  px={3}
                  py={2}
                  cursor="pointer"
                  bg={s.id === activeSessionId ? tokens.colors.accent.primarySubtle : 'transparent'}
                  transition={`background ${tokens.transition.fast}`}
                  css={{
                    '& [data-session-row-action]': { opacity: 0.4 },
                    '&:hover [data-session-row-action]': { opacity: 1 },
                  }}
                  _hover={{
                    bg: s.id === activeSessionId
                      ? tokens.colors.accent.primaryHover
                      : tokens.colors.bg.panelAlt
                  }}
                  onClick={() => handleSwitchSession(s.id)}
                >
                  <Box flex={1} textAlign="left" overflow="hidden">
                    <Flex justify="space-between" align="center" mb={0.5}>
                      <Text
                        fontSize={tokens.fontSize.sm}
                        fontWeight={s.id === activeSessionId ? '600' : '400'}
                        color={s.id === activeSessionId ? tokens.colors.accent.primary : tokens.colors.text.primary}
                        lineClamp={1}
                      >
                        {/* Título estável: primeira mensagem do user (ou rename
                            manual) — NUNCA a última mensagem, que derivava com
                            steering/segundas tarefas. lastMessage é só fallback
                            para sessões legadas sem name. */}
                        {s.name || s.lastMessage || 'Empty session'}
                      </Text>
                      <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} flexShrink={0} ml={2}>
                        {formatRelativeTime(s.updatedAt)}
                      </Text>
                    </Flex>
                    {s.description ? (
                      <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.muted} lineClamp={1}>
                        {s.description}
                      </Text>
                    ) : null}
                    <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                      {s.messageCount} messages
                    </Text>
                  </Box>
                  <Box
                    as="button"
                    data-session-row-action
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    w="24px"
                    h="24px"
                    ml={2}
                    flexShrink={0}
                    borderRadius="6px"
                    color={tokens.colors.text.disabled}
                    bg="transparent"
                    cursor="pointer"
                    transition={`opacity ${tokens.transition.fast}, color ${tokens.transition.fast}, background ${tokens.transition.fast}`}
                    _hover={{
                      color: tokens.colors.text.primary,
                      bg: 'rgba(255, 255, 255, 0.08)',
                    }}
                    onClick={(e: React.MouseEvent) => startEditing(e, s)}
                    aria-label={t('view.editSession')}
                    title={t('view.editSession')}
                  >
                    <FiEdit2 size={12} />
                  </Box>
                  <Box
                    as="button"
                    data-session-row-action
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    w="24px"
                    h="24px"
                    ml={1}
                    flexShrink={0}
                    borderRadius="6px"
                    color={tokens.colors.text.disabled}
                    bg="transparent"
                    cursor="pointer"
                    transition={`opacity ${tokens.transition.fast}, color ${tokens.transition.fast}, background ${tokens.transition.fast}`}
                    _hover={{
                      color: tokens.colors.status.error,
                      bg: 'rgba(248, 81, 73, 0.1)',
                    }}
                    onClick={(e: React.MouseEvent) => handleDeleteSession(e, s.id)}
                    aria-label={t("view.deleteSession")}
                  >
                    <FiTrash2 size={13} />
                  </Box>
                </Flex>
                )
              ))
            )}
          </Box>
        )}
      </Box>
    </Flex>
  )
}

export default memo(SessionDropdown)
