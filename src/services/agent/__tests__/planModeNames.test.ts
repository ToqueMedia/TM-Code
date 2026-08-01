/**
 * O `/plan` tem DUAS superfícies que o modelo lê e que a varredura da ronda 1
 * não cobria: as mensagens de bloqueio (`planMode.ts`) e a lista "Allowed
 * tools" do prompt do arquiteto.
 *
 * As mensagens de bloqueio são o pior sítio para nomear uma tool pelo nome
 * errado: existem precisamente para dizer ao modelo o que ELE PODE chamar a
 * seguir. "Allowed in this mode: read_file, list_directory…" entregue a quem
 * só tem `Read`/`LS` no schema não desbloqueia nada — manda-o tentar tools
 * que não existem, e cada tentativa custa um turno num modo com cap.
 *
 * A lista do prompt tem um segundo problema, independente do dialecto: tem
 * de bater com PLAN_MODE_ALLOWED_TOOLS. Sub-declarar é perda de capacidade
 * silenciosa (o prompt afirma "everything else is blocked"); sobre-declarar
 * manda o arquiteto contra um bloqueio mecânico.
 */
import { checkPlanModeAccess, PLAN_MODE_ALLOWED_TOOLS } from '../planMode'
import { ADVERTISED_TOOL_NAMES, advertisedToolName } from '../toolNames'

function leaksIn(text: string): string[] {
  const out: string[] = []
  for (const [canonical, advertised] of Object.entries(ADVERTISED_TOOL_NAMES)) {
    const pattern = canonical.includes('_')
      ? new RegExp(`(?<![\\w-])${canonical}(?![\\w-])`)
      : new RegExp(`\`${canonical}\``)
    if (pattern.test(text)) out.push(`${canonical} → devia ser "${advertised}"`)
  }
  return out
}

describe('/plan — nomes de tools nas mensagens de bloqueio', () => {
  const ROOT = '/proj'

  it('o bloqueio de tool-de-implementação não nomeia nada pelo canónico', () => {
    const msg = checkPlanModeAccess('execute_command', '', ROOT, 'PLAN.md')
    expect(msg).toBeTruthy()
    expect(leaksIn(msg as string)).toEqual([])
  })

  it('o bloqueio ecoa o nome que o modelo escreveu, não o interno', () => {
    // O modelo chama `Bash`; dizer-lhe "execute_command is an implementation
    // tool" faz o bloqueio parecer ser sobre outra tool qualquer.
    const msg = checkPlanModeAccess('Bash', '', ROOT, 'PLAN.md') as string
    expect(msg).toContain('Bash is an implementation tool')
    expect(msg).not.toContain('execute_command is an implementation tool')
  })

  it('o bloqueio de caminho também ecoa o nome anunciado', () => {
    const msg = checkPlanModeAccess('Write', '/proj/src/App.tsx', ROOT, 'PLAN.md') as string
    expect(msg).toContain('Write can only write')
    expect(leaksIn(msg)).toEqual([])
  })

  it('a lista "Allowed in this mode" só usa nomes que o modelo tem', () => {
    const msg = checkPlanModeAccess('delete_file', '', ROOT, 'PLAN.md') as string
    const listed = msg.slice(msg.indexOf('Allowed in this mode:'))
    for (const advertised of ['Read', 'LS', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Write', 'Edit']) {
      expect(listed).toContain(advertised)
    }
    expect(leaksIn(listed)).toEqual([])
  })

  it('tudo o que PLAN_MODE_ALLOWED_TOOLS permite passa o gate', () => {
    // Guarda contra o Set e as mensagens divergirem: se uma tool for retirada
    // do Set sem sair da mensagem (ou vice-versa), isto acusa.
    //
    // As write tools afirmam-se à parte em vez de ficarem num `if` sem
    // asserção: um expect condicional é meio teste — as três tools mais
    // sensíveis do modo eram justamente as que não verificavam nada.
    const WRITES = ['write_file', 'create_file', 'edit_file']
    for (const canonical of PLAN_MODE_ALLOWED_TOOLS) {
      const asModelCallsIt = advertisedToolName(canonical)
      if (WRITES.includes(canonical)) {
        // Passam a allow-list mas são restritas por CAMINHO: no artefacto do
        // plano passam, em código-fonte são bloqueadas.
        expect(checkPlanModeAccess(asModelCallsIt, `${ROOT}/PLAN.md`, ROOT, 'PLAN.md')).toBeNull()
        const off = checkPlanModeAccess(asModelCallsIt, `${ROOT}/src/App.tsx`, ROOT, 'PLAN.md')
        expect(off).toContain('can only write')
      } else {
        // Caminho vazio: só o gate de allow-list.
        expect(checkPlanModeAccess(asModelCallsIt, '', ROOT, 'PLAN.md')).toBeNull()
      }
    }
  })
})
