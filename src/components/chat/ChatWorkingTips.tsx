import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiZap } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore } from '../../stores/chatStore'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import { buildChatTipPool } from './chatTips'

// Paridade com o TerminalWorkingTips: dicas rotativas dos comandos disponíveis,
// numa linha subtil por cima da PromptBar, APENAS enquanto o agente trabalha.
// Primeira dica aos 2 min, renova a cada 2 min — descoberta progressiva do
// catálogo de comandos sem poluir o transcript.
const TIP_INTERVAL_MS = 2 * 60 * 1000 // 2 minutos

export const ChatWorkingTips = memo(function ChatWorkingTips() {
  const t = useTranslation()
  const status = useAgentStore(s => s.status)
  const isStreaming = useChatStore(s => s.isStreaming)

  // "A trabalhar" = streaming OU qualquer status que não seja ocioso/erro —
  // booleano, por isso as transições internas de fase não reiniciam o intervalo.
  const working = isStreaming || (status !== 'idle' && status !== 'error')

  const pool = useMemo(() => buildChatTipPool(t), [t])
  const poolRef = useRef(pool)
  poolRef.current = pool

  const [tip, setTip] = useState<string | null>(null)
  const lastTipRef = useRef<string | null>(null)

  useEffect(() => {
    if (!working) {
      setTip(null)
      lastTipRef.current = null
      return
    }
    const pickNext = () => {
      const p = poolRef.current
      if (p.length === 0) return
      let next = p[Math.floor(Math.random() * p.length)]
      // Evita repetir a mesma dica duas vezes seguidas quando há alternativas.
      if (p.length > 1) {
        let guard = 0
        while (next === lastTipRef.current && guard < 8) {
          next = p[Math.floor(Math.random() * p.length)]
          guard++
        }
      }
      lastTipRef.current = next
      setTip(next)
    }
    const id = setInterval(pickNext, TIP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [working])

  if (!working || !tip) return null

  // Drop the trailing colon from the shared "dica:" label — here it reads as a
  // styled badge, not inline prose.
  const label = t('terminalMode.greeting.tipLabel').replace(/:\s*$/, '')

  return (
    // Outer wrapper centres the hint on the SAME 900px column as the transcript
    // and the PromptBar, so it stops breaking out to the window's left edge.
    <Flex flexShrink={0} w="100%" justify="center" px={4} pb="6px" data-ui-chrome>
      <Flex
        maxW="900px"
        w="100%"
        align="center"
        gap={2}
        px={3}
        py="6px"
        borderRadius={tokens.radius.md}
        bg="rgba(163, 113, 247, 0.06)"
        border="1px solid rgba(163, 113, 247, 0.16)"
      >
        <Box color={tokens.colors.accent.purple} flexShrink={0} display="flex">
          <FiZap size={11} />
        </Box>
        <Text
          fontSize="10px"
          fontWeight="700"
          letterSpacing="0.06em"
          textTransform="uppercase"
          color={tokens.colors.accent.purple}
          flexShrink={0}
        >
          {label}
        </Text>
        <Text
          fontSize="11px"
          color={tokens.colors.text.muted}
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
        >
          {tip}
        </Text>
      </Flex>
    </Flex>
  )
})

export default ChatWorkingTips
