import {
  budgetMcpDescriptions,
  capMcpDescription,
} from '../mcpDescriptionBudget'
import {
  MCP_TOOL_DESCRIPTION_MAX_CHARS,
  MCP_SERVER_DESCRIPTIONS_MAX_CHARS,
  MCP_TOTAL_DESCRIPTIONS_MAX_CHARS,
} from '../agentConfig'

const mk = (serverName: string, name: string, description: string) => ({
  serverName,
  name,
  description,
})

describe('capMcpDescription', () => {
  it('deixa passar intacta uma descrição dentro do teto', () => {
    const desc = 'Reads a file from disk.'
    expect(capMcpDescription(desc)).toBe(desc)
  })

  it('corta e MARCA — nunca em silêncio', () => {
    const desc = 'x'.repeat(MCP_TOOL_DESCRIPTION_MAX_CHARS + 500)
    const out = capMcpDescription(desc)
    expect(out.length).toBeLessThan(desc.length)
    expect(out).toContain('descrição MCP truncada')
    expect(out).toContain(String(desc.length))
  })
})

describe('budgetMcpDescriptions — teto por ferramenta', () => {
  it('corta a descrição gorda e conta-a como truncada', () => {
    const { tools, stats } = budgetMcpDescriptions([
      mk('openapi', 'huge', 'y'.repeat(MCP_TOOL_DESCRIPTION_MAX_CHARS * 3)),
      mk('openapi', 'small', 'ok'),
    ])
    expect(stats.truncated).toBe(1)
    expect(stats.omitted).toBe(0)
    expect(tools[0]!.description).toContain('descrição MCP truncada')
    expect(tools[1]!.description).toBe('ok')
  })

  it('não muta a entrada', () => {
    const original = mk('s', 't', 'z'.repeat(MCP_TOOL_DESCRIPTION_MAX_CHARS * 2))
    const before = original.description
    budgetMcpDescriptions([original])
    expect(original.description).toBe(before)
  })
})

describe('budgetMcpDescriptions — teto por servidor', () => {
  it('omite as descrições que passam do teto do servidor, nomeando a ferramenta', () => {
    // Cada descrição enche exactamente o teto por ferramenta; são precisas
    // ~14 para passar o teto do servidor (20K).
    const perTool = MCP_TOOL_DESCRIPTION_MAX_CHARS
    const count = Math.ceil(MCP_SERVER_DESCRIPTIONS_MAX_CHARS / perTool) + 3
    const input = Array.from({ length: count }, (_, i) =>
      mk('fat', `tool${i}`, 'a'.repeat(perTool)),
    )

    const { tools, stats } = budgetMcpDescriptions(input)

    expect(stats.omitted).toBeGreaterThan(0)
    const omitted = tools.filter(t => t.description.includes('descrição MCP omitida'))
    expect(omitted.length).toBe(stats.omitted)
    // A nota nomeia a ferramenta para o modelo saber que ela existe.
    expect(omitted[0]!.description).toContain(`mcp__fat__${omitted[0]!.name}`)
    expect(omitted[0]!.description).toContain('EXISTE')
  })

  it('o teto de um servidor não consome o de outro', () => {
    const perTool = MCP_TOOL_DESCRIPTION_MAX_CHARS
    const count = Math.ceil(MCP_SERVER_DESCRIPTIONS_MAX_CHARS / perTool) + 2
    const fat = Array.from({ length: count }, (_, i) =>
      mk('fat', `tool${i}`, 'a'.repeat(perTool)),
    )
    const { tools } = budgetMcpDescriptions([...fat, mk('slim', 'ping', 'Pings.')])

    const slim = tools.find(t => t.serverName === 'slim')!
    expect(slim.description).toBe('Pings.')
  })
})

describe('budgetMcpDescriptions — teto agregado', () => {
  it('trava no total mesmo com muitos servidores pequenos', () => {
    const perTool = MCP_TOOL_DESCRIPTION_MAX_CHARS
    const toolsPerServer = 10 // 15K por servidor: sempre abaixo do teto de servidor
    const servers = Math.ceil(MCP_TOTAL_DESCRIPTIONS_MAX_CHARS / (perTool * toolsPerServer)) + 2

    const input = []
    for (let s = 0; s < servers; s++) {
      for (let i = 0; i < toolsPerServer; i++) {
        input.push(mk(`srv${s}`, `tool${i}`, 'b'.repeat(perTool)))
      }
    }

    const { tools, stats } = budgetMcpDescriptions(input)

    expect(stats.omitted).toBeGreaterThan(0)
    // Nenhuma ferramenta desaparece — todas continuam registáveis.
    expect(tools.length).toBe(input.length)
    // O texto real de descrição fica dentro do teto agregado (as notas de
    // omissão são curtas e contabilizadas à parte no total devolvido).
    const realDescriptionChars = tools
      .filter(t => !t.description.includes('descrição MCP omitida'))
      .reduce((acc, t) => acc + t.description.length, 0)
    expect(realDescriptionChars).toBeLessThanOrEqual(MCP_TOTAL_DESCRIPTIONS_MAX_CHARS)
  })

  it('um conjunto pequeno passa sem cortes', () => {
    const { tools, stats } = budgetMcpDescriptions([
      mk('canva', 'read-design', 'Read a Canva design.'),
      mk('canva', 'export-design', 'Export a design to PDF.'),
    ])
    expect(stats.truncated).toBe(0)
    expect(stats.omitted).toBe(0)
    expect(tools.map(t => t.description)).toEqual([
      'Read a Canva design.',
      'Export a design to PDF.',
    ])
  })
})
