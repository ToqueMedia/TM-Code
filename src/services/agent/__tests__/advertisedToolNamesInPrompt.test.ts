/**
 * O prompt nunca pode nomear uma tool por um nome que o modelo não vê.
 *
 * `getToolDefinitions()` renomeia o schema para o dialecto de treino
 * (ADVERTISED_TOOL_NAMES): o modelo recebe `Bash`, `Read`, `Edit`, `Write`,
 * `Grep`, `Glob`, `LS`, `Task`, `WebFetch`, `WebSearch`. As chaves internas
 * (`execute_command`, `read_file`, …) continuam a existir no registo, nos
 * gates e nos grants do permissions.json — mas são invisíveis para o modelo.
 *
 * Escrever "use `execute_command`" no prompt manda-o chamar uma tool que não
 * está na lista dele. Era o estado até 2026-07-31: 33 interpolações do nome
 * canónico, incluindo uma frase que misturava os dois dialectos na mesma
 * linha ("`write_file` and `edit_file` require you to use `Read` first").
 *
 * Tools SEM nome de treino (create_file, start_dev_server, update_tasks,
 * capture_url_design, agent_shell_*) mantêm o nome canónico de propósito: são
 * do TM Code e não há dialecto para adoptar.
 */
import { invoke } from '@tauri-apps/api/core'
import ContextBuilder from '../contextBuilder'
import { ADVERTISED_TOOL_NAMES } from '../toolNames'
import { getVisionSection } from '../contextBuilder/sections/chatSections'

jest.mock('../../../utils/viteEnv')
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }))

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

describe('nomes de tools no system prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'build_file_tree') return { name: 'proj', is_directory: true, children: [] }
      if (cmd === 'list_directory') return []
      return null
    })
  })

  it('nenhuma tool com nome de treino é nomeada pelo nome canónico', async () => {
    const builder = new ContextBuilder()
    // AS DUAS METADES. `buildSystemPrompt` devolve só a parte cacheável; o
    // bloco `# Environment` e o resto do contexto volátil saem por
    // `getLastVolatileContext()` e vão no MESMO system prompt. A primeira
    // versão deste teste só olhava para a metade estática e dava verde com
    // "shell commands you run via execute_command" no Environment.
    const staticPart = await builder.buildSystemPrompt('/test/project', 'web')
    const prompt = `${staticPart}\n${builder.getLastVolatileContext() ?? ''}`

    const leaks: string[] = []
    for (const [canonical, advertised] of Object.entries(ADVERTISED_TOOL_NAMES)) {
      // `glob` e `delegate` são também palavras inglesas correntes ("a search
      // plus a glob", "delegate a research sub-agent"), portanto só contam
      // quando vêm em backticks — a convenção do prompt para referir uma tool.
      // Os nomes com underscore nunca são prosa: bastam fronteiras de palavra
      // (que também impedem apanhar `execute_command_background`, uma tool
      // SEPARADA e sem alias, dentro de `execute_command`).
      const pattern = canonical.includes('_')
        ? `(?<![\\w-])${canonical}(?![\\w-])`
        : `\`${canonical}\``
      const hit = new RegExp(pattern).exec(prompt)
      if (hit) {
        // O excerto faz parte da mensagem de falha de propósito: sem ele, quem
        // apanhar esta regressão sabe QUE há uma fuga mas não onde, e o prompt
        // é montado a partir de dezenas de secções.
        const around = prompt.slice(Math.max(0, hit.index - 90), hit.index + 90).replace(/\n/g, '⏎')
        leaks.push(`${canonical} → devia ser "${advertised}" | …${around}…`)
      }
    }

    expect(leaks).toEqual([])
  })

  it('o prompt usa efetivamente os nomes de treino', async () => {
    // Contraprova do teste acima: se a interpolação partisse e o prompt
    // deixasse de nomear tools de todo, o primeiro teste passava na mesma.
    const builder = new ContextBuilder()
    const prompt = await builder.buildSystemPrompt('/test/project', 'web')
    for (const advertised of ['Bash', 'Read', 'Edit', 'Write', 'Grep']) {
      expect(prompt).toContain(`\`${advertised}\``)
    }
  })

  it('a secção de visão segue a capacidade REAL do modelo', async () => {
    // Duas realidades: sem visão nativa o sidecar injeta uma descrição em
    // texto; com visão nativa a imagem vai no image_url e não existe descrição
    // nenhuma. Mandar um modelo multimodal "tratar a descrição como o que vês"
    // aponta-o para um artefacto que não está no turno. O irmão desta
    // capacidade (supportsSearch) já era condicional; a visão não era.
    expect(getVisionSection(false)).toContain('a vision pipeline analyzes it')
    expect(getVisionSection(true)).not.toContain('a vision pipeline analyzes it')
    expect(getVisionSection(true)).toContain('arrive directly in your context')
    // A regra que vale nos dois casos não pode ficar dentro do ramo.
    for (const native of [true, false]) {
      expect(getVisionSection(native)).toContain('never say "I can\'t see images"')
    }
  })

  it('tools sem equivalente de treino mantêm o nome canónico', async () => {
    const builder = new ContextBuilder()
    const prompt = await builder.buildSystemPrompt('/test/project', 'web')
    // Não estão em ADVERTISED_TOOL_NAMES — renomeá-las seria inventar um nome
    // que o modelo também não conhece, que é o erro simétrico.
    expect(ADVERTISED_TOOL_NAMES['create_file']).toBeUndefined()
    expect(ADVERTISED_TOOL_NAMES['start_dev_server']).toBeUndefined()
    expect(prompt).toContain('create_file')
  })
})
