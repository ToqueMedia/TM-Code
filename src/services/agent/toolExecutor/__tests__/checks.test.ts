/**
 * Gates de ficheiros de env — a isenção de TEMPLATES tem de estar em sincronia
 * nos DOIS detetores (report 2026-07-18: .env.example caía em
 * forcePrompt='sensitive_file', que salta o Modo Auto por desenho → diálogo
 * humano para um ficheiro de exemplo).
 */
import {
  isEnvFile,
  isSensitiveFile,
  ENV_TEMPLATE_FILES,
  commandReferencesSealedEnv,
} from '../checks'

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

/**
 * O selo baseado em PATH só vê tools com file_path — as superfícies de shell
 * passavam ao lado (auditoria 2026-07-28: `cat .env` via execute_command ou
 * agent_shell_write devolvia os segredos sem diálogo nenhum).
 */
describe('commandReferencesSealedEnv — selo nas superfícies de shell', () => {
  it.each([
    'cat .env',
    'head -n 5 .env.local',
    'xxd .env',
    'grep SECRET .env.production',
    "python -c \"print(open('.env').read())\"",
    'cp .env /tmp/leak',
  ])('bloqueia: %s', (cmd) => {
    expect(commandReferencesSealedEnv(cmd)).toBe(true)
  })

  it.each([
    'cat .env.example',
    'ls -la',
    'yarn build',
    'cat src/environment.ts',
    'echo "environment ready"',
  ])('deixa passar: %s', (cmd) => {
    expect(commandReferencesSealedEnv(cmd)).toBe(false)
  })

  it('--env-file é passagem para outro processo, não leitura para o contexto', () => {
    expect(commandReferencesSealedEnv('docker compose --env-file .env up')).toBe(false)
    expect(commandReferencesSealedEnv('docker run --env-file=.env img')).toBe(false)
    // ... mas um cat depois do flag continua a ser leitura.
    expect(commandReferencesSealedEnv('docker compose --env-file .env up && cat .env')).toBe(true)
  })

  it('estado do regex global não vaza entre chamadas', () => {
    expect(commandReferencesSealedEnv('cat .env')).toBe(true)
    expect(commandReferencesSealedEnv('cat .env')).toBe(true)
  })

  describe('isSensitiveFile — caminho ausente', () => {
    // Reportado em runtime (2026-07-31, sessão momenu-fact): o modelo chamou
    // `read_around({ path: '…/ApiClient.ts' })` — a tool aceita `path` OU
    // `file_path` — e o gate de sensibilidade lia só `file_path`, passando
    // `undefined` para cá. Rebentava com "undefined is not an object
    // (evaluating 'filePath.replace')" e a leitura falhava por inteiro.
    // O `isEnvFile` ao lado já tinha esta guarda; a assimetria era o bug.
    it('não rebenta com undefined/vazio', () => {
      expect(isSensitiveFile(undefined)).toBe(false)
      expect(isSensitiveFile('')).toBe(false)
    })
  })
})
