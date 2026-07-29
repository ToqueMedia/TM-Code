import { disableInputAssist } from '../disableInputAssist'

/** Espera o MutationObserver correr (é assíncrono, em microtask). */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('disableInputAssist', () => {
  let stop: () => void

  afterEach(() => {
    stop?.()
    document.body.innerHTML = ''
  })

  it('cobre os campos que já estão no ecrã', () => {
    document.body.innerHTML = '<input id="a" /><textarea id="b"></textarea>'
    stop = disableInputAssist()

    for (const id of ['a', 'b']) {
      const el = document.getElementById(id)!
      expect(el.getAttribute('autocomplete')).toBe('off')
      expect(el.getAttribute('autocorrect')).toBe('off')
      expect(el.getAttribute('autocapitalize')).toBe('off')
    }
  })

  it('cobre campos montados depois — o caso que uma prop por ficheiro falha', async () => {
    stop = disableInputAssist()
    // Um diálogo entra de uma vez, com o campo lá dentro: o nó adicionado é o
    // contentor, não o input.
    const dialog = document.createElement('div')
    dialog.innerHTML = '<label>Nome<input id="tarde" /></label>'
    document.body.appendChild(dialog)
    await flush()

    expect(document.getElementById('tarde')!.getAttribute('autocomplete')).toBe('off')
    expect(document.getElementById('tarde')!.getAttribute('autocorrect')).toBe('off')
  })

  it('não mexe no spellcheck — é o sublinhado, não a correcção', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>'
    stop = disableInputAssist()
    expect(document.getElementById('t')!.hasAttribute('spellcheck')).toBe(false)
  })

  it('deixa em paz os inputs sem texto para corrigir', () => {
    document.body.innerHTML = '<input id="c" type="checkbox" /><input id="r" type="range" />'
    stop = disableInputAssist()
    expect(document.getElementById('c')!.hasAttribute('autocomplete')).toBe(false)
    expect(document.getElementById('r')!.hasAttribute('autocomplete')).toBe(false)
  })

  it('respeita a saída explícita', () => {
    document.body.innerHTML = '<input id="ok" data-allow-autocomplete />'
    stop = disableInputAssist()
    expect(document.getElementById('ok')!.hasAttribute('autocomplete')).toBe(false)
  })
})
