import { memo, useCallback, useRef, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

interface MarqueeTextProps {
  /** Text to show. Long content ellipsises at rest and scrolls on hover. */
  children: string
  fontSize?: string
  fontWeight?: string
  color?: string
  /** Scroll speed in px/second — duration derives from the overflow length. */
  speedPxPerSec?: number
}

/**
 * Single-line title with hover marquee: at rest it ellipsises like any
 * truncated row; on hover, when the text overflows, it scrolls the FULL
 * content back and forth (classic marquee, with a short dwell at each end)
 * so the user can read it without a tooltip.
 *
 * Layout contract: the WRAPPER is the clipping box (overflow hidden, the
 * flex child that shrinks); the INNER span is inline-block with
 * max-width:100% + ellipsis at rest, and switches to max-width:none +
 * translateX animation while running — the wrapper's clip is what reveals
 * the tail as the text slides. Metrics (which px, how long) are measured
 * on mouseenter via scrollWidth, stored as CSS vars so the animation runs
 * entirely on the compositor.
 */
const MarqueeText = memo(function MarqueeText({
  children,
  fontSize,
  fontWeight,
  color,
  speedPxPerSec = 55,
}: MarqueeTextProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // Chakra's Text types its ref as HTMLParagraphElement even with as="span".
  const textRef = useRef<HTMLParagraphElement>(null)
  const [run, setRun] = useState(false)

  const handleMouseEnter = useCallback(() => {
    const wrap = wrapRef.current
    const text = textRef.current
    if (!wrap || !text) return
    // +1 guards sub-pixel rounding — a 0.5px "overflow" would jitter for
    // nothing.
    const overflow = text.scrollWidth - wrap.clientWidth
    if (overflow <= 1) return
    wrap.style.setProperty('--tm-marquee-shift', `-${Math.ceil(overflow)}px`)
    wrap.style.setProperty('--tm-marquee-dur', `${(overflow / speedPxPerSec + 0.4).toFixed(2)}s`)
    setRun(true)
  }, [speedPxPerSec])

  const handleMouseLeave = useCallback(() => setRun(false), [])

  return (
    <Box
      ref={wrapRef}
      flex={1}
      minW={0}
      overflow="hidden"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      css={{
        '@keyframes tmMarqueeScroll': {
          '0%, 8%': { transform: 'translateX(0)' },
          '92%, 100%': { transform: 'translateX(var(--tm-marquee-shift, 0px))' },
        },
      }}
    >
      <Text
        ref={textRef}
        as="span"
        display="inline-block"
        maxWidth={run ? 'none' : '100%'}
        whiteSpace="nowrap"
        overflow={run ? 'visible' : 'hidden'}
        textOverflow={run ? 'clip' : 'ellipsis'}
        fontSize={fontSize}
        fontWeight={fontWeight}
        color={color}
        css={run
          ? { animation: 'tmMarqueeScroll var(--tm-marquee-dur, 3s) linear infinite alternate' }
          : undefined}
      >
        {children}
      </Text>
    </Box>
  )
})

export default MarqueeText
