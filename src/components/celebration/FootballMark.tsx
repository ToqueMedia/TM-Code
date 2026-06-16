import { tokens } from '@/theme/tokens'

interface FootballMarkProps {
  size?: number
  /** Soft brand glow behind the ball. Default: true. */
  glow?: boolean
  /** When set, the SVG is exposed to AT with this label; otherwise aria-hidden. */
  title?: string
}

// Classic soccer-ball icon — white sphere, central pentagon + radiating seams —
// but tinted with the TM palette: the central pentagon is accent.primary (pink)
// and the seams accent.purpleDark, so it reads as "football, TM edition" rather
// than a generic emoji (and recolours cleanly on the #0a0a0a background, which
// the unicode ⚽ glyph cannot). Pure SVG, no external deps. Decorative by
// default (aria-hidden); pass `title` to give it an accessible name.
//
// Geometry: regular pentagon (r≈15) centred at (50,50); seams run from each
// pentagon vertex out to the rim (r≈44) along the same spoke angle. Coordinates
// are precomputed so there's no per-render trig.
export function FootballMark({ size = 40, glow = true, title }: FootballMarkProps) {
  // Unique-ish gradient id per size so multiple instances don't collide.
  const gradId = `tm-ball-${size}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={{
        display: 'block',
        filter: glow ? `drop-shadow(0 0 6px ${tokens.colors.accent.primaryGlow})` : undefined,
      }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#e7e4f2" />
        </linearGradient>
      </defs>

      {/* Ball body */}
      <circle
        cx="50"
        cy="50"
        r="46"
        fill={`url(#${gradId})`}
        stroke={tokens.colors.accent.purpleDark}
        strokeWidth="2"
      />

      {/* Seams: central pentagon vertices → rim */}
      <g
        stroke={tokens.colors.accent.purpleDark}
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.9"
      >
        <line x1="50" y1="35" x2="50" y2="6" />
        <line x1="64.27" y1="45.36" x2="91.85" y2="36.4" />
        <line x1="58.82" y1="62.14" x2="75.86" y2="85.6" />
        <line x1="41.18" y1="62.14" x2="24.14" y2="85.6" />
        <line x1="35.73" y1="45.36" x2="8.15" y2="36.4" />
      </g>

      {/* Central pentagon — brand pink */}
      <polygon
        points="50,35 64.27,45.36 58.82,62.14 41.18,62.14 35.73,45.36"
        fill={tokens.colors.accent.primary}
        stroke={tokens.colors.accent.purpleDark}
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}
