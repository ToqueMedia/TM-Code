/**
 * REGISTRY ÚNICO de claims de propriedade de ficheiros — Fase 4b/6b do modelo
 * foreground. Fecha o gap documentado na ronda estrutural de 2026-07-17: a
 * regra "não mexas no que outro agente está a mexer" cobria tarefa↔tarefa e
 * WIP-do-user↔tarefa, mas o agente PRINCIPAL nem registava nem respeitava
 * claims. Agora há UMA verificação (toolExecutor.execute) e UM registo para
 * todos os agentes — main incluído — em vez de cópias por runner (a armadilha
 * dos caminhos gémeos que mordeu 3× em 2026-07-16).
 *
 * Semântica:
 *  - owner 'main' = o run interativo; vivo entre beginMainRunClaims() e
 *    endMainRunClaims() (agentService.runAgentLoop, não-lightweight).
 *  - owner <taskId> = tarefa paralela; vivo enquanto o run dela está
 *    running/queued (consultado no parallelTaskStore); o runner liberta no
 *    terminal (releaseOwnerClaims) para não acumular lixo.
 *  - Claims de tarefas são ESPELHADOS em run.modifiedFiles (montra de UI e
 *    fonte persistida) — o registo aqui é a autoridade de bloqueio.
 *  - O baseline de WIP do developer continua no runner das tarefas: o main
 *    NÃO é bloqueado pelo WIP do user (é o par interativo dele).
 */

import { useParallelTaskStore } from '../../stores/parallelTaskStore'

export const MAIN_CLAIM_OWNER = 'main'

const claimsByOwner = new Map<string, Set<string>>()
let mainRunLive = false

/** Arranque de um run principal NÃO-lightweight: claims frescos + vivo. */
export function beginMainRunClaims(): void {
  mainRunLive = true
  claimsByOwner.set(MAIN_CLAIM_OWNER, new Set())
}

/** Fim do run principal: os claims dele deixam de bloquear. */
export function endMainRunClaims(): void {
  mainRunLive = false
  claimsByOwner.delete(MAIN_CLAIM_OWNER)
}

/** Terminal de uma tarefa: liberta os claims dela (o bloqueio já cessaria
 *  pela liveness, isto evita acumular sets órfãos em sessões longas). */
export function releaseOwnerClaims(owner: string): void {
  if (owner === MAIN_CLAIM_OWNER) return
  claimsByOwner.delete(owner)
}

export function registerFileClaim(owner: string, relPath: string): void {
  if (!relPath) return
  let set = claimsByOwner.get(owner)
  if (!set) {
    set = new Set()
    claimsByOwner.set(owner, set)
  }
  set.add(relPath)
  if (owner !== MAIN_CLAIM_OWNER) {
    // Montra de UI + persistência (rows/futuro) — best-effort.
    try {
      useParallelTaskStore.getState().addModifiedFile(owner, relPath)
    } catch { /* store indisponível (testes) — o registo local continua válido */ }
  }
}

function ownerIsLive(owner: string): boolean {
  if (owner === MAIN_CLAIM_OWNER) return mainRunLive
  const run = useParallelTaskStore.getState().runs.get(owner)
  return !!run && (run.status === 'running' || run.status === 'queued')
}

export interface BlockingClaim {
  owner: string
  /** Como descrever o dono ao agente bloqueado. */
  label: string
}

/** Outro agente VIVO tem claim sobre este caminho? */
export function findBlockingClaim(relPath: string, requester: string): BlockingClaim | null {
  if (!relPath) return null
  for (const [owner, set] of claimsByOwner) {
    if (owner === requester || !set.has(relPath) || !ownerIsLive(owner)) continue
    if (owner === MAIN_CLAIM_OWNER) {
      return { owner, label: 'the main interactive agent' }
    }
    const run = useParallelTaskStore.getState().runs.get(owner)
    return { owner, label: run?.description ?? owner }
  }
  return null
}

/** Só para testes. */
export function __resetFileClaimsForTests(): void {
  claimsByOwner.clear()
  mainRunLive = false
}
