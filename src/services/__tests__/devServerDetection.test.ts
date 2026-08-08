import {
  classifyProbedUrl,
  detectLineRole,
  extractScriptName,
  pickDevScript,
  type ClassifySlotState,
} from '../devServerDetection'
import { appendDevFlags } from '../devCommandFlags'

const fullstackEmpty: ClassifySlotState = {
  projectKind: 'fullstack',
  frontendUrl: null,
  backendUrl: null,
  backendUrlMirrored: false,
}

describe('detectLineRole — parallel-runner prefix parsing', () => {
  it('detects [client] / [frontend] / [web] / [ui] as frontend', () => {
    expect(detectLineRole('[client] vite ready in 161 ms')).toBe('frontend')
    expect(detectLineRole('[frontend] starting…')).toBe('frontend')
    expect(detectLineRole('[web] http://localhost:3000')).toBe('frontend')
    expect(detectLineRole('[ui] dev server up')).toBe('frontend')
  })

  it('detects [server] / [backend] / [api] as backend', () => {
    expect(detectLineRole('[server] BugHunter server running on http://localhost:3000')).toBe('backend')
    expect(detectLineRole('[backend] listening on 3000')).toBe('backend')
    expect(detectLineRole('[api] ready')).toBe('backend')
  })

  it('detects nested concurrently names like [dev:client] / [dev:server]', () => {
    expect(detectLineRole('[dev:client] vite ready')).toBe('frontend')
    expect(detectLineRole('[dev:server] express ready')).toBe('backend')
  })

  it('detects pnpm/turbo style "client:dev: foo" prefixes', () => {
    expect(detectLineRole('client:dev: vite ready')).toBe('frontend')
    expect(detectLineRole('server:dev: express ready')).toBe('backend')
  })

  it('returns null for unrecognised tokens', () => {
    expect(detectLineRole('[unknown] foo')).toBeNull()
    expect(detectLineRole('[storybook] starting')).toBeNull()
    expect(detectLineRole('plain log line without prefix')).toBeNull()
  })

  it('returns null for empty / whitespace lines', () => {
    expect(detectLineRole('')).toBeNull()
    expect(detectLineRole('   ')).toBeNull()
  })
})

describe('classifyProbedUrl — line role overrides first-probe-wins', () => {
  // Reproduces the BugHunter bug:
  //   1. Express on :3000 with HTML 404 fallback boots first
  //   2. Vite on :5173 boots second, also serves HTML
  //   3. Without role hint, :3000 (HTML) wins frontendUrl wrongly
  //   4. Preview opens at :3000 (backend port) instead of :5173
  it('promotes :5173 to frontendUrl over an already-mirrored :3000 when [client] hint arrives', () => {
    // Step 1: Express probed first, no hint, content-type HTML
    let state = { ...fullstackEmpty }
    const expressActions = classifyProbedUrl(
      'http://localhost:3000/',
      'html',
      state,
      undefined,
      null, // no role hint — content-type alone
    )
    expect(expressActions).toContainEqual({ type: 'assignFrontend', url: 'http://localhost:3000/' })
    expect(expressActions).toContainEqual({ type: 'assignBackend', url: 'http://localhost:3000/', mirrored: true })

    // Apply Express actions
    state = { ...state, frontendUrl: 'http://localhost:3000/', backendUrl: 'http://localhost:3000/', backendUrlMirrored: true }

    // Step 2: Vite probed second WITH role hint from [client] prefix
    const viteActions = classifyProbedUrl(
      'http://localhost:5173/',
      'html',
      state,
      undefined,
      'frontend', // [client] prefix
    )
    // The hint MUST overwrite the wrong frontendUrl assignment
    expect(viteActions).toContainEqual({ type: 'assignFrontend', url: 'http://localhost:5173/' })
  })

  it('promotes :3000 to backendUrl when [server] hint arrives, replacing wrong-mirror state', () => {
    // Step 1: Vite first wins frontendUrl (correctly)
    let state: ClassifySlotState = {
      projectKind: 'fullstack',
      frontendUrl: 'http://localhost:5173/',
      backendUrl: 'http://localhost:5173/', // mirrored
      backendUrlMirrored: true,
    }
    // Step 2: Express probed with [server] hint, content-type HTML
    const actions = classifyProbedUrl(
      'http://localhost:3000/',
      'html',
      state,
      undefined,
      'backend',
    )
    expect(actions).toContainEqual({ type: 'assignBackend', url: 'http://localhost:3000/', mirrored: false })
  })

  it('without line hint, falls through to existing content-type behaviour', () => {
    const actions = classifyProbedUrl(
      'http://localhost:5173/',
      'html',
      fullstackEmpty,
      undefined,
      null,
    )
    expect(actions).toContainEqual({ type: 'assignFrontend', url: 'http://localhost:5173/' })
    // Monolithic mirror still happens for HTML on a fresh fullstack slot.
    expect(actions).toContainEqual({ type: 'assignBackend', url: 'http://localhost:5173/', mirrored: true })
  })

  it('frontend project kind: line hint is irrelevant (first URL wins, no fullstack logic)', () => {
    const slot: ClassifySlotState = {
      projectKind: 'frontend',
      frontendUrl: null,
      backendUrl: null,
      backendUrlMirrored: false,
    }
    const actions = classifyProbedUrl('http://localhost:5173/', 'html', slot, undefined, 'backend')
    expect(actions).toContainEqual({ type: 'assignFrontend', url: 'http://localhost:5173/' })
  })
})


// ── Escolha do script de arranque ────────────────────────────────────────────
//
// O defeito que isto fecha: a detecção só reconhecia `dev` e `start` EXACTOS.
// Um projecto com `dev:web` (ou `dev:client`, `dev:all`…) aparecia como "sem
// comando de dev", e a mensagem pedia para adicionar um script `dev` que já lá
// estava com outro nome — o botão desligado e a instrução errada ao mesmo tempo.
describe('pickDevScript', () => {
  it('`dev` exacto ganha a tudo o resto', () => {
    expect(pickDevScript({ 'dev:all': 'x', dev: 'vite', 'dev:web': 'y' })).toBe('dev')
  })

  it('`start` exacto vem a seguir ao `dev`', () => {
    expect(pickDevScript({ start: 'node .', 'dev:web': 'vite' })).toBe('start')
  })

  it('sem `dev`/`start`, escolhe a variante que corre TUDO', () => {
    expect(pickDevScript({ 'dev:api': 'x', 'dev:web': 'y', 'dev:all': 'z' })).toBe('dev:all')
    expect(pickDevScript({ 'dev:api': 'x', 'dev:fullstack': 'z' })).toBe('dev:fullstack')
  })

  it('senão, a variante de FRONTEND — é o que o preview mostra', () => {
    expect(pickDevScript({ 'dev:api': 'x', 'dev:web': 'y' })).toBe('dev:web')
    expect(pickDevScript({ 'dev:server': 'x', 'dev:client': 'y' })).toBe('dev:client')
    expect(pickDevScript({ 'dev:worker': 'x', 'dev:ui': 'y' })).toBe('dev:ui')
  })

  it('uma variante desconhecida ganha a uma de backend', () => {
    // `dev:playground` não diz nada sobre backend; `dev:api` diz. Entre as
    // duas, a ambígua tem mais hipóteses de servir uma página.
    expect(pickDevScript({ 'dev:api': 'x', 'dev:playground': 'y' })).toBe('dev:playground')
  })

  it('só backend? arranca-o à mesma — melhor que dizer "não tens dev"', () => {
    // Quem carregou no botão quer que ALGUMA coisa arranque. O classificador
    // do devServerManager trata de o marcar como backend pelo content-type.
    expect(pickDevScript({ 'dev:api': 'nodemon' })).toBe('dev:api')
  })

  it('dentro do mesmo grupo vale a ordem do package.json (a que o autor escreveu)', () => {
    expect(pickDevScript({ 'dev:site': 'a', 'dev:app': 'b' })).toBe('dev:site')
    expect(pickDevScript({ 'dev:app': 'b', 'dev:site': 'a' })).toBe('dev:app')
  })

  it('ignora scripts vazios, não-strings e ausência de scripts', () => {
    expect(pickDevScript({ dev: '' })).toBeNull()
    expect(pickDevScript({ dev: 123 })).toBeNull()
    expect(pickDevScript({})).toBeNull()
    expect(pickDevScript(null)).toBeNull()
    expect(pickDevScript(undefined)).toBeNull()
    expect(pickDevScript({ build: 'tsc', lint: 'eslint .' })).toBeNull()
  })
})

// A variante escolhida atravessa DOIS sítios que assumem a forma do comando.
// Se algum deles tropeçar no `:`, o preview arranca mas fica sem `--host`
// (Chat) ou sem `--port` (Live Preview), e o sintoma é uma página em branco —
// longe da causa.
describe('um comando com script `dev:*` sobrevive ao resto do pipeline', () => {
  it('extractScriptName lê o nome com dois-pontos (segue a indirecção de wrappers)', () => {
    expect(extractScriptName('npm run dev:web')).toBe('dev:web')
    expect(extractScriptName('pnpm run dev:all')).toBe('dev:all')
  })

  it('appendDevFlags injecta as flags depois do separador', () => {
    expect(appendDevFlags('npm run dev:web', '--host')).toBe('npm run dev:web -- --host')
    expect(appendDevFlags('npm run dev:client', '--port 7773')).toBe('npm run dev:client -- --port 7773')
  })
})
