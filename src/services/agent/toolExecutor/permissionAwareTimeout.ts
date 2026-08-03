/**
 * Timeout que NÃO conta o tempo em que o utilizador está a decidir.
 *
 * HISTÓRIA (auditoria 2026-07-28): isto vivia dentro do safeToolPool.ts — um
 * executor paralelo de ~700 linhas que nunca teve um caller de produção (o
 * despacho paralelo real vive no loop, query.ts). O pool foi apagado; esta
 * função era a única peça com valor e mudou-se para aqui, ligada como
 * BACKSTOP do caminho MCP — o único sítio onde uma tool podia pendurar o
 * turno para sempre (um servidor MCP encravado não devolve nada; as tools
 * locais têm todos os seus próprios tetos).
 *
 * Why: a tool's `execute()` promise covers BOTH the permission request and
 * the actual work. With a flat `Promise.race(execute, setTimeout(timeoutMs))`,
 * the deadline expires while the user is still reading the dialog — the user
 * approves, the HTTP call fires, but the race already rejected. Per project
 * policy: user waits are unbounded.
 *
 * How: track wall-clock elapsed minus accumulated user-wait time. When the
 * timer fires, recompute "active" elapsed; if still under `timeoutMs`,
 * reschedule for the remainder.
 *
 * P4 headless (2026-08-03, portão nº7 do inventário): a fonte de "estou à
 * espera do utilizador?" deixou de ser a subscrição a TRÊS stores do
 * renderer (permissionStore/chatStore/credentialRequestStore) e passou a
 * ser o contador de gates humanos do hostBus — o host-janela abre um span
 * à volta de CADA via de decisão humana do AgentHost (P2), e um host
 * headless nunca abre gates, portanto nada pausa (não há diálogo nenhum).
 * O span cobre também a fila de permissões e as perguntas estruturadas,
 * que a subscrição antiga ignorava — divergência deliberadamente
 * conservadora (deadline maior, menos timeouts falsos).
 */

import { hasOpenHumanGates, onHumanGatesChange } from '../host/hostBus'

export function createPermissionAwareTimeout(toolName: string, timeoutMs: number): {
  promise: Promise<never>
  cleanup: () => void
} {
  const startedAt = Date.now()
  let totalPausedMs = 0
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  let waitStartedAt: number | null = hasOpenHumanGates() ? startedAt : null

  const onGateChange = () => {
    const isWaiting = hasOpenHumanGates()
    const wasWaiting = waitStartedAt !== null
    if (isWaiting && !wasWaiting) {
      waitStartedAt = Date.now()
    } else if (!isWaiting && wasWaiting) {
      totalPausedMs += Date.now() - waitStartedAt!
      waitStartedAt = null
    }
  }

  const unsubscribeGates = onHumanGatesChange(onGateChange)

  const promise = new Promise<never>((_, reject) => {
    const tick = () => {
      const now = Date.now()
      const currentPause = waitStartedAt !== null ? now - waitStartedAt : 0
      const activeMs = now - startedAt - totalPausedMs - currentPause
      if (activeMs >= timeoutMs) {
        reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs / 1000} seconds`))
        return
      }
      timeoutHandle = setTimeout(tick, timeoutMs - activeMs)
    }
    timeoutHandle = setTimeout(tick, timeoutMs)
  })

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    unsubscribeGates()
  }

  return { promise, cleanup }
}
