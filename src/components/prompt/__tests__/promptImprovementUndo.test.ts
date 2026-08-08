/**
 * Anular a melhoria de prompt — as três transições de estado do botão.
 *
 * O botão é o MESMO da varinha: enquanto existe um backup mostra "anular", e
 * volta a "melhorar" quando já não há nada a desfazer. Isso torna a condição
 * `canUndoImprovePrompt` responsável por qual ação o clique dispara — um
 * estado preso significaria um utilizador a carregar em "melhorar" e a ver o
 * seu texto ser substituído pelo antigo.
 *
 * As três transições, e porquê cada uma:
 *   melhorar        → há backup   (há o que anular)
 *   editar o texto  → sem backup  (o texto já não é o que foi gerado)
 *   ENVIAR          → sem backup  (enviar É aceitar; não há volta atrás)
 *
 * A terceira era o bug reportado: o botão ficava lá depois do envio, a
 * prometer desfazer uma coisa que já tinha saído. Este teste exercita a
 * MÁQUINA DE ESTADOS do hook (não o DOM), porque é onde o defeito vivia.
 */
import * as fs from 'fs'
import * as path from 'path'

const HOOK = fs.readFileSync(path.join(__dirname, '..', 'usePromptBar.ts'), 'utf8')
const BAR = fs.readFileSync(
  path.join(__dirname, '..', '..', 'PromptBar.tsx'), 'utf8',
)
const ACTIONS = fs.readFileSync(path.join(__dirname, '..', 'PromptActions.tsx'), 'utf8')

/** Corpo de uma função/callback nomeada, do `const nome =` até ao fecho. */
function sliceFrom(src: string, marker: string, chars = 2600): string {
  const i = src.indexOf(marker)
  if (i === -1) throw new Error(`marcador não encontrado: ${marker}`)
  return src.slice(i, i + chars)
}

describe('undo da melhoria de prompt — máquina de estados', () => {
  it('melhorar guarda o backup (é o que acende o botão de anular)', () => {
    const body = sliceFrom(HOOK, 'const handleImprovePrompt =')
    expect(body).toMatch(/setPromptImprovementBackup\(original\)/)
  })

  it('editar o texto limpa o backup', () => {
    // O texto deixou de ser o que a melhoria produziu — não há "o antigo"
    // coerente para onde voltar.
    const body = sliceFrom(HOOK, 'const handleInputChange =', 400)
    expect(body).toMatch(/setPromptImprovementBackup\(null\)/)
  })

  it('ENVIAR limpa o backup — enviar é aceitar', () => {
    const body = sliceFrom(HOOK, 'const handleSend =', 2600)
    expect(body).toMatch(/setPromptImprovementBackup\(null\)/)
  })

  it('a limpeza no envio fica DEPOIS dos guards de early-return', () => {
    // Um envio bloqueado (sem auth, tools em falta, permissão pendente) não
    // pode deitar fora o texto original: o utilizador continua com o prompt
    // melhorado no ecrã e ainda pode querer voltar atrás.
    const body = sliceFrom(HOOK, 'const handleSend =', 2600)
    const clearAt = body.indexOf('setPromptImprovementBackup(null)')
    const authGuard = body.indexOf('if (!isAuthenticated) return')
    const toolsGuard = body.indexOf('selectAgentBlocked(tools)')
    expect(authGuard).toBeGreaterThan(-1)
    expect(toolsGuard).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(authGuard)
    expect(clearAt).toBeGreaterThan(toolsGuard)
  })
})

describe('undo da melhoria de prompt — onde o botão vive', () => {
  it('o botão dentro do input alterna entre varinha e anular', () => {
    // Um só controlo: o ícone diz o que faz, e o clique segue o estado.
    expect(BAR).toMatch(/canUndoImprovePrompt \? <VscDiscard/)
    expect(BAR).toMatch(/if \(canUndoImprovePrompt\) handleUndoImprovePrompt\(\)/)
    expect(BAR).toMatch(/else handleImprovePrompt\(\)/)
  })

  it('o rótulo e o título acompanham o estado (não mentem sobre a ação)', () => {
    expect(BAR).toMatch(/canUndoImprovePrompt \? t\('prompt\.undoPromptImprovement'\)/)
    expect(BAR).toMatch(/canUndoImprovePrompt\s*\?\s*t\('prompt\.undoPromptImprovementTitle'\)/)
  })

  it('em estado de anular o botão NÃO fica desativado por falta de texto', () => {
    // `disabled` só olha para `hasInputContent` quando está em modo melhorar —
    // senão, apagar o texto prendia o backup sem forma de o desfazer.
    expect(BAR).toMatch(/disabled=\{isImprovingPrompt \|\| \(!canUndoImprovePrompt && !hasInputContent\)\}/)
  })

  it('a linha de acções já não duplica o botão de anular', () => {
    // Regressão a evitar: dois controlos para a mesma ação, um deles longe
    // do sítio onde a melhoria aconteceu.
    expect(ACTIONS).not.toMatch(/onUndoImprovePrompt/)
    expect(ACTIONS).not.toMatch(/canUndoImprovePrompt/)
  })
})
