/**
 * FUSÃO F3 (2026-07-18) — núcleo partilhado da construção do cliente de run.
 *
 * O MESMO bloco (auth token → cliente SDK + closure de refresh, ramo BYOK
 * direto vs. gerido pelo worker) vivia copiado em agentService.runQueryEngineLoop
 * E em parallelTaskRunner, com a mesma dança subtil de refresh
 * (`getIdToken(true) ?? refreshLogin() → getIdToken(true)`). Divergir aqui
 * quebrava a recuperação de token de UM dos runners sem o outro notar.
 *
 * Isto extrai só o que É genuinamente comum — o cliente e o refresh. O resto
 * dos wrappers (toolset selector + telemetria TMS no principal; worktree +
 * steering por-run + wall-clock nas tarefas) é legitimamente diferente e
 * FICA em cada runner. thinkingConfig/model/seed de model-info também são
 * do caller (o principal usa buildThinkingConfig() com o estado do toggle; a
 * tarefa usa buildByokThinkingConfig()).
 */
import type OpenAI from 'openai'
import FirebaseAuthService from '../auth/firebaseAuth'
import { createAgentClient, createSubAgentClient } from './sdkClient'
import { buildByokClientFromSnapshot } from './byokRouting'
import type { ByokSessionSnapshot } from '../../types/chat'

export interface BuildRunClientOptions {
  /** Token já obtido (o caller decide o que fazer se faltar antes de chamar). */
  authToken: string
  /** Snapshot BYOK CONGELADO da sessão do run (null = rota gerida). */
  snapshot: ByokSessionSnapshot | null
  /** BYOK ativo E snapshot presente ⇒ rota direta ao provider. */
  byokActive: boolean
  /** Sub-agente (cliente com timeouts/limites próprios). */
  lightweight: boolean
  /** Chamado quando a rota é BYOK mas falta a key de um provider cloud. */
  onByokKeyMissing?: () => void
}

export interface RunClient {
  client: OpenAI
  /** Reconstrói o cliente em expiração de token (gerido) ou por-turno (BYOK,
   *  para o user que corrige uma key má a meio recuperar no turno seguinte). */
  refreshClient: () => Promise<OpenAI | null>
}

/**
 * Devolve o cliente + refresh de um run. `null` SÓ quando a rota é BYOK e a
 * key de um provider cloud falta — o `onByokKeyMissing` já correu, o caller
 * reporta o erro à sua maneira e aborta.
 */
export async function buildRunClient(opts: BuildRunClientOptions): Promise<RunClient | null> {
  const { authToken, snapshot, byokActive, lightweight } = opts

  if (byokActive && snapshot) {
    const byokClient = await buildByokClientFromSnapshot(snapshot, {
      lightweight,
      onKeyMissing: opts.onByokKeyMissing,
    })
    if (!byokClient) return null
    return {
      client: byokClient,
      // A key BYOK é estática (sem JWT a refrescar); reconstruir do snapshot.
      refreshClient: async () => buildByokClientFromSnapshot(snapshot, { lightweight }),
    }
  }

  const make = lightweight ? createSubAgentClient : createAgentClient
  return {
    client: make(authToken),
    refreshClient: async (): Promise<OpenAI | null> => {
      const auth = FirebaseAuthService.getInstance()
      const refreshed =
        (await auth.getIdToken(true)) ??
        ((await auth.refreshLogin()) ? await auth.getIdToken(true) : null)
      return refreshed ? make(refreshed) : null
    },
  }
}
