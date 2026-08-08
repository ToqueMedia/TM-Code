import { invoke } from '@tauri-apps/api/core'
import { sessionService } from '../sessionService'
import type { ChatSession } from '../../../types/chat'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

/**
 * Sessões em JSON simples (2026-08-06, pedido do developer — segunda vez).
 *
 * A encriptação saiu da ESCRITA e ficou na LEITURA: os ficheiros gravados antes
 * continuam cifrados em disco e têm de abrir. Isso faz do round-trip a única
 * verificação que interessa, e foi entregue sem ela — como este dia mostrou
 * três vezes, "compila e os testes passam" não é o mesmo que "foi exercitado".
 *
 * O que se trava aqui:
 *   1. o que vai para o disco é JSON legível (não um blob)
 *   2. o que foi escrito volta a ler-se
 *   3. um ficheiro ENCRIPTADO antigo continua a abrir
 */

/** Disco em memória: `path → conteúdo`, escrito e lido pelo mesmo mock. */
function mockDisk(seed: Record<string, string> = {}) {
  const disk: Record<string, string> = { ...seed }
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>
    switch (cmd) {
      case 'get_project_state_dir':
        return '/state/proj'
      case 'write_file':
        disk[a.path as string] = a.content as string
        return null
      case 'read_file': {
        const found = disk[a.path as string]
        if (found === undefined) throw new Error('ENOENT')
        return found
      }
      case 'create_directory':
      case 'set_file_permissions':
      case 'path_exists':
        return cmd === 'path_exists' ? disk[a.path as string] !== undefined : null
      case 'list_directory':
        return []
      default:
        return null
    }
  })
  return disk
}

function session(id: string, texto: string): ChatSession {
  return {
    id,
    name: 'sessão de teste',
    projectPath: '/proj',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: 'm1', role: 'user', content: texto, timestamp: 1 },
    ],
  } as ChatSession
}

describe('persistência de sessões em claro', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('escreve JSON legível — não um blob cifrado', async () => {
    const disk = mockDisk()
    await sessionService.saveSession(session('s1', 'texto reconhecível'))

    const escrito = Object.entries(disk).find(([p]) => p.includes('session_s1'))
    expect(escrito).toBeDefined()
    const [, conteudo] = escrito!
    // Legível a olho: é isto que torna a sessão útil como artefacto de
    // depuração, que foi a razão de tirar a cifra.
    expect(conteudo).toContain('texto reconhecível')
    expect(() => JSON.parse(conteudo)).not.toThrow()
  })

  it('round-trip: o que foi escrito volta a ler-se', async () => {
    mockDisk()
    await sessionService.saveSession(session('s2', 'conteúdo do round-trip'))
    const lida = await sessionService.loadSession('/proj', 's2')
    expect(lida).not.toBeNull()
    expect(lida!.messages[0].content).toBe('conteúdo do round-trip')
  })

  it('um ficheiro que NÃO é JSON não rebenta a leitura', async () => {
    // Sessões antigas estão cifradas; o `decryptSession` trata delas e, quando
    // falha, cai no cru. O que não pode acontecer é a leitura ATIRAR — isso
    // tornaria o histórico anterior inacessível, o oposto do que foi pedido.
    mockDisk({ '/state/proj/sessions/session_s3.json': 'U2FsdGVkX1+lixo=' })
    await expect(sessionService.loadSession('/proj', 's3')).resolves.toBeNull()
  })
})
