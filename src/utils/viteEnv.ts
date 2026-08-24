/**
 * Jest-safe accessors for Vite's `import.meta.env`.
 *
 * Rationale: ts-jest with the default CJS transform cannot parse `import.meta`
 * expressions — any file that references them blows up the suite at load time
 * (see the "SyntaxError: Cannot use 'import.meta' outside a module" error that
 * previously prevented chatStore.test.ts from running, which in turn blocked
 * stateful tests for everything that transitively imports settingsStore).
 *
 * By funneling Vite env reads through this single module we can mock it in
 * tests via `jest.mock('../../utils/viteEnv')` or the __mocks__ convention —
 * see src/utils/__mocks__/viteEnv.ts. In production, Vite replaces the reads
 * statically at build time; the module export carries the resolved value.
 */

/** Default Ollama endpoint when no override is set (dev, prod, or test). */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

/** Default Worker endpoint when no override is set. */
export const DEFAULT_WORKER_URL = 'http://localhost:8787'

/** Default AI data-plane Worker endpoint when no override is set. */
export const DEFAULT_AI_WORKER_URL = 'http://localhost:8788'

/**
 * Production control-plane Worker URL. Used as the production fallback by
 * `resolveWorkerUrl()` when no (valid) VITE_WORKER_URL override is present.
 * (The name predates the dev-only pivot — the managed Publish/deploy
 * pipeline is gone; this is simply the control-plane endpoint.)
 */
export const PRODUCTION_DEPLOY_URL = 'https://api-agents.toquemedia.net'

export const PRODUCTION_AI_WORKER_URL = 'https://ai-pass-through-worker.geral-871.workers.dev'

/** Default collab signaling Worker (WebSocket) endpoint when no override is set. */
export const DEFAULT_COLLAB_SIGNALING_URL = 'ws://localhost:8789'

/** Production collab signaling Worker (WebSocket) endpoint. */
export const PRODUCTION_COLLAB_SIGNALING_URL = 'wss://collab-signaling-worker.geral-871.workers.dev'

/** User-provided Ollama URL override (Vite env); undefined in Jest. */
export const VITE_OLLAMA_URL: string | undefined = import.meta.env.VITE_OLLAMA_URL as string | undefined

/** User-provided Worker URL override (Vite env); undefined in Jest. */
export const VITE_WORKER_URL: string | undefined = import.meta.env.VITE_WORKER_URL as string | undefined

/**
 * Limiar de auto-compactação em PERCENTAGEM da janela efectiva, só para
 * TESTAR a compactação. Porte de `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
 * (cli-vaz, services/compact/autoCompact.ts:79) — existe lá exactamente pela
 * mesma razão: sem ele, exercitar a compactação obriga a encher uma janela
 * inteira, e a única forma de a ver era uma sessão real de horas.
 *
 * Só ENCURTA: o valor efectivo é `min(percentagem, limiar normal)`, portanto
 * um override mal posto nunca deixa a compactação disparar mais tarde do que
 * devia. Aceite em (0, 100]; ignorado fora disso.
 */
export const VITE_AUTOCOMPACT_PCT: string | undefined = import.meta.env.VITE_AUTOCOMPACT_PCT as string | undefined

/**
 * Braço da experiência do orçamento de tool results: `always` (defeito, o que
 * está em produção), `trigger` (só perto do limiar de compactação) ou `off`
 * (nunca — o modelo do cli-vaz).
 *
 * Existe para os três braços se medirem sem editar código entre corridas: a
 * comparação exige n ≥ 10 por braço, e um `git checkout` por corrida era o
 * caminho mais curto para medir árvores diferentes sem dar por isso. Valor
 * desconhecido cai em `always`. Ver toolResultGlobalBudget.ts.
 */
export const VITE_TOOL_RESULT_BUDGET_MODE: string | undefined = import.meta.env.VITE_TOOL_RESULT_BUDGET_MODE as string | undefined

/** Fracção do limiar de compactação (em %) a que o modo `trigger` acorda. */
export const VITE_TOOL_RESULT_BUDGET_TRIGGER_PCT: string | undefined = import.meta.env.VITE_TOOL_RESULT_BUDGET_TRIGGER_PCT as string | undefined

/**
 * Persona a fixar no arranque do RUNNER HEADLESS (`standard`/`expert`/`master`).
 *
 * Só é lida pelo runner — a app interactiva continua a mandar na escolha do
 * utilizador (localStorage `tm_model_persona`). Existe porque a persona decide
 * o MODELO servido, e uma medição de contexto que não diga com que modelo foi
 * feita não é comparável com outra: a compactação é escrita pelo modelo do loop
 * principal, portanto "compactar é mais destrutivo que aparar" é uma afirmação
 * sobre AQUELE sumarizador, não uma lei.
 */
export const VITE_EVAL_PERSONA: string | undefined = import.meta.env.VITE_EVAL_PERSONA as string | undefined

/** User-provided AI data-plane Worker URL override (Vite env); undefined in Jest. */
export const VITE_AI_WORKER_URL: string | undefined = import.meta.env.VITE_AI_WORKER_URL as string | undefined

/** User-provided collab signaling Worker URL override (Vite env); undefined in Jest. */
export const VITE_COLLAB_SIGNALING_URL: string | undefined = import.meta.env.VITE_COLLAB_SIGNALING_URL as string | undefined

/** Whether the app is running under a Vite dev server (false in tests, prod build, SSR). */
export const IS_VITE_DEV: boolean = import.meta.env.DEV === true

/**
 * GitHub OAuth App client_id for the device-flow "Sign in with GitHub" used to
 * clone private repos. This is a PUBLIC value (device flow needs no client
 * secret), so it is safe to ship in the bundle. Undefined in Jest and until an
 * OAuth App is registered — when unset, the clone dialog still works for public
 * repos and surfaces a "GitHub sign-in not configured" hint for private ones.
 */
export const VITE_GITHUB_CLIENT_ID: string | undefined = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined
