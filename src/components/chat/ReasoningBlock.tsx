import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronRight, FiChevronDown } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface ReasoningBlockProps {
  content: string
  isVisible: boolean
  isStreaming: boolean
  durationMs?: number
  /** Called when the user clicks the header. The anchor element is the
   *  header element itself — passed so the caller can snapshot its
   *  bounding-rect.top BEFORE the toggle and restore the same visual
   *  position AFTER, instead of trying to restore raw scrollTop (which
   *  fails when content above the block changes height). */
  onToggle: (anchor: HTMLElement) => void
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

/** Streaming-window height — fixed so text scrolls up like film credits. */
const CREDITS_HEIGHT_PX = 140

function ReasoningBlock({ content, isVisible, isStreaming, durationMs, onToggle }: ReasoningBlockProps) {
  const isExpanded = isStreaming || isVisible

  // Auto-scroll: stick to the bottom while content grows so the latest line
  // is always visible (movie-credits roll). Honors manual scroll-up: once the
  // user scrolls away from the bottom we stop auto-following.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const userScrolledRef = useRef(false)
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (userScrolledRef.current) return
    node.scrollTop = node.scrollHeight
  }, [content])

  function handleScroll(e: React.UIEvent<HTMLDivElement>): void {
    const node = e.currentTarget
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop
    userScrolledRef.current = distanceFromBottom > 12
  }

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
        cursor="pointer"
        onClick={(e) => onToggle(e.currentTarget as HTMLElement)}
        py="5px"
        px="8px"
        borderRadius="6px"
        _hover={{ bg: 'rgba(255, 255, 255, 0.04)' }}
        transition="background 0.12s"
        userSelect="none"
      >
        <Box color={tokens.colors.text.disabled} transition="transform 0.15s" flexShrink={0}>
          {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
        </Box>

        {isStreaming ? (
          /* Streaming: animated dots + live elapsed ("A pensar · 8s") */
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
            {streamingLabel && (
              <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500" letterSpacing="0.01em">
                {streamingLabel}
              </Text>
            )}
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
          ref={scrollRef}
          onScroll={handleScroll}
          mt="4px"
          ml="6px"
          pl={3}
          borderLeft={`2px solid rgba(254, 16, 99, 0.15)`}
          /* Fixed height during streaming gives the credits-roll effect:
             text appears at the bottom edge and scrolls up. After streaming
             ends we let it size to content so the user can review at leisure. */
          height={isStreaming ? `${CREDITS_HEIGHT_PX}px` : 'auto'}
          maxH={isStreaming ? `${CREDITS_HEIGHT_PX}px` : '320px'}
          overflowY="auto"
          py="10px"
          px="12px"
          css={{
            '&::-webkit-scrollbar': { width: '3px' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
            /* Cinematic top + bottom fade — only during streaming. The mask
               makes new text "emerge" at the bottom edge and fade out at top
               as it scrolls past, mimicking film-credits playback. */
            ...(isStreaming
              ? {
                  maskImage: 'linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%)',
                }
              : {}),
          }}
          display={isStreaming ? 'flex' : 'block'}
          flexDirection={isStreaming ? 'column' : undefined}
          justifyContent={isStreaming ? 'flex-end' : undefined}
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
