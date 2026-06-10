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
 * Production Worker URL — ALWAYS used for the deploy pipeline, even in
 * dev mode. Reason: wrangler dev (localhost:8787) emulates R2/D1 locally,
 * so a Publish from a dev-mode IDE would write to ~/.wrangler/state/
 * and the served <slug>.toquemedia.net would 404 against real R2.
 *
 * Override via VITE_DEPLOY_URL only for staging the deploy pipeline
 * itself (e.g. a parallel preview Worker).
 */
export const PRODUCTION_DEPLOY_URL = 'https://api-agents.toquemedia.net'

/** Optional override for deploys (staging the pipeline). Undefined → use PRODUCTION_DEPLOY_URL. */
export const VITE_DEPLOY_URL: string | undefined = import.meta.env.VITE_DEPLOY_URL as string | undefined

/** User-provided Ollama URL override (Vite env); undefined in Jest. */
export const VITE_OLLAMA_URL: string | undefined = import.meta.env.VITE_OLLAMA_URL as string | undefined

/** User-provided Worker URL override (Vite env); undefined in Jest. */
export const VITE_WORKER_URL: string | undefined = import.meta.env.VITE_WORKER_URL as string | undefined

/** User-provided AI data-plane Worker URL override (Vite env); undefined in Jest. */
export const VITE_AI_WORKER_URL: string | undefined = import.meta.env.VITE_AI_WORKER_URL as string | undefined

/** Whether the app is running under a Vite dev server (false in tests, prod build, SSR). */
export const IS_VITE_DEV: boolean = import.meta.env.DEV === true
