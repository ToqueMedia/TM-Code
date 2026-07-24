import { create } from 'zustand'

/**
 * Modelo PRINCIPAL ativo, definido pelo ADMIN. Fonte real-time: um documento
 * Firestore (`system/aiActiveModel`) lido UMA vez com onSnapshot no
 * firebaseAuth (fora de qualquer componente que re-renderize). Também é
 * alimentado pelo header X-TM-Model de cada resposta (agentService), como
 * fallback quando o doc ainda não existe.
 *
 * ATT (produto): o modelo NUNCA é revelado ao user — este id serve SÓ de lógica
 * (que lista de efforts mostrar, ver reasoningEffortModels.ts). Nenhuma UI o
 * exibe.
 *
 * NÃO tem side-effects. O antigo "reset-on-change" (repor o effort no default ao
 * trocar de modelo) foi REMOVIDO: causava race Firestore↔header (flip-flop) e
 * apagava a preferência do user. A regra "na troca pega o default, a menos que
 * já haja preferência" é agora resolvida SEM estado, por `resolveEffectiveEffort`
 * (preferência-se-válida senão default) no ponto de uso.
 */
interface ActiveModelState {
  activeModelId: string | null
  /** Define o modelo ativo (idempotente). Sem side-effects. */
  setActiveModelId: (id: string | null) => void
}

export const useActiveModelStore = create<ActiveModelState>((set, get) => ({
  activeModelId: null,
  setActiveModelId: (id) => {
    if (id === get().activeModelId) return
    set({ activeModelId: id })
  },
}))
