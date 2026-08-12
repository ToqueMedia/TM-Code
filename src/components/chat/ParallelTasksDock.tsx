/**
 * ParallelTasksDock — compact strip under the composer for multi-project
 * agents (F2/F3: one agent per project, several projects in this window).
 *
 * Each row: project monogram · task title · status · Stop.
 *
 * MOSTRA OS OUTROS PROJECTOS, NÃO O ACTUAL (2026-08-10)
 * ────────────────────────────────────────────────────
 * Listava TODOS os runs, incluindo o do projecto aberto — e esse já está
 * representado no `AgentActivityIndicator`, a faixa "Tarefa paralela a
 * trabalhar" imediatamente acima do composer, com o seu próprio Stop.
 * Resultado: aberto o projecto B, o painel anunciava "B a correr em paralelo"
 * logo abaixo de uma faixa que já dizia o mesmo — enquanto o projecto A, que
 * era o que estava mesmo a correr em paralelo, não aparecia em lado nenhum.
 *
 * A regra passa a ser posicional: este painel é sobre o que está a acontecer
 * FORA da vista actual. Em B mostra A; ao mudar para A mostra B.
 */

import { memo, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiSquare } from 'react-icons/fi'
import { VscLoading } from 'react-icons/vsc'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import {
  useParallelTaskStore,
  type ParallelTaskRun,
  type ParallelTaskStatus,
} from '@/stores/parallelTaskStore'
import { openParallelTaskChat } from '@/hooks/useParallelTaskRows'
import { useProjectStore } from '@/stores/projectStore'
import { normalizeProjectPath } from '@/services/agent/parallelTasks/parallelTaskManager'

const pulseCss = {
  animation: 'ptSpin 0.85s linear infinite',
  '@keyframes ptSpin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
}

function projectNameFromPath(path?: string): string {
  if (!path) return t('parallel.unknownProject')
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

function monogram(name: string): string {
  const cleaned = name.trim()
  if (!cleaned) return '?'
  return cleaned.slice(0, 1).toUpperCase()
}

/** Human title: prefer session-style short label, never a raw multi-line dump. */
function displayTitle(run: ParallelTaskRun): string {
  const raw = (run.description || '').replace(/\s+/g, ' ').trim()
  if (!raw) return t('parallel.untitledTask')
  // Strip common noisy prefixes agents put in prompts.
  const cleaned = raw
    .replace(/^(please\s+|pls\s+|podes\s+|pode\s+|ajuda[- ]me\s+a\s+|help\s+me\s+)/i, '')
    .trim()
  if (cleaned.length <= 56) return cleaned
  return cleaned.slice(0, 55).trimEnd() + '…'
}

function statusColor(status: ParallelTaskStatus): string {
  switch (status) {
    case 'running': return tokens.colors.accent.primary
    case 'completed': return tokens.colors.accent.greenBright
    case 'error': return tokens.colors.accent.red
    default: return tokens.colors.text.muted
  }
}

function statusLabel(status: ParallelTaskStatus): string {
  switch (status) {
    case 'running': return t('welcome.agentWorking')
    case 'queued': return t('parallel.queued')
    case 'completed': return t('welcome.agentDone')
    case 'error': return t('welcome.agentError')
    case 'aborted': return t('parallel.taskStoppedShort')
  }
}

function TaskRow({ run }: { run: ParallelTaskRun }) {
  const abort = useParallelTaskStore((s) => s.abort)
  const color = statusColor(run.status)
  const lastCall = run.toolCalls[run.toolCalls.length - 1]
  const active = run.status === 'running' || run.status === 'queued'
  const projectName = projectNameFromPath(run.projectPath)
  const title = displayTitle(run)
  const subtitle =
    run.status === 'error'
      ? (run.errorText ?? t('welcome.agentError'))
      : run.status === 'completed'
        ? (run.finalText.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 72) || t('welcome.agentDone'))
        : lastCall
          ? `${lastCall.toolName}${lastCall.argPreview ? ` · ${lastCall.argPreview.slice(0, 40)}` : ''}`
          : run.status === 'queued'
            ? t('parallel.waitingSlot')
            : t('parallel.starting')

  return (
    <Flex
      align="center"
      gap={2}
      px={2}
      py="7px"
      borderRadius="7px"
      _hover={{ bg: 'rgba(255,255,255,0.035)' }}
      cursor={run.sessionId && run.projectPath ? 'pointer' : 'default'}
      onClick={() => {
        if (run.sessionId && run.projectPath) {
          void openParallelTaskChat(run.projectPath, run.sessionId)
        }
      }}
    >
      {/* Project monogram */}
      <Flex
        w="22px"
        h="22px"
        borderRadius="6px"
        align="center"
        justify="center"
        flexShrink={0}
        bg="rgba(255,255,255,0.06)"
        border="1px solid rgba(255,255,255,0.08)"
        title={run.projectPath}
      >
        <Text fontSize="10px" fontWeight="700" color={tokens.colors.text.secondary} lineHeight="1">
          {monogram(projectName)}
        </Text>
      </Flex>

      {run.status === 'running' ? (
        <Box as="span" css={pulseCss} color={color} flexShrink={0} display="flex">
          <VscLoading size={12} />
        </Box>
      ) : (
        <Box w="7px" h="7px" borderRadius="full" bg={color} flexShrink={0} />
      )}

      <Box minW={0} flex={1}>
        <Flex align="baseline" gap={1.5} minW={0}>
          <Text fontSize="11px" fontWeight="650" color={tokens.colors.text.muted} flexShrink={0} lineClamp={1}>
            {projectName}
          </Text>
          <Text fontSize="11px" color={tokens.colors.text.disabled} flexShrink={0}>·</Text>
          <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary} lineClamp={1} minW={0}>
            {title}
          </Text>
        </Flex>
        <Text fontSize="10px" color={tokens.colors.text.muted} lineClamp={1} fontFamily={tokens.fontFamily.mono}>
          {subtitle}
        </Text>
      </Box>

      <Text
        fontSize="9px"
        color={color}
        flexShrink={0}
        fontWeight="600"
        letterSpacing="0.02em"
      >
        {statusLabel(run.status)}
      </Text>

      {active && (
        <Flex
          as="button"
          align="center"
          gap="5px"
          h="22px"
          px="8px"
          borderRadius="6px"
          flexShrink={0}
          bg="rgba(248, 81, 73, 0.1)"
          border="1px solid rgba(248, 81, 73, 0.28)"
          color={tokens.colors.accent.red}
          fontSize="10px"
          fontWeight="700"
          aria-label={t('parallel.stopTask')}
          title={t('parallel.stopTask')}
          _hover={{ bg: 'rgba(248, 81, 73, 0.18)', borderColor: 'rgba(248, 81, 73, 0.45)' }}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation()
            abort(run.id)
          }}
        >
          <FiSquare size={9} fill="currentColor" />
          {t('parallel.stopShort')}
        </Flex>
      )}
    </Flex>
  )
}

function ParallelTasksDock() {
  const runs = useParallelTaskStore((s) => s.runs)
  const abortOne = useParallelTaskStore((s) => s.abort)
  const clearFinished = useParallelTaskStore((s) => s.clearFinished)
  const currentProjectPath = useProjectStore((s) => s.currentProject?.path)

  const list = useMemo(
    () =>
      Array.from(runs.values())
        // Fora o projecto aberto: um run SEM projectPath pertence ao actual
        // por construção (foi criado a partir do composer desta vista), logo
        // também sai. Ver a nota no topo do ficheiro.
        .filter((r) => !!r.projectPath
          && normalizeProjectPath(r.projectPath) !== normalizeProjectPath(currentProjectPath))
        .sort((a, b) => a.createdAt - b.createdAt),
    [runs, currentProjectPath],
  )
  if (list.length === 0) return null

  const running = list.filter((r) => r.status === 'running').length
  const queued = list.filter((r) => r.status === 'queued').length
  const anyActive = running + queued > 0
  const anyFinished = list.some((r) => r.status !== 'running' && r.status !== 'queued')

  return (
    <Box
      mt={1.5}
      borderRadius="8px"
      bg="rgba(255,255,255,0.025)"
      border="1px solid rgba(255,255,255,0.07)"
      overflow="hidden"
    >
      <Flex align="center" gap={2} px={2.5} py="7px" borderBottom="1px solid rgba(255,255,255,0.05)">
        <Text
          fontSize="10px"
          fontWeight="700"
          letterSpacing="0.06em"
          textTransform="uppercase"
          color={tokens.colors.text.muted}
        >
          {t('parallel.dockTitle')}
        </Text>
        <Text fontSize="10px" color={tokens.colors.text.disabled}>
          {running > 0
            ? t('parallel.dockRunning').replace('{n}', String(running))
            : t('parallel.dockIdle')}
          {queued > 0 ? ` · ${t('parallel.dockQueued').replace('{n}', String(queued))}` : ''}
        </Text>
        <Box flex={1} />
        {anyFinished && (
          <Box
            as="button"
            fontSize="10px"
            fontWeight="600"
            color={tokens.colors.text.muted}
            px="6px"
            py="2px"
            borderRadius="4px"
            _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.05)' }}
            onClick={() => clearFinished()}
          >
            {t('parallel.clearFinished')}
          </Box>
        )}
        {anyActive && (
          <Flex
            as="button"
            align="center"
            gap="4px"
            h="22px"
            px="8px"
            borderRadius="6px"
            fontSize="10px"
            fontWeight="700"
            color={tokens.colors.accent.red}
            bg="rgba(248, 81, 73, 0.1)"
            border="1px solid rgba(248, 81, 73, 0.28)"
            _hover={{ bg: 'rgba(248, 81, 73, 0.18)' }}
            // Só o que está LISTADO. `abortAll()` matava também o run do
            // projecto ABERTO, que desde o filtro já não aparece aqui — um
            // "Parar todos" que mata o que não se vê.
            onClick={() => { for (const r of list) if (r.status === 'running' || r.status === 'queued') abortOne(r.id) }}
          >
            <FiSquare size={9} fill="currentColor" />
            {t('parallel.stopAll')}
          </Flex>
        )}
      </Flex>
      <Box px={1} py={1}>
        {list.map((run) => (
          <TaskRow key={run.id} run={run} />
        ))}
      </Box>
    </Box>
  )
}

export default memo(ParallelTasksDock)
