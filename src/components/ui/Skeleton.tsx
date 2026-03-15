import { memo } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const shimmerKeyframes = `
@keyframes skeleton-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
`

const shimmerStyle = {
  background: `linear-gradient(
    90deg,
    ${tokens.colors.bg.overlay} 25%,
    ${tokens.colors.bg.whiteSubtle} 50%,
    ${tokens.colors.bg.overlay} 75%
  )`,
  backgroundSize: '200% 100%',
  animation: 'skeleton-shimmer 1.8s ease-in-out infinite',
}

/** Injects the @keyframes rule once into the document. */
function ShimmerStyle() {
  return <style>{shimmerKeyframes}</style>
}

interface SkeletonLineProps {
  /** Width of the line (CSS value). Default: '100%' */
  width?: string
  /** Height of the line (CSS value). Default: '12px' */
  height?: string
}

/** Animated placeholder for a single text line. */
const SkeletonLine = memo(function SkeletonLine({
  width = '100%',
  height = '12px',
}: SkeletonLineProps) {
  return (
    <Box
      width={width}
      height={height}
      borderRadius={tokens.radius.md}
      css={shimmerStyle}
    />
  )
})

interface SkeletonRectProps {
  /** Width (CSS value). Default: '100%' */
  width?: string
  /** Height (CSS value). Default: '40px' */
  height?: string
  /** Border radius (CSS value). Default: tokens.radius.md */
  borderRadius?: string
}

/** Animated placeholder rectangle. */
const SkeletonRect = memo(function SkeletonRect({
  width = '100%',
  height = '40px',
  borderRadius = tokens.radius.md,
}: SkeletonRectProps) {
  return (
    <Box
      width={width}
      height={height}
      borderRadius={borderRadius}
      css={shimmerStyle}
    />
  )
})

interface SkeletonCircleProps {
  /** Diameter (CSS value). Default: '32px' */
  size?: string
}

/** Animated circle placeholder. */
const SkeletonCircle = memo(function SkeletonCircle({
  size = '32px',
}: SkeletonCircleProps) {
  return (
    <Box
      width={size}
      height={size}
      borderRadius={tokens.radius.full}
      flexShrink={0}
      css={shimmerStyle}
    />
  )
})

export { ShimmerStyle, SkeletonLine, SkeletonRect, SkeletonCircle }
