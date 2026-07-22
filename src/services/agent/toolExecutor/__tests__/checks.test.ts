/**
 * Gates de ficheiros de env — a isenção de TEMPLATES tem de estar em sincronia
 * nos DOIS detetores (report 2026-07-18: .env.example caía em
 * forcePrompt='sensitive_file', que salta o Modo Auto por desenho → diálogo
 * humano para um ficheiro de exemplo).
 */
import { isEnvFile, isSensitiveFile, ENV_TEMPLATE_FILES } from '../checks'

export {}

describe('env template exemption — sincronizada entre gates', () => {
  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist'])(
    '%s é template: nem env-gate nem sensível',
    (name) => {
      expect(isEnvFile(`/proj/${name}`)).toBe(false)
      expect(isSensitiveFile(`/proj/${name}`)).toBe(false)
    },
  )

  it.each(['.env', '.env.local', '.env.production'])(
    '%s é segredo real: env-gate E sensível (humano SEMPRE, mesmo em Modo Auto)',
    (name) => {
      expect(isEnvFile(`/proj/${name}`)).toBe(true)
      expect(isSensitiveFile(`/proj/${name}`)).toBe(true)
    },
  )

  it('outros sensíveis continuam sensíveis', () => {
    expect(isSensitiveFile('/a/server.key')).toBe(true)
    expect(isSensitiveFile('/a/credentials.json')).toBe(true)
    expect(isSensitiveFile('/a/.npmrc')).toBe(true)
  })

  it('ficheiros normais não disparam nada', () => {
    expect(isSensitiveFile('/a/index.ts')).toBe(false)
    expect(isEnvFile('/a/environment.ts')).toBe(false)
  })

  it('o Set partilhado é a fonte única das 4 convenções', () => {
    expect(ENV_TEMPLATE_FILES.size).toBe(4)
  })
})
