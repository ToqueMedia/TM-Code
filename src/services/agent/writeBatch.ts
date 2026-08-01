/**
 * Lote ativo de write tools (write_file/edit_file/create_file) despachadas
 * em conjunto num mesmo turno do modelo (query.ts).
 *
 * O gate global do toolExecutor (`waitForUserGates`) bloqueia qualquer
 * `execute()` enquanto houver aprovações de diff pendentes. Com o batching,
 * os membros do MESMO lote têm de atravessar esse gate — senão o 2.º write
 * do turno encravava à espera da decisão do 1.º e a aprovação em lote nunca
 * se materializava. Este módulo é a fonte de verdade sobre "que tool calls
 * pertencem ao lote em curso".
 *
 * Module-level de propósito (sem store): é importado pelo toolExecutor e
 * pelo query.ts sem criar ciclos com o chatStore — o query.ts é o loop
 * portável e não conhece a camada de stores.
 *
 * ── INVARIANTE: UM SÓ PRODUTOR ──
 * `activeBatch` é um SINGLETON, logo só pode existir um run a abrir lotes.
 * Hoje isso verifica-se porque só o AgentService principal passa
 * `isWriteTool` ao QueryEngine; o parallelTaskRunner e o subAgentRunner
 * constroem QueryEngine próprio sem esse predicado, portanto nunca chamam
 * `beginWriteBatch`. Nada na assinatura obriga a isso — acrescentar
 * `isWriteTool` a um segundo runner é uma linha que parece obviamente certa
 * e poria dois runs a partilhar um `activeBatch`, com o segundo a apagar a
 * pertença do primeiro. O gate degrada em segurança (volta a bloquear, isto
 * é, à aprovação pingada), mas em silêncio. `beginWriteBatch` avisa quando
 * isso acontece em vez de deixar o sintoma aparecer como "às vezes o lote
 * não funciona". Se algum dia houver mesmo N produtores, a correção é
 * chavear este estado por run (o gate já sabe quem é: myProjectId/myTaskId
 * em waitForUserGates) — não relaxar o aviso.
 */
import { logger } from '../../utils/logger'

let activeBatch: Set<string> | null = null
/** Membros já decididos (aprovados OU rejeitados) e o subconjunto aprovado. */
let approvedInBatch = new Set<string>()
let decidedInBatch = new Set<string>()

export function beginWriteBatch(toolUseIds: string[]): void {
  if (activeBatch) {
    // Ver INVARIANTE acima. Não abortamos: bloquear um run legítimo é pior
    // do que perder o batching. Mas fica registado, porque o efeito visível
    // (aprovação a pingar de novo) não tem outra explicação óbvia.
    logger.warn(
      'agent',
      `writeBatch: novo lote aberto com ${activeBatch.size} id(s) ainda ativos — ` +
        'dois runs a produzir lotes ao mesmo tempo? O batching degrada para aprovação individual.',
    )
  }
  activeBatch = new Set(toolUseIds)
  approvedInBatch = new Set()
  decidedInBatch = new Set()
}

export function endWriteBatch(): void {
  activeBatch = null
  approvedInBatch = new Set()
  decidedInBatch = new Set()
}

export function isInActiveWriteBatch(toolUseId: string): boolean {
  return activeBatch?.has(toolUseId) === true
}

export function activeWriteBatchIds(): ReadonlySet<string> {
  return activeBatch ?? new Set()
}

/** Regista a decisão de um membro do lote (bridge, depois do resolve). */
export function markWriteBatchDecision(toolUseId: string, approved: boolean): void {
  if (!activeBatch?.has(toolUseId)) return
  decidedInBatch.add(toolUseId)
  if (approved) approvedInBatch.add(toolUseId)
}

export interface WriteBatchSiblings {
  /** Outro membro do lote JÁ foi aplicado ao disco. */
  approvedOthers: boolean
  /** Outro membro do lote ainda está por decidir — pode vir a ser aplicado. */
  undecidedOthers: boolean
}

/**
 * Estado dos OUTROS membros do lote no momento em que este é decidido.
 *
 * Os dois campos existem porque a mensagem de rejeição não pode depender da
 * ORDEM em que o developer carrega nos botões: com um lote A+B, rejeitar B
 * primeiro e aprovar A depois deixava o tool_result de B a dizer apenas
 * "User rejected" — e o modelo seguia a assumir que o disco estava intacto,
 * quando A ia ser aplicado a seguir. Um lote é uma lista navegável, portanto
 * decidir pela ordem inversa é um caminho normal, não um caso de fronteira.
 */
export function writeBatchSiblings(toolUseId: string): WriteBatchSiblings {
  if (!activeBatch?.has(toolUseId)) return { approvedOthers: false, undecidedOthers: false }
  let approvedOthers = false
  let undecidedOthers = false
  for (const id of activeBatch) {
    if (id === toolUseId) continue
    if (approvedInBatch.has(id)) approvedOthers = true
    else if (!decidedInBatch.has(id)) undecidedOthers = true
  }
  return { approvedOthers, undecidedOthers }
}
