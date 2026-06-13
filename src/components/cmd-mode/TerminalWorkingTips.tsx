import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore } from '../../stores/chatStore'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import { buildTipPool } from './terminalTips'

// Dicas rotativas que aparecem APENAS enquanto o agente trabalha, numa linha
// subtil por cima do status bar. Pedido do user (2026-06-13): no greeting/ocioso
// mantém-se o comportamento atual (uma dica estática); durante o trabalho surge
// a primeira dica aos 2 min e renova a cada 2 min, para descoberta progressiva
// sem poluir o scrollback.
const TIP_INTERVAL_MS = 2 * 60 * 1000 // 2 minutos

export const TerminalWorkingTips = memo(function TerminalWorkingTips() {
  const t = useTranslation()
  const status = useAgentStore(s => s.status)
  const isStreaming = useChatStore(s => s.isStreaming)

  // "A trabalhar" espelha o isAgentActive() usado no resto do TerminalView:
  // streaming OU qualquer status que não seja ocioso/erro. Como é um booleano,
  // as transições internas de fase (reasoning→generating→applying…) não
  // reiniciam o intervalo — só reinicia quando o agente arranca/para de facto.
  const working = isStreaming || (status !== 'idle' && status !== 'error')

  const pool = useMemo(() => buildTipPool(t), [t])
  const poolRef = useRef(pool)
  poolRef.current = pool

  const [tip, setTip] = useState<string | null>(null)
  const lastTipRef = useRef<string | null>(null)

  useEffect(() => {
    if (!working) {
      // Ocioso/terminado — não mostramos nada aqui (o greeting trata do ocioso).
      setTip(null)
      lastTipRef.current = null
      return
    }
    // setInterval dispara a primeira vez aos 2 min (não imediatamente) e depois
    // a cada 2 min, exatamente como pedido.
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

  return (
    <Flex
      flexShrink={0}
      align="baseline"
      gap={2}
      px={3}
      py="4px"
      bg={tokens.colors.terminal.statusbarBg}
      borderTop={`1px solid ${tokens.colors.terminal.chromeHairlineFaint}`}
    >
      <Text
        fontFamily={tokens.fontFamily.mono}
        fontSize="12px"
        color={tokens.colors.accent.purple}
        fontWeight="600"
        flexShrink={0}
      >
        {t('terminalMode.greeting.tipLabel')}
      </Text>
      <Text
        fontFamily={tokens.fontFamily.mono}
        fontSize="12px"
        color={tokens.colors.text.muted}
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {tip}
      </Text>
    </Flex>
  )
})
