import { memo, useCallback, useSyncExternalStore } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiPlus } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useParallelTaskStore } from '../../stores/parallelTaskStore'
import { useAgentStore } from '../../stores/agentStore'
import { getQueryGuard } from '../../services/agent/queryGuard'
import { isProjectAgentBusy } from '../../services/agent/parallelTasks/parallelTaskManager'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface SessionDropdownProps {
  projectPath: string
  /** Icon-only mode — hides the New Chat text label (used by the titlebar's
   *  collision-based collapse when the bar runs out of room). */
  compact?: boolean
}

/**
 * New Chat button for the titlebar. The sessions LIST that used to live in
 * the dropdown here moved to the Projects sidebar — each project folder in
 * WelcomeSidebar now nests its sessions (ProjectSessions.tsx), switchable by
 * click. Only chat creation stayed in the titlebar, where it sits next to
 * the Project / Branch chips.
 */
function SessionDropdown({ projectPath, compact = false }: SessionDropdownProps) {
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
  // Subscreve os TRÊS stores que o `isProjectAgentBusy` consulta, MAIS o
  // queryGuard. `isProjectAgentBusy` também lê estado transiente que não
  // emite eventos de store (queryGuard, contexto do ToolExecutor,
  // AgentService.isRunning) — essas flags são limpas DEPOIS do último
  // evento subscrito no fim de um run, e uma versão memoizada ficava
  // "presa" em busy: o botão parecia desabilitado mas o clique (que lê o
  // estado fresco) funcionava. O valor é recomputado em CADA render e o
  // guard ganhou subscrição própria — qualquer transição volta a pintar o
  // estado certo.
  const parallelRuns = useParallelTaskStore((s) => s.runs)
  const chatStreamingId = useChatStore((s) => s.streamingSessionId)
  const chatIsStreaming = useChatStore((s) => s.isStreaming)
  const agentStatus = useAgentStore((s) => s.status)
  const queryGuard = getQueryGuard()
  const guardBusy = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)
  const busyHere = projectPath ? isProjectAgentBusy(projectPath) : false
  // As subscrições acima existem para despoletar re-render; os valores são
  // lidos frescos dentro de isProjectAgentBusy.
  void parallelRuns
  void chatStreamingId
  void chatIsStreaming
  void agentStatus
  void guardBusy

  const handleNewChat = useCallback(async () => {
    if (!projectPath || isProjectAgentBusy(projectPath)) return
    await useChatStore.getState().createNewSession(projectPath)
  }, [projectPath])

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
    </Flex>
  )
}

export default memo(SessionDropdown)
