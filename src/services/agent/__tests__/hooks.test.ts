import { invoke } from '@tauri-apps/api/core'
import {
  runHooks,
  appendHookContext,
  takeHookContext,
  __resetHooksConfigCacheForTests,
} from '../hooks'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

/** Config do developer + resposta de um comando, pelo mesmo canal que o runtime usa. */
function mockProject(config: unknown, exec: Record<string, unknown>) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'read_file') {
      const path = (args as Record<string, unknown>)?.path as string
      if (path?.endsWith('.toquemedia/hooks.json')) {
        return config === null ? null : JSON.stringify(config)
      }
      throw new Error('not found')
    }
    if (cmd === 'execute_command') return exec
    return null
  })
}

const BASE = { toolName: 'Write', toolInput: { file_path: '/p/a.ts' }, projectPath: '/p', fsVersion: 1 }

describe('hooks', () => {
  // GUARDA DE CONTRATO. O `CommandResult` do Rust vem em camelCase
  // (`#[serde(rename_all = "camelCase")]`). A primeira versão lia `exit_code`,
  // o campo chegava undefined e nenhum hook bloqueava — e os testes não
  // apanharam nada porque mockavam o mesmo nome errado. Este caso falha se
  // alguém voltar a assumir snake_case, porque afirma o nome REAL.
  it('lê o exit code pelo nome que o Rust serializa (camelCase)', async () => {
    mockProject(
      { PreToolUse: [{ hooks: [{ command: 'g.sh' }] }] },
      { stdout: '', stderr: 'não', exitCode: 2, success: false },
    )
    await expect(runHooks('PreToolUse', BASE)).resolves.toMatchObject({ blocked: true })

    __resetHooksConfigCacheForTests()
    mockProject(
      { PreToolUse: [{ hooks: [{ command: 'g.sh' }] }] },
      { stdout: '', stderr: 'não', exit_code: 2, success: false } as never,
    )
    const snake = await runHooks('PreToolUse', BASE)
    expect(snake.blocked).toBe(false)
  })

  beforeEach(() => {
    mockedInvoke.mockReset()
    __resetHooksConfigCacheForTests()
  })

  it('sem config, não corre nada (o caso normal não pode custar um spawn)', async () => {
    mockProject(null, {})
    const out = await runHooks('PostToolUse', BASE)
    expect(out.blocked).toBe(false)
    expect(mockedInvoke).not.toHaveBeenCalledWith('execute_command', expect.anything())
  })

  // O payload em JSON no stdin é O CONTRATO do cli-vaz — é ele que faz um hook
  // escrito para o Claude Code correr aqui sem alterações.
  it('entrega o evento em JSON no STDIN, com o nome que o MODELO vê', async () => {
    mockProject(
      { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'check.sh' }] }] },
      { stdout: '', stderr: '', exitCode: 0 },
    )
    await runHooks('PostToolUse', { ...BASE, toolResponse: 'ok', sessionId: 's1' })
    const call = mockedInvoke.mock.calls.find(c => c[0] === 'execute_command')
    expect(call).toBeDefined()
    const args = call![1] as Record<string, unknown>
    expect(args.command).toBe('check.sh')
    expect(args.cwd).toBe('/p')
    const payload = JSON.parse(args.stdin as string)
    expect(payload).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/p/a.ts' },
      tool_response: 'ok',
      session_id: 's1',
      cwd: '/p',
    })
  })

  it('o matcher é uma regex e o que não casa não corre', async () => {
    mockProject(
      { PostToolUse: [{ matcher: '^Bash$', hooks: [{ command: 'nope.sh' }] }] },
      { stdout: '', exitCode: 0 },
    )
    await runHooks('PostToolUse', BASE)
    expect(mockedInvoke.mock.calls.some(c => c[0] === 'execute_command')).toBe(false)
  })

  it('exit code 2 bloqueia, com o stderr como razão (convenção cli-vaz)', async () => {
    mockProject(
      { PreToolUse: [{ hooks: [{ command: 'guard.sh' }] }] },
      { stdout: '', stderr: 'usa os tokens do tema', exitCode: 2 },
    )
    const out = await runHooks('PreToolUse', BASE)
    expect(out.blocked).toBe(true)
    expect(out.blockReason).toContain('usa os tokens do tema')
  })

  it('decision:block no stdout também bloqueia', async () => {
    mockProject(
      { PreToolUse: [{ hooks: [{ command: 'guard.sh' }] }] },
      { stdout: JSON.stringify({ decision: 'block', reason: 'ficheiro selado' }), exitCode: 0 },
    )
    const out = await runHooks('PreToolUse', BASE)
    expect(out.blocked).toBe(true)
    expect(out.blockReason).toBe('ficheiro selado')
  })

  it('additionalContext volta para ser entregue ao modelo', async () => {
    mockProject(
      { PostToolUse: [{ hooks: [{ command: 'lint.sh' }] }] },
      {
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'hex cru em a.ts' } }),
        exitCode: 0,
      },
    )
    const out = await runHooks('PostToolUse', BASE)
    expect(out.blocked).toBe(false)
    expect(out.additionalContext).toBe('hex cru em a.ts')
  })

  // Um hook partido não pode parar o agente — mas também não pode passar por
  // bem-sucedido. Estas três entradas são todas config de developer real.
  it('config inválida, stdout não-JSON e exit≠0 não bloqueiam nem rebentam', async () => {
    mockProject('{ isto não é json', { stdout: '', exitCode: 0 })
    await expect(runHooks('PostToolUse', BASE)).resolves.toEqual({ blocked: false })

    __resetHooksConfigCacheForTests()
    mockProject(
      { PostToolUse: [{ matcher: '([', hooks: [{ command: 'x.sh' }] }] },
      { stdout: '', exitCode: 0 },
    )
    await expect(runHooks('PostToolUse', BASE)).resolves.toEqual({ blocked: false })

    __resetHooksConfigCacheForTests()
    mockProject(
      { PostToolUse: [{ hooks: [{ command: 'x.sh' }] }] },
      { stdout: 'saída solta', stderr: 'boom', exitCode: 1 },
    )
    await expect(runHooks('PostToolUse', BASE)).resolves.toEqual({ blocked: false })
  })

  it('corre em série e o primeiro bloqueio interrompe os seguintes', async () => {
    const ran: string[] = []
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'read_file') {
        return JSON.stringify({
          PreToolUse: [{ hooks: [{ command: 'a.sh' }, { command: 'b.sh' }] }],
        })
      }
      if (cmd === 'execute_command') {
        const c = (args as Record<string, unknown>).command as string
        ran.push(c)
        return c === 'a.sh' ? { stderr: 'não', exitCode: 2 } : { stdout: '', exitCode: 0 }
      }
      return null
    })
    const out = await runHooks('PreToolUse', BASE)
    expect(out.blocked).toBe(true)
    expect(ran).toEqual(['a.sh'])
  })

  it('Pre e Post chegam ao modelo no MESMO bloco, por toolUseId', () => {
    appendHookContext('t1', 'do pre')
    appendHookContext('t1', 'do post')
    expect(takeHookContext('t1')).toBe('do pre\n\ndo post')
    // Consumido uma vez só — senão repetia-se em cada resultado seguinte.
    expect(takeHookContext('t1')).toBeNull()
  })
})

/**
 * GUARDA DE CADEIA. Um callback opcional que atravessa quatro ficheiros
 * (query → queryEngine → agentService → mainDispatch) morre em silêncio se um
 * deles não o repassar: sem erro de compilação, sem teste vermelho, sem
 * marcador. Aconteceu com o `onContextBudgetApplied` — foi entregue partido a
 * meio e só uma sessão real, horas depois, mostrou que o marcador não existia.
 *
 * Este teste lê os ficheiros. É grosseiro de propósito: o que ele trava não é
 * comportamento, é a ligação — e a ligação não tem outro sítio onde falhar
 * visivelmente.
 */
describe('cadeia dos callbacks opcionais do loop', () => {
  const fs = require('fs') as typeof import('fs')
  const read = (f: string) => fs.readFileSync(`src/services/agent/${f}`, 'utf8')

  // Cada callback tem a SUA cadeia: uns são tratados no agentService (que
  // escreve direto no store), outros atravessam até ao mainDispatch. O que
  // conta é que nenhum elo esteja em falta na cadeia DELE.
  it.each([
    ['onContextBudgetApplied', ['query.ts', 'queryEngine.ts', 'agentService.ts', 'mainDispatch.ts']],
    ['onCompactionPhaseStart', ['query.ts', 'queryEngine.ts', 'agentService.ts']],
    ['onCompactionMilestone', []], // removido com a barra de percentagem
  ] as const)('%s: nenhum elo em falta', (cb, chain) => {
    for (const f of chain) expect(read(f).includes(cb)).toBe(true)
  })
})
