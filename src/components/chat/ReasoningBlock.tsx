import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronRight, FiChevronDown } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

/** Shimmer do estado "a pensar" — gradiente a varrer o texto para mostrar
 *  atividade sem expor o conteúdo (o bloco fica FECHADO durante o stream;
 *  decisão de UX 2026-06-12, substitui o credits-roll aberto). */
const SHIMMER_TEXT_CSS = {
  background:
    'linear-gradient(90deg, rgba(255,255,255,0.30) 25%, rgba(255,255,255,0.95) 50%, rgba(255,255,255,0.30) 75%)',
  backgroundSize: '200% 100%',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
  animation: 'thinkingShimmer 1.8s linear infinite',
  '@keyframes thinkingShimmer': {
    from: { backgroundPosition: '200% 0' },
    to: { backgroundPosition: '-200% 0' },
  },
} as const

interface ReasoningBlockProps {
  content: string
  isVisible: boolean
  isStreaming: boolean
  durationMs?: number
  /** Identity payload echoed back via `onToggle` so the parent can route the
   *  click to the right reducer (per-block vs. message-level) using a single
   *  stable callback — instead of one inline closure per render that breaks
   *  this component's memo and forces a re-render on every parent paint. */
  messageId?: string
  blockIndex?: number
  /** Called when the user clicks the header. The anchor element is the
   *  header element itself — passed so the caller can snapshot its
   *  bounding-rect.top BEFORE the toggle and restore the same visual
   *  position AFTER, instead of trying to restore raw scrollTop (which
   *  fails when content above the block changes height). `messageId` and
   *  `blockIndex` are forwarded verbatim from the props above. */
  onToggle: (anchor: HTMLElement, messageId?: string, blockIndex?: number) => void
}

/**
 * Formats reasoning duration using only Intl APIs — zero hardcoded strings.
 * Intl.NumberFormat with style:'unit' returns localized text like
 * "5 segundos" (pt), "5 seconds" (en), "5 秒" (ja) etc.
 */
function formatDuration(ms: number): string {
  const locale = navigator.language || 'en'
  const totalSeconds = Math.max(1, Math.round(ms / 1000))

  const unit = totalSeconds >= 60 ? 'minute' : 'second'
  const value = unit === 'minute' ? Math.round(totalSeconds / 60) : totalSeconds

  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'long',
    }).format(value)
  } catch {
    return `${value}s`
  }
}

/**
 * Live elapsed-time ticker for the streaming label ("A pensar · 12s").
 * Updates every second; stops when isRunning flips to false.
 */
function useLiveElapsed(isRunning: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0)
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isRunning) {
      startedAtRef.current = null
      return
    }
    startedAtRef.current = performance.now()
    setElapsedMs(0)
    const id = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(performance.now() - startedAtRef.current)
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  return elapsedMs
}

function ReasoningBlock({ content, isVisible, isStreaming, durationMs, messageId, blockIndex, onToggle }: ReasoningBlockProps) {
  // FECHADO durante o streaming (o shimmer no header sinaliza atividade);
  // expansível apenas depois de terminar. Substitui o antigo credits-roll
  // aberto — o user pediu thinking discreto enquanto acontece, legível depois.
  const isExpanded = !isStreaming && isVisible

  // Live timer during streaming ("A pensar · 8s"). Falls back to the final
  // durationMs once the stream ends and the parent passes it down.
  const liveElapsedMs = useLiveElapsed(isStreaming)
  const streamingLabel = useMemo(() => {
    if (liveElapsedMs < 1500) return null
    return formatDuration(liveElapsedMs)
  }, [liveElapsedMs])

  const durationLabel = useMemo(
    () => (durationMs != null ? formatDuration(durationMs) : null),
    [durationMs]
  )

  if (!content) return null

  return (
    <Box mb={3}>
      <Flex
        align="center"
        gap={1.5}
        cursor={isStreaming ? 'default' : 'pointer'}
        onClick={(e) => {
          if (isStreaming) return
          onToggle(e.currentTarget as HTMLElement, messageId, blockIndex)
        }}
        py="5px"
        px="8px"
        borderRadius="6px"
        _hover={isStreaming ? undefined : { bg: 'rgba(255, 255, 255, 0.04)' }}
        transition="background 0.12s"
        userSelect="none"
      >
        {!isStreaming && (
          <Box color={tokens.colors.text.disabled} transition="transform 0.15s" flexShrink={0}>
            {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
          </Box>
        )}

        {isStreaming ? (
          /* Streaming: bloco fechado — pontos + label shimmer ("A pensar... · 8s")
             mostram que há atividade sem despejar o conteúdo. */
          <Flex gap="6px" align="center">
            <Flex gap="3px" align="center">
              {[0, 1, 2].map(i => (
                <Box
                  key={i}
                  w="4px"
                  h="4px"
                  borderRadius="full"
                  bg={tokens.colors.accent.primary}
                  animation={`pulseDot 1.4s ease-in-out ${i * 0.2}s infinite`}
                />
              ))}
            </Flex>
            <Text fontSize="11px" fontWeight="500" letterSpacing="0.01em" css={SHIMMER_TEXT_CSS}>
              {t('titlebar.reasoning')}
              {streamingLabel ? ` · ${streamingLabel}` : ''}
            </Text>
          </Flex>
        ) : (
          /* Done: collapsed-ready label with final duration */
          <Flex align="center" gap={1.5}>
            <Text fontSize="13px" color={tokens.colors.text.disabled} lineHeight="1">
              {'💭'}
            </Text>
            {durationLabel && (
              <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500" letterSpacing="0.01em">
                {durationLabel}
              </Text>
            )}
          </Flex>
        )}
      </Flex>

      {isExpanded && (
        <Box
          mt="4px"
          ml="6px"
          pl={3}
          borderLeft={`2px solid rgba(254, 16, 99, 0.15)`}
          maxH="320px"
          overflowY="auto"
          py="10px"
          px="12px"
          css={{
            '&::-webkit-scrollbar': { width: '3px' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
          }}
        >
          <Text
            fontSize="12px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.ui}
            lineHeight="1.7"
            whiteSpace="pre-wrap"
            fontStyle="italic"
            letterSpacing="-0.005em"
          >
            {content}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default memo(ReasoningBlock)
