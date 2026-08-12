/**
 * Adaptador de stores para `resolveContextWindow` — o caminho de quem NÃO vive
 * em React (o runtime do auto-compact, o `/context`).
 *
 * Fica fora de `utils/contextWindow.ts` de propósito: aquele módulo é pura
 * aritmética e é assim que os testes o usam; importar stores para lá tornava-o
 * dependente de Zustand, do billing e do registo de modelos.
 *
 * Ver o comentário de `ContextWindowCandidates` para o porquê da unificação.
 */

import { MODEL_PROFILES, getProfileForPlan } from './modelProfiles'
import { getPersonaFallbackContextWindow } from '../../stores/activeModelStore'
import { useAgentStore } from '../../stores/agentStore'
import { useBillingStore } from '../../stores/billingStore'
import { useChatStore } from '../../stores/chatStore'
import { resolveContextWindow, type ResolvedContextWindow } from '../../utils/contextWindow'
import { recallServedWindow } from './servedWindowMemory'

export interface ActiveContextWindowOptions {
  /** Janela BYOK do RUN, quando o chamador a conhece (agentService congela o
   *  snapshot no arranque). Sem isto cai-se no snapshot da sessão ACTIVA, que
   *  o utilizador pode ter trocado entretanto. */
  byokContextWindow?: number | null
}

export function getActiveContextWindow(
  options: ActiveContextWindowOptions = {},
): ResolvedContextWindow & { modelName: string } {
  const agent = useAgentStore.getState()
  const chat = useChatStore.getState()
  const activeSession = chat.activeSessionId ? chat.sessions.get(chat.activeSessionId) : undefined
  const byokSnapshot = activeSession?.byokSnapshot ?? null
  // Sob BYOK o nome do modelo é o do provedor do utilizador, não o servido.
  const modelName = byokSnapshot?.modelId ?? agent.modelName ?? ''
  const knownProfile = modelName ? MODEL_PROFILES[modelName] : undefined
  const profile = knownProfile ?? getProfileForPlan(useBillingStore.getState().plan)

  // O que o servidor já disse sobre ESTA config (provider+modelo). Cobre o 1º
  // turno de cada arranque, antes de o header chegar — ver servedWindowMemory.
  const learned = recallServedWindow(agent.modelProvider, modelName)

  const resolved = resolveContextWindow({
    byokContextWindow: options.byokContextWindow ?? byokSnapshot?.contextWindow ?? null,
    headerContextWindow: agent.modelContextWindow,
    personaContextWindow: getPersonaFallbackContextWindow(),
    learnedContextWindow: learned?.contextWindow ?? null,
    profileContextWindow: knownProfile?.contextWindow ?? null,
    headerMaxOutputTokens: agent.modelMaxOutputTokens,
    learnedMaxOutputTokens: learned?.maxOutputTokens ?? null,
    profileMaxOutputTokens: profile.maxOutputTokens ?? null,
  })

  return { ...resolved, modelName: modelName || 'modelo ativo' }
}
