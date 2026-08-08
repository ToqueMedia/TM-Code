/**
 * Estado da compactação para a UI: está a decorrer, e há quanto tempo.
 *
 * NÃO devolve percentagem, e é essa a decisão (2026-08-06). Havia aqui uma:
 * uma ease exponencial sobre o relógio, com TAU de 45s e teto em 95%, com um
 * comentário honesto a dizer "não há sinal real de conclusão". Numa
 * compactação real de ~15s a barra ia a ~28% e desaparecia — o developer leu
 * "correu ou fingiu, nem chegou ao meio", quando aquela compactação tinha
 * libertado 63% da janela.
 *
 * Trocar a curva por marcos ('sumarizou' = 90%) seria trocar uma invenção por
 * outra: os marcos existem, mas a fracção de TEMPO que cada um ocupa não se
 * sabe — a sumarização é uma chamada ao modelo de duração desconhecida.
 *
 * A referência resolve-o não tendo percentagem: o cli-vaz faz
 * `setSpinnerMessage('Compacting conversation')` no `compact_start` e limpa no
 * `compact_end` (screens/REPL.tsx). Aqui fica o equivalente — barra
 * indeterminada em movimento (há trabalho) mais o tempo DECORRIDO, que é
 * medido e não previsto.
 */
import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'

/** Cadência de re-render enquanto a compactação decorre. */
const TICK_MS = 250

export interface CompactionProgress {
  active: boolean
  /** Milissegundos desde o início desta compactação. Medido, não previsto. */
  elapsedMs: number
}


export function useCompactionProgress(): CompactionProgress {
  const status = useAgentStore(s => s.status)
  const active = status === 'compressing'

  // Re-render on a timer while active so the eased value advances.
  const [, tick] = useState(0)
  const startRef = useRef(0)

  useEffect(() => {
    if (!active) {
      startRef.current = 0
      return
    }
    if (startRef.current === 0) startRef.current = Date.now()
    const id = setInterval(() => tick(n => (n + 1) % 1_000_000), TICK_MS)
    return () => clearInterval(id)
  }, [active])

  if (!active || startRef.current === 0) {
    return { active: false, elapsedMs: 0 }
  }

  const elapsedMs = Date.now() - startRef.current
  return { active: true, elapsedMs }
}

export function formatCompactElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}
