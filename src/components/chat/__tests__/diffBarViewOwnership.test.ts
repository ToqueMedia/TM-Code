/**
 * Invariante de posse dos atalhos de diff.
 *
 * A DiffApprovalPanel traz atalhos próprios; o handler global
 * (useKeyboardShortcuts) tem de cobrir EXATAMENTE as vistas onde a barra não
 * está montada. Sobreposição = dois handlers a decidir diffs diferentes (o
 * global aprova "o primeiro pendente", a barra aprova o SELECIONADO). Buraco =
 * vista sem barra E sem atalho, com o run pendurado no
 * createDiffApprovalPromise e nada na UI a explicar porquê — foi o que
 * aconteceu a 'editor' e 'settings' quando a barra foi introduzida.
 */
import { VIEWS_WITHOUT_DIFF_BAR, type ViewMode } from '../../../stores/layoutStore'

// Espelho literal de ViewMode. O tipo `_Exhaustive` só resolve para `true` se
// as duas listas coincidirem nos dois sentidos — acrescentar um modo ao store
// sem o acrescentar aqui rebenta a compilação, que é o ponto: uma vista nova
// obriga alguém a decidir de que lado do invariante fica.
const ALL_VIEW_MODES = ['chat', 'generating', 'preview', 'editor', 'settings'] as const
type _Exhaustive = typeof ALL_VIEW_MODES[number] extends ViewMode
  ? ViewMode extends typeof ALL_VIEW_MODES[number] ? true : never
  : never
const _exhaustive: _Exhaustive = true
void _exhaustive

describe('posse dos atalhos de diff por vista', () => {
  it('as vistas sem barra são exatamente editor, settings e generating', () => {
    expect([...VIEWS_WITHOUT_DIFF_BAR].sort()).toEqual(['editor', 'generating', 'settings'])
  })

  it('chat e preview montam a barra — o handler global NÃO pode agir aí', () => {
    // As duas vistas que renderizam ChatView + composer.
    expect(VIEWS_WITHOUT_DIFF_BAR.has('chat')).toBe(false)
    expect(VIEWS_WITHOUT_DIFF_BAR.has('preview')).toBe(false)
  })

  it('o conjunto e o seu complemento são ambos não-vazios e cobrem ViewMode', () => {
    // Havia aqui um terceiro teste que comparava `!S.has(m)` com `S.has(m)` e
    // afirmava que diferiam — verdadeiro por construção, portanto incapaz de
    // falhar. Isto verifica o que interessa mesmo: que nenhum dos lados
    // colapsa (um Set vazio deixaria o handler global morto em todas as
    // vistas; um Set com todas as vistas desligaria a barra por completo) e
    // que nenhuma ViewMode fica fora da união.
    const withBar = ALL_VIEW_MODES.filter(m => !VIEWS_WITHOUT_DIFF_BAR.has(m))
    const withoutBar = ALL_VIEW_MODES.filter(m => VIEWS_WITHOUT_DIFF_BAR.has(m))

    expect(withBar.length).toBeGreaterThan(0)
    expect(withoutBar.length).toBeGreaterThan(0)
    expect(withBar.length + withoutBar.length).toBe(ALL_VIEW_MODES.length)
    // O Set não pode conter nada que não seja uma ViewMode real.
    for (const mode of VIEWS_WITHOUT_DIFF_BAR) {
      expect(ALL_VIEW_MODES).toContain(mode)
    }
  })
})
