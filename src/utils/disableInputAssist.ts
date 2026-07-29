/**
 * Desliga auto-complete e auto-correção em TODOS os campos de texto da IDE.
 *
 * Porquê num sítio só, e não prop a prop: os campos vêm de três origens
 * diferentes — `<Input>`/`<Textarea>` do Chakra (que renderizam DOM próprio),
 * `<input>`/`<textarea>` crus, e o que os componentes de terceiros criam por
 * baixo. Espalhar as props por dezenas de ficheiros cobria o presente e
 * falhava no campo seguinte que alguém acrescentasse. Um observador cobre os
 * três casos e não tem de ser lembrado.
 *
 * O que é desligado, e porquê estes três:
 *  - `autocomplete="off"`   — as sugestões guardadas pelo browser.
 *  - `autocorrect="off"`    — a correcção automática do WebKit (é o atributo
 *                             documentado da Apple; num IDE, "corrigir"
 *                             identificadores é sempre errado).
 *  - `autocapitalize="off"` — companheiro do anterior no WebKit; sem ele, a
 *                             primeira letra de cada campo vinha maiúscula.
 *
 * `spellcheck` fica INTACTO de propósito: é o sublinhado vermelho, não a
 * correcção — desligá-lo tirava o aviso de erros ortográficos em campos de
 * texto livre (chat, mensagens de commit) sem ninguém o ter pedido.
 *
 * Campos que peçam explicitamente o contrário (`data-allow-autocomplete`)
 * ficam de fora — hoje não há nenhum, mas a saída existe para não obrigar a
 * desfazer isto quando aparecer um (ex.: um campo de email num formulário
 * onde o preenchimento do browser é útil).
 */

const FIELDS = 'input, textarea'
const OPT_OUT = 'data-allow-autocomplete'

function applyTo(element: Element): void {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return
  if (element.hasAttribute(OPT_OUT)) return
  // `checkbox`/`radio`/`range` não têm texto para completar nem corrigir;
  // marcá-los só sujaria o DOM.
  if (element instanceof HTMLInputElement && !isTextual(element.type)) return

  element.setAttribute('autocomplete', 'off')
  element.setAttribute('autocorrect', 'off')
  element.setAttribute('autocapitalize', 'off')
}

function isTextual(type: string): boolean {
  return !['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image'].includes(
    type,
  )
}

/**
 * Aplica agora e mantém aplicado. Devolve a função que pára o observador —
 * usada nos testes; em produção vive tanto quanto a janela.
 */
export function disableInputAssist(root: ParentNode = document): () => void {
  root.querySelectorAll(FIELDS).forEach(applyTo)

  if (typeof MutationObserver === 'undefined') return () => {}

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue
        applyTo(node)
        // O campo raramente é o nó adicionado: costuma vir dentro de uma
        // árvore montada de uma vez (um diálogo, um painel).
        node.querySelectorAll?.(FIELDS).forEach(applyTo)
      }
    }
  })
  observer.observe(root instanceof Document ? root.documentElement : (root as Element), {
    childList: true,
    subtree: true,
  })
  return () => observer.disconnect()
}
