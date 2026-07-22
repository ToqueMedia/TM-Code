import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiZap } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore } from '../../stores/chatStore'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import { buildChatTipPool } from './chatTips'

// Dicas rotativas de comandos + funcionalidades da IDE, numa linha subtil por
// cima da PromptBar, APENAS enquanto o agente trabalha — descoberta progressiva
// do catálogo sem poluir o transcript.
//
// A primeira dica sai aos 15s: o desenho original (primeira só aos 2 min)
// tornou-as praticamente invisíveis quando os runs encurtaram — a maioria
// termina antes do intervalo alguma vez disparar, e o user deixou de as ver
// (report 2026-07-16). 15s ainda evita flashar dicas em respostas rápidas de
// pergunta-resposta, mas garante que qualquer tarefa real expõe uma dica.
const FIRST_TIP_DELAY_MS = 15 * 1000
const TIP_INTERVAL_MS = 2 * 60 * 1000 // rotação depois da primeira

export const ChatWorkingTips = memo(function ChatWorkingTips() {
  const t = useTranslation()
  const status = useAgentStore(s => s.status)
  const isStreaming = useChatStore(s => s.isStreaming)

  // "A trabalhar" = streaming OU qualquer status que não seja ocioso/parado/erro —
  // booleano, por isso as transições internas de fase não reiniciam o intervalo.
  const working = isStreaming || (status !== 'idle' && status !== 'cancelled' && status !== 'error')

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
    // Primeira dica cedo (15s), depois rotação lenta. O interval conta desde
    // o arranque do run, por isso a primeira troca acontece aos 2 min — a
    // dica dos 15s fica visível tempo suficiente para ser lida.
    const first = setTimeout(pickNext, FIRST_TIP_DELAY_MS)
    const id = setInterval(pickNext, TIP_INTERVAL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [working])

  if (!working || !tip) return null

  // Drop the trailing colon from the shared "dica:" label — here it reads as a
  // styled badge, not inline prose.
  const label = t('terminalMode.greeting.tipLabel').replace(/:\s*$/, '')

  return (
    // Outer wrapper centres the hint on the SAME 900px column as the transcript
    // and the PromptBar, so it stops breaking out to the window's left edge.
    <Flex flexShrink={0} w="100%" justify="center" px={4} pb="7px" data-ui-chrome>
      <Flex
        maxW="980px"
        w="100%"
        align="center"
        gap={2}
        px={3}
        py="7px"
        borderRadius="9px"
        bg="rgba(163, 113, 247, 0.045)"
        border="1px solid rgba(163, 113, 247, 0.14)"
        boxShadow="inset 2px 0 0 rgba(163, 113, 247, 0.42)"
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
