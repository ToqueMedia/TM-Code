/**
 * Checkpoints tem de continuar ALCANÇÁVEL depois de mudar de sítio.
 *
 * O botão saiu da linha de acções do PromptBar para a toolbar do chat, ao lado
 * do Preview / Live Preview. A toolbar, ao contrário do PromptBar, ESCONDE-SE:
 *
 *   - `@container (max-width: 480px)` faz `display:none !important` ao cluster
 *     `data-chat-toolbar-wide-only` e revela o menu "…" no lugar dele;
 *   - abrir o próprio drawer de checkpoints liga o `isSidebarMode`, que
 *     desmonta esse cluster por completo.
 *
 * Ou seja, há dois estados em que a casa nova do botão desaparece — um deles
 * provocado por carregar no próprio botão. Este teste afirma que existe uma
 * saída em cada um: a montagem de sidebar-mode e a entrada no menu overflow.
 * Sem elas, a mudança de sítio transformava-se em "a funcionalidade sumiu".
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ChatView.tsx'), 'utf8',
)
const PROMPT_ACTIONS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'prompt', 'PromptActions.tsx'), 'utf8',
)

describe('Checkpoints — alcançável em todos os estados da toolbar', () => {
  it('existe no cluster largo, à ESQUERDA do Live Preview e do Preview', () => {
    // Âncora no JSX, não na regra CSS: `data-chat-toolbar-wide-only` aparece
    // primeiro no bloco de estilos, e uma fatia a partir daí não contém
    // componente nenhum — o teste passaria a medir o ficheiro errado.
    const jsxStart = SRC.indexOf('<HStack data-chat-toolbar-wide-only')
    expect(jsxStart).toBeGreaterThan(-1)
    const wide = SRC.slice(jsxStart, SRC.indexOf('</HStack>', jsxStart))
    const checkpoint = wide.indexOf('<CheckpointsToolbarButton />')
    const terminal = wide.indexOf('<TerminalToolbarButton />')
    const share = wide.indexOf('<CollabShareControls previewOnly />')
    const preview = wide.indexOf("t('view.preview')")
    expect(checkpoint).toBeGreaterThan(-1)
    expect(terminal).toBeGreaterThan(-1)
    expect(share).toBeGreaterThan(-1)
    expect(preview).toBeGreaterThan(-1)
    expect(checkpoint).toBeLessThan(terminal)
    expect(terminal).toBeLessThan(share)
    expect(checkpoint).toBeLessThan(preview)
  })

  it('existe TAMBÉM em sidebar mode — senão abrir o drawer escondia o botão que o fecha', () => {
    expect(SRC).toMatch(/isSidebarMode && <CheckpointsToolbarButton \/>/)
    expect(SRC).toMatch(/isSidebarMode && <TerminalToolbarButton \/>/)
  })

  it('existe no menu overflow — a saída para a coluna estreita', () => {
    // A regressão exacta que isto tranca: o cluster largo morre aos 480px e o
    // menu "…" só tinha Preview e Sandbox. Sem esta entrada, Checkpoints ficava
    // inacessível numa janela estreita ou com um drawer aberto.
    const menu = SRC.slice(SRC.indexOf('function HeaderOverflowMenu'))
    expect(menu).toMatch(/label=\{checkpointCount > 0/)
    expect(menu).toMatch(/toggleCheckpointDrawer\(\)/)
    expect(menu).toMatch(/useTerminalPanelStore\.getState\(\)\.toggle\(\)/)
  })

  it('o breakpoint que esconde o cluster continua a revelar o menu', () => {
    // Se algum dia estes dois deixarem de andar juntos, a saída desaparece
    // sem ninguém dar por isso.
    const query = SRC.slice(SRC.indexOf('@container (max-width: 480px)'), SRC.indexOf('@container (max-width: 480px)') + 400)
    expect(query).toMatch(/data-chat-toolbar-wide-only[\s\S]*display: 'none !important'/)
    expect(query).toMatch(/data-chat-toolbar-overflow-trigger[\s\S]*display: 'flex !important'/)
  })

  it('abrir Checkpoints NÃO fecha o terminal — o PTY passou para o fundo', () => {
    const btn = SRC.slice(SRC.indexOf('function CheckpointsToolbarButton'))
    expect(btn).not.toMatch(/closeTerminal\(\)/)
  })

  it('já não vive na linha de acções do prompt', () => {
    expect(PROMPT_ACTIONS).not.toMatch(/toggleCheckpointDrawer/)
    expect(PROMPT_ACTIONS).not.toMatch(/checkpointCount/)
    expect(PROMPT_ACTIONS).not.toMatch(/toggleTerminal/)
  })
})
