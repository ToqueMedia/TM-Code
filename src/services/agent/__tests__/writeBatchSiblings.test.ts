/**
 * Estado MISTO de um lote de writes: quando um diff é rejeitado, o
 * tool_result tem de dizer ao modelo se os OUTROS ficheiros do lote foram (ou
 * ainda podem vir a ser) aplicados. O que se protege aqui é a
 * INDEPENDÊNCIA DA ORDEM: a barra de aprovação é uma lista navegável, portanto
 * decidir B antes de A é um caminho normal — e a versão inicial só olhava para
 * as aprovações JÁ feitas, deixando o modelo a assumir um disco intacto que
 * ainda ia ser escrito a seguir.
 */
import {
  beginWriteBatch,
  endWriteBatch,
  isInActiveWriteBatch,
  activeWriteBatchIds,
  markWriteBatchDecision,
  writeBatchSiblings,
} from '../writeBatch'

describe('writeBatch — estado dos irmãos do lote', () => {
  afterEach(() => endWriteBatch())

  it('sem lote ativo não há irmãos (turno de um só write)', () => {
    expect(writeBatchSiblings('solo')).toEqual({ approvedOthers: false, undecidedOthers: false })
  })

  it('aprovar A e depois rejeitar B → B sabe que A foi aplicado', () => {
    beginWriteBatch(['A', 'B'])
    markWriteBatchDecision('A', true)
    expect(writeBatchSiblings('B')).toEqual({ approvedOthers: true, undecidedOthers: false })
  })

  it('ORDEM INVERSA: rejeitar B primeiro → B sabe que A ainda pode ser aplicado', () => {
    // Este é o caso que a implementação inicial deixava silencioso: no momento
    // da rejeição de B ainda não havia nenhuma aprovação, portanto a mensagem
    // saía sem aviso nenhum — mesmo com A a ser aprovado um segundo depois.
    beginWriteBatch(['A', 'B'])
    expect(writeBatchSiblings('B')).toEqual({ approvedOthers: false, undecidedOthers: true })
  })

  it('rejeitar A e rejeitar B → sem aviso (nada foi nem será aplicado)', () => {
    beginWriteBatch(['A', 'B'])
    markWriteBatchDecision('A', false)
    expect(writeBatchSiblings('B')).toEqual({ approvedOthers: false, undecidedOthers: false })
  })

  it('lote de 3: uma aprovação passada ganha a uma indecisão futura', () => {
    // approvedOthers é a informação mais forte ("já está no disco"); a
    // mensagem escolhe-a quando ambas são verdade.
    beginWriteBatch(['A', 'B', 'C'])
    markWriteBatchDecision('A', true)
    expect(writeBatchSiblings('B')).toEqual({ approvedOthers: true, undecidedOthers: true })
  })

  it('o próprio id nunca conta como irmão', () => {
    beginWriteBatch(['A'])
    markWriteBatchDecision('A', true)
    expect(writeBatchSiblings('A')).toEqual({ approvedOthers: false, undecidedOthers: false })
  })

  it('decisões de tools fora do lote são ignoradas', () => {
    beginWriteBatch(['A', 'B'])
    markWriteBatchDecision('intruso', true)
    expect(writeBatchSiblings('B')).toEqual({ approvedOthers: false, undecidedOthers: true })
  })

  it('endWriteBatch limpa pertença E decisões (sem fuga para o turno seguinte)', () => {
    beginWriteBatch(['A', 'B'])
    markWriteBatchDecision('A', true)
    endWriteBatch()

    expect(isInActiveWriteBatch('A')).toBe(false)
    expect(activeWriteBatchIds().size).toBe(0)
    expect(writeBatchSiblings('B')).toEqual({ approvedOthers: false, undecidedOthers: false })

    // Um lote NOVO com os mesmos ids não herda as aprovações do anterior.
    beginWriteBatch(['A', 'B'])
    expect(writeBatchSiblings('B')).toEqual({ approvedOthers: false, undecidedOthers: true })
  })
})
