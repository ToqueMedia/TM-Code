import { useEffect, useState, type ReactNode } from 'react'
import { Box } from '@chakra-ui/react'

const DURATION_MS = 180

/**
 * Abre/fecha o painel com altura animada. Mantém os filhos montados só
 * durante a transição de fecho para o grid 1fr→0fr ter o que encolher.
 */
export function ExpandReveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const [rows, setRows] = useState(open ? '1fr' : '0fr')

  useEffect(() => {
    if (open) {
      setMounted(true)
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setRows('1fr'))
      })
      return () => cancelAnimationFrame(id)
    }
    setRows('0fr')
    const timer = window.setTimeout(() => setMounted(false), DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!mounted) return null

  return (
    <Box
      display="grid"
      gridTemplateRows={rows}
      transition={`grid-template-rows ${DURATION_MS}ms ease`}
    >
      <Box overflow="hidden" minH={0}>
        {children}
      </Box>
    </Box>
  )
}

export const EXPAND_REVEAL_MS = DURATION_MS
