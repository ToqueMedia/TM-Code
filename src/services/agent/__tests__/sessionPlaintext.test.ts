import { invoke } from '@tauri-apps/api/core'
import { sessionService } from '../sessionService'
import type { ChatSession } from '../../../types/chat'
import { decryptSession, isEncryptedSession } from '../../../utils/crypto'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

jest.mock('../../../utils/crypto', () => {
  const actual = jest.requireActual('../../../utils/crypto') as typeof import('../../../utils/crypto')
  return {
    ...actual,
    decryptSession: jest.fn((...args: Parameters<typeof actual.decryptSession>) =>
      actual.decryptSession(...args),
    ),
  }
})

/**
 * Sessões em JSON simples (2026-08-06, reafirmado 2026-08-17).
 *
 * A escrita nunca cifra. Um envelope antigo ainda abre — e o load reescreve
 * o ficheiro em claro, para o disco ficar alinhado com a regra.
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

function persistedJson(id: string, texto: string): string {
  return JSON.stringify({
    id,
    projectPath: '/proj',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: 'm1', role: 'user', content: texto, timestamp: 1 }],
  })
}

describe('persistência de sessões em claro', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    ;(decryptSession as jest.Mock).mockImplementation(
      (raw: string, projectPath: string) =>
        jest.requireActual('../../../utils/crypto').decryptSession(raw, projectPath),
    )
  })

  it('escreve JSON legível — não um blob cifrado', async () => {
    const disk = mockDisk()
    await sessionService.saveSession(session('s1', 'texto reconhecível'))

    const escrito = Object.entries(disk).find(([p]) => p.includes('session_s1'))
    expect(escrito).toBeDefined()
    const [, conteudo] = escrito!
    expect(conteudo).toContain('texto reconhecível')
    expect(() => JSON.parse(conteudo)).not.toThrow()
    expect(isEncryptedSession(conteudo)).toBe(false)
  })

  it('round-trip: o que foi escrito volta a ler-se', async () => {
    mockDisk()
    await sessionService.saveSession(session('s2', 'conteúdo do round-trip'))
    const lida = await sessionService.loadSession('/proj', 's2')
    expect(lida).not.toBeNull()
    expect(lida!.messages[0].content).toBe('conteúdo do round-trip')
  })

  it('um ficheiro que NÃO é JSON não rebenta a leitura', async () => {
    mockDisk({ '/state/proj/sessions/session_s3.json': 'U2FsdGVkX1+lixo=' })
    await expect(sessionService.loadSession('/proj', 's3')).resolves.toBeNull()
  })

  it('um envelope antigo abre e o ficheiro fica JSON em claro', async () => {
    const envelope = JSON.stringify({ _enc: 2, d: 'Ym9ndXM=' })
    expect(isEncryptedSession(envelope)).toBe(true)
    ;(decryptSession as jest.Mock).mockResolvedValueOnce(persistedJson('s4', 'vindo da cifra'))

    const disk = mockDisk({ '/state/proj/sessions/session_s4.json': envelope })
    const lida = await sessionService.loadSession('/proj', 's4')

    expect(lida).not.toBeNull()
    expect(lida!.messages[0].content).toBe('vindo da cifra')
    const rewritten = disk['/state/proj/sessions/session_s4.json']
    expect(rewritten).toContain('vindo da cifra')
    expect(isEncryptedSession(rewritten)).toBe(false)
    expect(() => JSON.parse(rewritten)).not.toThrow()
  })

  it('um envelope ENC1 ilegível devolve null', async () => {
    mockDisk({ '/state/proj/sessions/session_s5.json': 'ENC1:nao-e-base64-valido!!!' })
    await expect(sessionService.loadSession('/proj', 's5')).resolves.toBeNull()
  })
})

describe('isEncryptedSession', () => {
  it('reconhece ENC1 e o envelope JSON v2, e rejeita JSON de sessão', () => {
    expect(isEncryptedSession('ENC1:abc')).toBe(true)
    expect(isEncryptedSession('{"_enc":2,"d":"x"}')).toBe(true)
    expect(isEncryptedSession('{\n  "_enc": 2,\n  "d": "x"\n}')).toBe(true)
    expect(isEncryptedSession(persistedJson('s', 'oi'))).toBe(false)
    expect(isEncryptedSession('not json')).toBe(false)
  })

  it('não trata `_enc` no corpo da sessão como envelope', () => {
    const body = JSON.stringify({
      id: 's',
      projectPath: '/p',
      messages: [{ content: '{"_enc":2,"d":"nao-e-envelope"}' }],
    })
    expect(isEncryptedSession(body)).toBe(false)
  })
})
