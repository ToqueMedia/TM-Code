import { memo } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { FiAlertTriangle, FiArchive } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { usePersonaStore } from '../../stores/personaStore'
import { useActiveModelStore } from '../../stores/activeModelStore'
import { MODEL_PROFILES } from '../../services/agent/modelProfiles'
import {
  resolveContextWindow,
  getAutoCompactThreshold,
  getWarningThreshold,
} from '../../utils/contextWindow'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'

/**
 * Aviso de contexto baixo. Paridade cli-vaz (components/TokenWarning.tsx +
 * services/compact/autoCompact.ts:calculateTokenWarningState).
 *
 * ── PORQUÊ NÃO É UMA BARRA PERMANENTE (2026-08-07) ─────────────────────────
 * Era, e passou o dia a "ir para a frente e recuar". Parte disso foi um bug
 * real (a estimativa e o valor real partilhavam o mesmo campo), mas depois de
 * o corrigir MEDIU-SE que a ocupação oscila mesmo: 9 descidas em 95
 * transições numa sessão de 96 pedidos. O prompt encolhe quando o orçamento
 * limpa tool results antigos e quando um run novo reconstrói a conversa a
 * partir do store, onde os tool results são truncados ao persistir.
 *
 * Ou seja, uma barra permanente ou mostra a verdade (e dança, e ninguém a
 * consegue ler) ou mostra um valor estável (e mente sobre a ocupação actual).
 * O cli-vaz não escolhe: não tem barra. Mostra um aviso SÓ quando o contexto
 * está baixo, com a percentagem RESTANTE — o número é ruidoso e só interessa
 * perto do limiar, onde a decisão do developer muda.
 *
 * `percentLeft` é a fórmula dele, verbatim:
 *   max(0, round(((threshold - tokenUsage) / threshold) * 100))
 * com `threshold` = limiar da auto-compactação. 0% restante = a próxima
 * mensagem compacta.
 */

interface ContextWindowIndicatorProps {
  /** Mantido por compatibilidade com os call-sites; já não há popover. */
  popoverPlacement?: 'top' | 'bottom'
}

function ContextWindowIndicator(_props: ContextWindowIndicatorProps) {
  const t = useTranslation()
  const inputTokens = useChatStore((s) => {
    const id = s.streamingSessionId ?? s.activeSessionId
    if (!id) return 0
    const persisted = s.sessions.get(id)?.lastPromptTokens ?? 0
    return persisted > 0 ? persisted : s.currentPromptTokens
  })
  const headerContextWindow = useAgentStore((s) => s.modelContextWindow)
  const modelMaxOutputTokens = useAgentStore((s) => s.modelMaxOutputTokens)
  const selectedPersona = usePersonaStore((s) => s.selected)
  const personaWindow = useActiveModelStore((s) => s.personaModels[selectedPersona]?.contextWindow)
  const modelName = useAgentStore((s) => s.modelName)
  const sessionByokContextWindow = useChatStore((s) => {
    if (!s.activeSessionId) return undefined
    const w = s.sessions.get(s.activeSessionId)?.byokSnapshot?.contextWindow
    return w && w > 0 ? w : undefined
  })
  const sessionByokModelId = useChatStore((s) => {
    if (!s.activeSessionId) return undefined
    return s.sessions.get(s.activeSessionId)?.byokSnapshot?.modelId
  })

  const profileModelName = sessionByokModelId ?? modelName
  const resolved = resolveContextWindow({
    byokContextWindow: sessionByokContextWindow,
    headerContextWindow,
    personaContextWindow: personaWindow,
    profileContextWindow: profileModelName
      ? MODEL_PROFILES[profileModelName]?.contextWindow
      : undefined,
    headerMaxOutputTokens: modelMaxOutputTokens,
    profileMaxOutputTokens: profileModelName
      ? MODEL_PROFILES[profileModelName]?.maxOutputTokens
      : undefined,
  })
  const rawWindow = resolved.contextWindow
  if (rawWindow <= 0 || inputTokens <= 0) return null

  const threshold = getAutoCompactThreshold(rawWindow, resolved.maxOutputTokens)
  const warnThreshold = getWarningThreshold(rawWindow, resolved.maxOutputTokens)

  // Escondido enquanto há folga — a regra do cli-vaz
  // (`if (!isAboveWarningThreshold) return null`).
  if (inputTokens < warnThreshold) return null

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - inputTokens) / threshold) * 100),
  )
  const compactImminent = inputTokens >= threshold
  const color = compactImminent ? tokens.colors.accent.red : tokens.colors.accent.orange

  return (
    <Flex
      align="center"
      gap="5px"
      px="8px"
      py="3px"
      borderRadius="5px"
      border="1px solid"
      borderColor={color}
      cursor="default"
      userSelect="none"
    >
      <Flex color={color} align="center">
        {compactImminent ? <FiArchive size={11} /> : <FiAlertTriangle size={11} />}
      </Flex>
      <Text fontSize="10px" fontWeight="600" color={color}>
        {percentLeft}% {t('contextInfo.remaining')}
      </Text>
    </Flex>
  )
}

export default memo(ContextWindowIndicator)
